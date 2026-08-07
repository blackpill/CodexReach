import * as lark from '@larksuiteoapi/node-sdk';
import type { CodexClient } from './codex-client.js';
import { groupProjects } from './types.js';

export class FeishuGateway {
  private selected = new Map<string, string>();
  constructor(private codex: CodexClient) {}

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
        const chatId = event.message.chat_id;
        const text = JSON.parse(event.message.content).text?.trim() ?? '';
        const reply = await this.handle(openId, text).catch((error) => `执行失败：${error.message}`);
        await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
          receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: reply }),
        }});
      },
    });
    const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.info });
    void ws.start({ eventDispatcher: dispatcher });
    return true;
  }

  async handle(user: string, input: string): Promise<string> {
    const [command, ...rest] = input.split(/\s+/);
    if (command === '/projects') {
      const projects = groupProjects(await this.codex.listThreads());
      return projects.map((p, i) => `${i + 1}. ${p.name}（${p.sessions.length} 个会话）\n${p.path}`).join('\n\n') || '暂无项目';
    }
    if (command === '/sessions') {
      const threads = await this.codex.listThreads();
      return threads.slice(0, 20).map((t, i) => `${i + 1}. ${t.name || t.preview || '未命名'}\n/use ${t.id}`).join('\n\n') || '暂无会话';
    }
    if (command === '/use') { const id = rest[0]; if (!id) return '用法：/use <session-id>'; await this.codex.readThread(id); this.selected.set(user, id); return `已选择 Session：${id}`; }
    if (command === '/new') { const [cwd, ...prompt] = rest; if (!cwd || !prompt.length) return '用法：/new <绝对路径> <任务>'; const thread = await this.codex.create(cwd, prompt.join(' ')); this.selected.set(user, thread.id); return `已创建并开始执行：${thread.id}`; }
    if (command === '/stop') {
      const id = this.selected.get(user); if (!id) return '请先用 /use 选择 Session';
      const thread = await this.codex.readThread(id); const turn = [...thread.turns].reverse().find((t) => t.status === 'inProgress');
      if (!turn) return '当前没有运行中的任务'; await this.codex.interrupt(id, turn.id); return '已发送停止指令';
    }
    if (command === '/help') return '/projects\n/sessions\n/use <session-id>\n/new <绝对路径> <任务>\n/stop\n选择 Session 后直接发送文字即可继续。';
    const id = this.selected.get(user); if (!id) return '请先发送 /sessions，再用 /use <session-id> 选择会话。';
    await this.codex.send(id, input); return '任务已提交。可在手机控制台或 Codex Desktop 查看实时进展。';
  }
}
