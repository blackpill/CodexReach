import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import type { CodexClient } from './codex-client.js';
import { groupProjects, type Project } from './types.js';

type Card = { config: Record<string, unknown>; header: Record<string, unknown>; elements: Array<Record<string, unknown>> };
type Reply = string | Card;

export class FeishuGateway {
  private selected = new Map<string, string>();
  private targets = new Map<string, { chatId: string; openId: string }>();
  private handledMessages: string[] = [];
  private projectsCache?: { at: number; projects: Project[] };
  private readonly stateFile = path.resolve('.data/feishu-state.json');
  constructor(private codex: CodexClient) { this.loadState(); }

  start() {
    const appId = process.env.FEISHU_APP_ID, appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return false;
    const allowed = new Set((process.env.FEISHU_ALLOWED_OPEN_IDS ?? '').split(',').filter(Boolean));
    const client = new lark.Client({ appId, appSecret });
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (event: any) => {
        const openId = event.sender?.sender_id?.open_id ?? '';
        if (allowed.size && !allowed.has(openId)) return;
        if (event.message?.message_type !== 'text') return;
        const messageId = event.message.message_id ?? '';
        if (messageId && this.handledMessages.includes(messageId)) return;
        if (messageId) {
          this.handledMessages.push(messageId);
          this.handledMessages = this.handledMessages.slice(-200);
          this.saveState();
        }
        const chatId = event.message.chat_id;
        const text = JSON.parse(event.message.content).text?.trim() ?? '';
        const selectedBeforeSend = this.selected.get(openId);
        if (selectedBeforeSend && !text.startsWith('/')) {
          this.targets.set(selectedBeforeSend, { chatId, openId });
          this.saveState();
        }
        const reply = await this.handle(openId, text).catch((error) => `执行失败：${error.message}`);
        const selectedId = this.selected.get(openId);
        if (selectedId && (!text.startsWith('/') || text.startsWith('/new'))) {
          this.targets.set(selectedId, { chatId, openId });
          this.saveState();
        }
        await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
          receive_id: chatId,
          msg_type: typeof reply === 'string' ? 'text' : 'interactive',
          content: JSON.stringify(typeof reply === 'string' ? { text: reply } : reply),
        }});
      },
      'card.action.trigger': async (event: any) => {
        const openId = event.operator?.open_id ?? event.open_id ?? '';
        if (allowed.size && !allowed.has(openId)) return;
        const value = event.action?.value ?? {};
        const projects = await this.getProjects();
        if (value.action === 'projects_page') return cardResponse(projectCard(projects, Number(value.page) || 0));
        if (value.action === 'project_sessions') {
          const project = projects.find((item) => item.path === value.projectPath);
          return project ? cardResponse(sessionCard(project, Number(value.page) || 0)) : toastResponse('项目不存在或已移动', 'error');
        }
        if (value.action === 'sessions_page') {
          const project = projects.find((item) => item.path === value.projectPath);
          return project ? cardResponse(sessionCard(project, Number(value.page) || 0)) : toastResponse('项目不存在或已移动', 'error');
        }
        if (value.action === 'use_session') {
          await this.codex.resumeThread(value.sessionId);
          this.selected.set(openId, value.sessionId);
          this.saveState();
          return toastResponse(`已选择 Session：${value.sessionId}`, 'success');
        }
      },
    });
    this.codex.on('notification', async (notification: any) => {
      if (notification.method !== 'turn/completed') return;
      const threadId = notification.params?.threadId ?? notification.params?.thread?.id;
      const target = threadId ? this.targets.get(threadId) : undefined;
      if (!target) return;
      try {
        const turn = notification.params?.turn;
        const summary = turn ? formatTurnStatus(threadId, turn) : formatStatus(await this.codex.readThread(threadId));
        const needsHuman = /真人|验证|captcha|security verification|手动完成/i.test(summary);
        await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
          receive_id: target.chatId, msg_type: 'text', content: JSON.stringify({ text: `${needsHuman ? '⚠️ 需要人工处理' : '任务状态更新'}\n\n${summary}` }),
        }});
      } catch (error) { console.error('[feishu-notify]', error); }
    });
    const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.info });
    void ws.start({ eventDispatcher: dispatcher });
    return true;
  }

  async handle(user: string, input: string): Promise<Reply> {
    const [command, ...rest] = input.split(/\s+/);
    if (command === '/projects') {
      const projects = await this.getProjects(true);
      return projects.length ? projectCard(projects, 0) : '暂无项目';
    }
    if (command === '/sessions') {
      const projects = await this.getProjects();
      const threads = projects.flatMap((project) => project.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
      const selector = rest.join(' ').trim();
      if (selector) {
        const index = Number(selector);
        const project = Number.isInteger(index) && index > 0
          ? projects[index - 1]
          : projects.find((p) => p.path === selector)
            ?? projects.find((p) => p.name.toLowerCase() === selector.toLowerCase());
        if (!project) return '未找到项目。请先发送 /projects，再使用 /sessions <项目编号>。';
        return `项目：${project.name}\n${project.path}\n\n${formatSessions(project.sessions)}`;
      }
      return threads.slice(0, 20).map((t, i) => `${i + 1}. ${t.name || t.preview || '未命名'}\n项目：${t.cwd}\n/use ${t.id}`).join('\n\n') || '暂无会话';
    }
    if (command === '/use') { const id = rest[0]; if (!id) return '用法：/use <session-id>'; await this.codex.resumeThread(id); this.selected.set(user, id); this.saveState(); return `已选择 Session：${id}`; }
    if (command === '/status' || command === '/result') {
      const id = rest[0] ?? this.selected.get(user);
      if (!id) return '请先用 /use 选择 Session，或发送 /status <session-id>。';
      return formatStatus(await this.codex.readThread(id));
    }
    if (command === '/new') {
      const raw = input.slice('/new'.length).trim();
      const quoted = raw.match(/^"([^"]+)"\s+(.+)$/s);
      const [cwd, prompt] = quoted ? [quoted[1], quoted[2]] : [rest[0], rest.slice(1).join(' ')];
      if (!cwd || !prompt) return '用法：/new <绝对路径> <任务>；路径含空格时请使用双引号。';
      const thread = await this.codex.create(cwd, prompt);
      this.selected.set(user, thread.id); this.saveState();
      return `已创建并开始执行：${thread.id}`;
    }
    if (command === '/stop') {
      const id = this.selected.get(user); if (!id) return '请先用 /use 选择 Session';
      const thread = await this.codex.readThread(id); const turn = [...thread.turns].reverse().find((t) => t.status === 'inProgress');
      if (!turn) return '当前没有运行中的任务'; await this.codex.interrupt(id, turn.id); return '已发送停止指令';
    }
    if (command === '/help') return '/projects：显示项目卡片，点击即可查看 Sessions\n/sessions：最近会话（显示所属项目）\n/sessions <项目名称|绝对路径>：查看指定项目的会话\n/use <session-id>\n/status：查看当前任务状态和最新回复\n/status <session-id>：查看指定任务\n/new <绝对路径> <任务>\n/stop\n选择 Session 后直接发送文字即可继续。';
    const id = this.selected.get(user); if (!id) return '请先发送 /sessions，再用 /use <session-id> 选择会话。';
    await this.codex.send(id, input); return `任务已提交，状态：执行中\nSession：${id}\n\n完成后会自动通知；也可发送 /status 主动查询。`;
  }

  private async getProjects(refresh = false) {
    if (!refresh && this.projectsCache && Date.now() - this.projectsCache.at < 30_000) return this.projectsCache.projects;
    const projects = groupProjects(await this.codex.listThreads());
    this.projectsCache = { at: Date.now(), projects };
    return projects;
  }

  private loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.selected = new Map(data.selected ?? []);
      this.targets = new Map(data.targets ?? []);
      this.handledMessages = data.handledMessages ?? [];
    } catch { /* 首次启动 */ }
  }

  private saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify({ selected: [...this.selected], targets: [...this.targets], handledMessages: this.handledMessages }));
  }
}

function formatSessions(threads: Awaited<ReturnType<CodexClient['listThreads']>>): string {
  return threads.slice(0, 20).map((t, i) => `${i + 1}. ${t.name || t.preview || '未命名'}\n/use ${t.id}`).join('\n\n') || '暂无会话';
}

function formatStatus(thread: Awaited<ReturnType<CodexClient['readThread']>>): string {
  const turn = thread.turns.at(-1);
  if (!turn) return `Session：${thread.id}\n状态：暂无任务记录`;
  return formatTurnStatus(thread.id, turn);
}

function formatTurnStatus(threadId: string, turn: Awaited<ReturnType<CodexClient['readThread']>>['turns'][number]): string {
  const labels: Record<string, string> = { inProgress: '执行中', completed: '已结束', failed: '执行失败', interrupted: '已停止' };
  const agentMessage = [...turn.items].reverse().find((item: any) => item.type === 'agentMessage') as any;
  const activeTool = [...turn.items].reverse().find((item: any) => /ToolCall$/.test(item.type) && item.status === 'inProgress') as any;
  const detail = agentMessage?.text ?? (activeTool ? `正在执行：${activeTool.tool ?? activeTool.type}` : '暂时还没有新的文字回复');
  return `Session：${threadId}\n状态：${labels[turn.status] ?? turn.status}\n\n${String(detail).slice(0, 3500)}`;
}

const PAGE_SIZE = 10;

function projectCard(projects: Project[], page: number): Card {
  const pages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const elements: Array<Record<string, unknown>> = projects.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((project) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${project.name}**（${project.sessions.length} 个 Session）\n${project.path}` },
    extra: { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看 Sessions' }, value: { action: 'project_sessions', projectPath: project.path } },
  }));
  elements.push(navigation('projects_page', current, pages));
  return card(`项目（${current + 1}/${pages}）`, elements);
}

function sessionCard(project: Project, page: number): Card {
  const pages = Math.max(1, Math.ceil(project.sessions.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const elements: Array<Record<string, unknown>> = project.sessions.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((session) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${session.name || session.preview || '未命名'}**\n${session.id}` },
    extra: { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '选择' }, value: { action: 'use_session', sessionId: session.id } },
  }));
  elements.push(navigation('sessions_page', current, pages, project.path));
  elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '← 返回项目' }, value: { action: 'projects_page', page: 0 } }] });
  return card(`${project.name} · Sessions（${current + 1}/${pages}）`, elements);
}

function navigation(action: string, page: number, pages: number, projectPath?: string): Record<string, unknown> {
  const actions: Array<Record<string, unknown>> = [];
  if (page > 0) actions.push({ tag: 'button', text: { tag: 'plain_text', content: '上一页' }, value: { action, page: page - 1, projectPath } });
  if (page + 1 < pages) actions.push({ tag: 'button', text: { tag: 'plain_text', content: '下一页' }, value: { action, page: page + 1, projectPath } });
  return actions.length ? { tag: 'action', actions } : { tag: 'note', elements: [{ tag: 'plain_text', content: '已显示全部' }] };
}

function card(title: string, elements: Array<Record<string, unknown>>): Card {
  return { config: { wide_screen_mode: true, update_multi: false }, header: { template: 'blue', title: { tag: 'plain_text', content: title } }, elements };
}

function cardResponse(data: Card) {
  return { toast: { type: 'success', content: '已更新' }, card: { type: 'raw', data } };
}

function toastResponse(content: string, type: 'success' | 'error' = 'success') {
  return { toast: { type, content } };
}
