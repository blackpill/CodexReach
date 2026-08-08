import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import type { CodexClient } from './codex-client.js';
import { groupProjects, type Project } from './types.js';

type Card = { config: Record<string, unknown>; header: Record<string, unknown>; elements: Array<Record<string, unknown>> };
type Reply = string | Card;
type ProjectGroup = { projectPath: string; projectName: string; chatId: string; shareLink?: string };
type SessionTopic = { sessionId: string; chatId: string; threadId: string; rootMessageId: string };
type Target = { chatId: string; openId: string; rootMessageId?: string };

const CODEX_REACH_LABEL = 'CodexReach';

function projectGroupName(projectName: string) {
  // 自建应用通常没有企业级群 Label 管理权限，因此用稳定前缀作为可见标签。
  return `${CODEX_REACH_LABEL}｜${projectName}`.slice(0, 60);
}

export class FeishuGateway {
  private selected = new Map<string, string>();
  private targets = new Map<string, Target>();
  private projectGroups = new Map<string, ProjectGroup>();
  private sessionTopics = new Map<string, SessionTopic>();
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
        // 部分飞书消息事件不返回 thread_id，但话题回复一定带稳定的 root_id。
        const rawThreadId = event.message.thread_id ?? '';
        const threadId = rawThreadId || event.message.root_id || '';
        const rootMessageId = event.message.root_id || event.message.message_id;
        const text = JSON.parse(event.message.content).text?.trim() ?? '';

        // Project 群中的一个飞书话题严格对应一个 Codex Session。
        const projectGroup = [...this.projectGroups.values()].find((group) => group.chatId === chatId);
        if (projectGroup && threadId) {
          try {
            let topic = [...this.sessionTopics.values()].find((item) => item.chatId === chatId && (
              (rawThreadId && item.threadId === rawThreadId)
              || item.rootMessageId === rootMessageId
            ));
            console.info('[feishu-route]', { chatId, rawThreadId, rootMessageId, matchedSessionId: topic?.sessionId ?? null });
            if (!topic) {
              const created = await this.codex.create(projectGroup.projectPath, text);
              topic = { sessionId: created.id, chatId, threadId, rootMessageId };
              this.sessionTopics.set(created.id, topic);
              this.targets.set(created.id, { chatId, openId, rootMessageId });
              this.saveState();
              await client.im.message.reply({ path: { message_id: rootMessageId }, data: {
                msg_type: 'text', content: JSON.stringify({ text: `Codex Session 已创建：${created.id}\n此话题内的消息只会进入该 Session。` }),
              }});
              return;
            }
            this.targets.set(topic.sessionId, { chatId, openId, rootMessageId: topic.rootMessageId });
            this.saveState();
            await this.codex.send(topic.sessionId, text);
            await client.im.message.reply({ path: { message_id: rootMessageId }, data: {
              msg_type: 'text', content: JSON.stringify({ text: `已提交到 Session：${topic.sessionId}` }),
            }});
          } catch (error) {
            console.error('[feishu-submit]', error);
            const detail = formatCodexSubmitError(error);
            try {
              await client.im.message.reply({ path: { message_id: rootMessageId }, data: {
                msg_type: 'text', content: JSON.stringify({ text: `❌ 未能发送给 Codex\n\n${detail}` }),
              }});
            } catch (replyError) {
              console.error('[feishu-submit-reply]', replyError);
            }
          }
          return;
        }
        // 话题消息绝不能回退到用户最近选择的 Session，否则会造成跨话题串线。
        if (threadId && !projectGroup) {
          await client.im.message.reply({ path: { message_id: rootMessageId }, data: {
            msg_type: 'text', content: JSON.stringify({ text: '此群尚未绑定 Codex Project，因此没有发送到任何 Session。\n请先在 Bot 单聊中执行 /sync-projects，并从返回的 CodexReach 项目群进入对应话题。' }),
          }});
          return;
        }
        const selectedBeforeSend = this.selected.get(openId);
        if (selectedBeforeSend && !text.startsWith('/')) {
          this.targets.set(selectedBeforeSend, { chatId, openId });
          this.saveState();
        }
        const reply = await this.handle(openId, text, client).catch((error) => `执行失败：${formatFeishuError(error)}`);
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
        const content = JSON.stringify({ text: `${needsHuman ? '⚠️ 需要人工处理' : '任务状态更新'}\n\n${summary}` });
        if (target.rootMessageId) {
          await client.im.message.reply({ path: { message_id: target.rootMessageId }, data: { msg_type: 'text', content } });
        } else {
          await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: target.chatId, msg_type: 'text', content } });
        }
      } catch (error) { console.error('[feishu-notify]', error); }
    });
    const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.info });
    void ws.start({ eventDispatcher: dispatcher });
    return true;
  }

  async handle(user: string, input: string, client?: lark.Client): Promise<Reply> {
    const [command, ...rest] = input.split(/\s+/);
    if (command === '/projects') {
      const projects = await this.getProjects(true);
      return projects.length ? projectCard(projects, 0) : '暂无项目';
    }
    if (command === '/sync-projects') {
      if (!client) return '飞书客户端尚未初始化';
      const projects = await this.getProjects(true);
      if (!projects.length) return '暂无可同步的 Project';
      const results: string[] = [];
      for (const project of projects) {
        const group = await this.ensureProjectGroup(client, project, user);
        let created = 0;
        for (const session of project.sessions) {
          if (!this.sessionTopics.has(session.id)) {
            await this.ensureSessionTopic(client, group, session.id, session.name || session.preview || '未命名 Session');
            created++;
          }
        }
        results.push(`• ${project.name}：${group.shareLink ? `[打开群聊](${group.shareLink})` : group.chatId}，新增 ${created} 个 Session 话题`);
      }
      this.saveState();
      return `已同步 ${projects.length} 个 CodexReach Project 群：\n\n${results.join('\n')}`;
    }
    if (command === '/sync-project') {
      if (!client) return '飞书客户端尚未初始化';
      const selector = rest.join(' ').trim();
      if (!selector) return '用法：/sync-project <项目名称|绝对路径|项目编号>\n可先发送 /projects 查看项目。';
      const projects = await this.getProjects(true);
      const index = Number(selector);
      const project = Number.isInteger(index) && index > 0
        ? projects[index - 1]
        : projects.find((item) => item.path === selector)
          ?? projects.find((item) => item.name.toLowerCase() === selector.toLowerCase());
      if (!project) return `未找到 Project：${selector}\n请先发送 /projects 查看准确名称。`;
      const group = await this.ensureProjectGroup(client, project, user);
      let created = 0;
      for (const session of project.sessions) {
        if (!this.sessionTopics.has(session.id)) {
          await this.ensureSessionTopic(client, group, session.id, session.name || session.preview || '未命名 Session');
          created++;
        }
      }
      this.saveState();
      return `已同步 Project：${project.name}\n群聊：${group.shareLink ? `[打开 CodexReach 群](${group.shareLink})` : group.chatId}\n新增 Session 话题：${created}`;
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
    if (command === '/help') return '/sync-project <项目名称|绝对路径|编号>：只同步一个 Project\n/sync-projects：同步全部 Project\n/projects：显示项目卡片\n/sessions：最近会话\n/use <session-id>\n/status [session-id]\n/new <绝对路径> <任务>\n/stop\n\n在 CodexReach Project 群中新建话题，即会自动创建独立 Codex Session；话题之间不会共享上下文。';
    const id = this.selected.get(user); if (!id) return '请先发送 /sessions，再用 /use <session-id> 选择会话。';
    await this.codex.send(id, input); return `任务已提交，状态：执行中\nSession：${id}\n\n完成后会自动通知；也可发送 /status 主动查询。`;
  }

  private async getProjects(refresh = false) {
    if (!refresh && this.projectsCache && Date.now() - this.projectsCache.at < 30_000) return this.projectsCache.projects;
    const projects = groupProjects(await this.codex.listThreads());
    this.projectsCache = { at: Date.now(), projects };
    return projects;
  }

  private async ensureProjectGroup(client: lark.Client, project: Project, ownerOpenId: string): Promise<ProjectGroup> {
    const existing = this.projectGroups.get(project.path);
    if (existing) {
      // 每次同步都校正名称、话题消息模式和 CodexReach 标签。
      const updated = await client.im.chat.update({ path: { chat_id: existing.chatId }, params: { user_id_type: 'open_id' }, data: {
        name: projectGroupName(project.name), description: `CodexReach Project\n${project.path}`, group_message_type: 'thread',
      }});
      if (updated.code) throw new Error(`更新群「${project.name}」失败：${updated.msg}`);
      return existing;
    }
    const created = await client.im.chat.create({ params: { user_id_type: 'open_id', set_bot_manager: true, uuid: `codexreach-${project.id}`.slice(0, 50) }, data: {
      name: projectGroupName(project.name),
      description: `CodexReach Project\n${project.path}`,
      owner_id: ownerOpenId,
      user_id_list: [ownerOpenId],
      group_message_type: 'thread',
      chat_mode: 'group',
      chat_type: 'private',
    }});
    if (created.code || !created.data?.chat_id) throw new Error(`创建群「${project.name}」失败：${created.msg ?? '未返回 chat_id'}`);
    const link = await client.im.chat.link({ path: { chat_id: created.data.chat_id }, data: { validity_period: 'permanently' } });
    const group = { projectPath: project.path, projectName: project.name, chatId: created.data.chat_id, shareLink: link.data?.share_link };
    this.projectGroups.set(project.path, group);
    return group;
  }

  private async ensureSessionTopic(client: lark.Client, group: ProjectGroup, sessionId: string, title: string): Promise<SessionTopic> {
    const existing = this.sessionTopics.get(sessionId);
    if (existing) return existing;
    const sent = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
      receive_id: group.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: `${title}\n\nCodex Session：${sessionId}` }),
      uuid: `codex-session-${sessionId}`.slice(0, 50),
    }});
    if (sent.code || !sent.data?.message_id || !sent.data.thread_id) throw new Error(`创建 Session 话题失败：${sent.msg ?? '未返回 thread_id'}`);
    const topic = { sessionId, chatId: group.chatId, threadId: sent.data.thread_id, rootMessageId: sent.data.message_id };
    this.sessionTopics.set(sessionId, topic);
    return topic;
  }

  private loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.selected = new Map(data.selected ?? []);
      this.targets = new Map(data.targets ?? []);
      this.projectGroups = new Map(data.projectGroups ?? []);
      this.sessionTopics = new Map(data.sessionTopics ?? []);
      this.handledMessages = data.handledMessages ?? [];
    } catch { /* 首次启动 */ }
  }

  private saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify({ selected: [...this.selected], targets: [...this.targets], projectGroups: [...this.projectGroups], sessionTopics: [...this.sessionTopics], handledMessages: this.handledMessages }, null, 2));
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

function formatFeishuError(error: unknown): string {
  const value = error as any;
  const candidates = [
    value?.response?.data,
    value?.response?.data?.data,
    ...(Array.isArray(value) ? value.flat(2) : []),
  ];
  const detail = candidates.find((item) => item && (item.msg || item.message || item.code));
  if (detail) return `${detail.msg || detail.message || '飞书接口调用失败'}${detail.code ? `（错误码 ${detail.code}）` : ''}`;
  return value?.message || String(error);
}

function formatCodexSubmitError(error: unknown): string {
  const detail = formatFeishuError(error);
  if (/already has an active writer/i.test(detail)) {
    return '该 Session 正被另一个 Codex 客户端占用，暂时无法写入。请关闭正在占用此 Session 的 Codex 任务后重试。';
  }
  return `错误详情：${detail}\n请稍后重试；若持续失败，请检查桥接服务日志。`;
}
