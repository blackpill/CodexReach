import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { CodexThread, RpcNotification } from './types.js';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;

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

  async send(threadId: string, text: string) {
    const params = {
      threadId, input: [{ type: 'text', text, text_elements: [] }],
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
