import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { CodexThread, RpcNotification } from './types.js';

export type CodexInput =
  | { type: 'text'; text: string; text_elements: Array<Record<string, unknown>> }
  | { type: 'mention'; name: string; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'localImage'; path: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'localAudio'; path: string };

export type ThreadGoal = {
  threadId: string; objective: string; status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number;
};

export type CodexSkill = { name: string; description?: string; path: string; enabled: boolean };
export type CodexApp = { id: string; name: string; description?: string | null; installUrl?: string | null; isAccessible: boolean; isEnabled: boolean; installed: boolean; callable: boolean };
export type CodexModel = { id: string; model: string; displayName: string; description?: string; isDefault: boolean; hidden: boolean };
export type SessionOptions = { model?: string; effort?: string; mode?: 'default' | 'plan' };

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;
  private issueSessionGuard?: (threadId:string)=>boolean;
  private sessionOptions = new Map<string, SessionOptions>();

  constructor(private readonly bin = process.env.CODEX_BIN || 'codex') { super(); }

  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async launch() {
    const child = spawn(this.bin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (data) => this.emit('log', data.toString()));
    child.on('exit', (code) => {
      this.child = undefined;
      for (const item of this.pending.values()) item.reject(new Error(`Codex App Server 已退出 (${code})`));
      this.pending.clear();
      this.emit('offline');
      if (!this.stopping) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => void this.start().catch((error) => this.emit('log', `Codex 重连失败：${error}`)), 2_000);
      }
    });
    await this.request('initialize', {
      clientInfo: { name: 'codexreach', title: 'CodexReach', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
    this.emit('online');
  }

  private onLine(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { return this.emit('log', line); }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      return message.error ? pending.reject(new Error(message.error.message ?? 'Codex 请求失败')) : pending.resolve(message.result);
    }
    if (message.method) this.emit('notification', message as RpcNotification);
  }

  async request(method: string, params?: unknown, timeout = 30_000): Promise<any> {
    if (!this.child && method !== 'initialize') await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params?: unknown) { this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`); }

  async listThreads(): Promise<CodexThread[]> {
    const all: CodexThread[] = []; let cursor: string | null = null;
    do {
      const result = await this.request('thread/list', { cursor, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', archived: false });
      all.push(...result.data); cursor = result.nextCursor;
    } while (cursor);
    return all;
  }

  async readThread(threadId: string): Promise<CodexThread> {
    return (await this.request('thread/read', { threadId, includeTurns: true })).thread;
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    return (await this.request('thread/resume', { threadId })).thread;
  }

  setIssueSessionGuard(guard?: (threadId:string)=>boolean) { this.issueSessionGuard = guard; }
  assertExternalControlAllowed(threadId:string) { if(this.issueSessionGuard?.(threadId)) throw new Error('该 Session 由 Issue 自动任务管理，请在其他 Session 操作；需要接管时先停止自动任务并核对进程。'); }
  async send(threadId: string, text: string) { this.assertExternalControlAllowed(threadId); return this.sendManaged(threadId,text); }
  async sendManaged(threadId: string, text: string) {
    const thread = await this.readThread(threadId);
    const input = await this.resolveInput(thread.cwd, text);
    const options = this.sessionOptions.get(threadId) ?? {};
    const modePrefix = options.mode === 'plan'
      ? '请先以规划模式处理：先使用 update_plan 制定计划，未得到进一步明确要求前不要修改文件。\n\n'
      : '';
    if (modePrefix) (input[0] as Extract<CodexInput, { type: 'text' }>).text = modePrefix + text;
    const params = {
      threadId, input,
      model: options.model ?? null,
      effort: options.effort ?? null,
      approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
      responsesapiClientMetadata: { source: 'codexreach' },
    };
    try {
      return await this.request('turn/start', params, 60_000);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('thread not found')) throw error;
      await this.resumeThread(threadId);
      return this.request('turn/start', params, 60_000);
    }
  }

  async resolveInput(cwd: string, text: string): Promise<CodexInput[]> {
    const input: CodexInput[] = [{ type: 'text', text, text_elements: [] }];
    const root = path.resolve(cwd);
    for (const match of text.matchAll(/本地路径：([^\n]+)/g)) {
      const localPath = match[1].trim();
      if (!fs.existsSync(localPath)) continue;
      if (/\.(png|jpe?g|webp|gif)$/i.test(localPath)) input.push({ type: 'localImage', path: localPath, detail: 'auto' });
      else if (/\.(mp3|wav|m4a|ogg|flac)$/i.test(localPath)) input.push({ type: 'localAudio', path: localPath });
      else input.push({ type: 'mention', name: path.basename(localPath), path: localPath });
    }
    const mentions = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s，。；;]+))/g)];
    for (const match of mentions) {
      const name = match[1] ?? match[2] ?? match[3];
      const resolved = path.resolve(root, name);
      if ((resolved === root || resolved.startsWith(`${root}${path.sep}`)) && fs.existsSync(resolved)) {
        input.push({ type: 'mention', name, path: resolved });
      }
    }
    const requestedSkills = [...text.matchAll(/(?:^|\s)\$([\p{L}\p{N}_.:-]+)/gu)].map((match) => match[1]);
    if (requestedSkills.length) {
      const skills = await this.listSkills(root);
      for (const requested of requestedSkills) {
        const skill = skills.find((item: any) => String(item.name).toLowerCase() === requested.toLowerCase() && item.enabled !== false);
        if (skill?.path) input.push({ type: 'skill', name: skill.name, path: String(skill.path) });
      }
    }
    return input;
  }

  async listSkills(cwd: string): Promise<CodexSkill[]> {
    const result = await this.request('skills/list', { cwds: [path.resolve(cwd)] });
    return (result.data ?? []).flatMap((entry: any) => entry.skills ?? entry.data ?? []);
  }

  async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = []; let cursor: string | null = null;
    do {
      const result = await this.request('model/list', { cursor, limit: 100, includeHidden: false });
      models.push(...(result.data ?? [])); cursor = result.nextCursor ?? null;
    } while (cursor);
    return models;
  }

  getSessionOptions(threadId: string) { return this.sessionOptions.get(threadId) ?? {}; }
  setSessionOptions(threadId: string, options: SessionOptions) {
    const next = { ...(this.sessionOptions.get(threadId) ?? {}), ...options };
    this.sessionOptions.set(threadId, next); return next;
  }

  async steer(threadId: string, text: string) {
    this.assertExternalControlAllowed(threadId);
    const thread = await this.readThread(threadId);
    const turn = [...thread.turns].reverse().find((item) => item.status === 'inProgress');
    if (!turn) throw new Error('当前没有可追加指令的运行中任务');
    return this.request('turn/steer', { threadId, expectedTurnId: turn.id, input: await this.resolveInput(thread.cwd, text) }, 60_000);
  }

  async listApps(threadId?: string, options: { query?: string; limit?: number } = {}): Promise<CodexApp[]> {
    try { return await this.listAppsSnapshot(threadId, options); }
    catch (error) {
      if (!threadId || !(error instanceof Error) || !error.message.includes('thread not found')) throw error;
      return this.listAppsSnapshot(undefined, options);
    }
  }

  private async listAppsSnapshot(threadId?: string, options: { query?: string; limit?: number } = {}): Promise<CodexApp[]> {
    const apps: any[] = []; let cursor: string | null = null;
    const query = options.query?.trim().toLowerCase() ?? '';
    do {
      const result = await this.request('app/list', { cursor, limit: 100, threadId });
      apps.push(...(result.data ?? []).filter((item: any) => !query
        || String(item.name ?? '').toLowerCase().includes(query)
        || String(item.description ?? '').toLowerCase().includes(query)));
      cursor = options.limit && apps.length >= options.limit ? null : result.nextCursor ?? null;
    } while (cursor);
    const installedResult = await this.request('app/installed', { threadId, forceRefresh: false });
    const installed = new Map((installedResult.apps ?? []).map((item: any) => [item.id, item]));
    return apps.slice(0, options.limit ?? apps.length).map((item) => {
      const runtime: any = installed.get(item.id);
      return { ...item, installed: Boolean(runtime), callable: Boolean(runtime?.callable) } as CodexApp;
    });
  }

  async getGoal(threadId: string): Promise<ThreadGoal | null> {
    return (await this.request('thread/goal/get', { threadId })).goal ?? null;
  }

  async setGoal(threadId: string, values: { objective?: string; status?: ThreadGoal['status']; tokenBudget?: number | null }): Promise<ThreadGoal> {
    return (await this.request('thread/goal/set', { threadId, ...values })).goal;
  }

  async clearGoal(threadId: string): Promise<boolean> {
    return Boolean((await this.request('thread/goal/clear', { threadId })).cleared);
  }

  isOnline() { return Boolean(this.child); }

  async health() {
    const startedAt = Date.now();
    try {
      await this.request('thread/list', { limit: 1, archived: false }, 5_000);
      return { online: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { online: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async prepareThread(cwd: string, text: string) {
    const started = await this.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      // Codex Desktop only surfaces top-level user threads in its task list.
      threadSource: 'user',
    });
    const name = text.replace(/\s+/g, ' ').trim().slice(0, 50) || '飞书新任务';
    await this.request('thread/name/set', { threadId: started.thread.id, name });
    return started.thread as CodexThread;
  }

  async create(cwd: string, text: string) {
    const thread = await this.prepareThread(cwd, text);
    const turn = await this.send(thread.id, text);
    return { ...thread, startedTurnId: turn?.turn?.id };
  }

  interrupt(threadId: string, turnId: string) { return this.request('turn/interrupt', { threadId, turnId }); }
}
