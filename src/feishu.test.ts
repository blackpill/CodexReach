import { describe, expect, it, vi } from 'vitest';
import { FeishuGateway, formatDesktopTurn, parseDocumentUrl, parseNewCommand } from './feishu.js';

describe('parseNewCommand', () => {
  const projectPath = '/Users/kenny/Documents/ChatGPT/Feishu AI Codex Bot';
  const isDirectory = (candidate: string) => candidate === projectPath;

  it('解析未加引号且包含空格的绝对路径', () => {
    expect(parseNewCommand(`${projectPath} 请只回复：测试成功`, isDirectory)).toEqual({
      cwd: projectPath,
      prompt: '请只回复：测试成功',
    });
  });

  it('继续支持使用引号包裹路径', () => {
    expect(parseNewCommand(`"${projectPath}" 执行测试`, isDirectory)).toEqual({
      cwd: projectPath,
      prompt: '执行测试',
    });
  });
});

describe('parseDocumentUrl', () => {
  it('解析新版 docx 链接并移除查询参数', () => {
    expect(parseDocumentUrl('https://example.feishu.cn/docx/AbC_123?from=comment')).toEqual({
      fileToken: 'AbC_123', fileType: 'docx', url: 'https://example.feishu.cn/docx/AbC_123',
    });
  });

  it('拒绝未支持的 wiki 链接', () => {
    expect(parseDocumentUrl('https://example.feishu.cn/wiki/AbC123')).toBeNull();
  });
});

describe('formatDesktopTurn', () => {
  it('格式化 Desktop 的用户消息与最终回复', () => {
    expect(formatDesktopTurn({ items: [
      { type: 'userMessage', content: [{ type: 'inputText', text: '检查项目' }] },
      { type: 'agentMessage', text: '检查完成。' },
    ] })).toContain('你：\n检查项目\n\nCodex：\n检查完成。');
  });
});

describe('Desktop Session 同步', () => {
  it('启动建立基线时不会自动创建历史 Session 话题', async () => {
    const codex = {
      listThreads: async () => [{ id: 'session-1', cwd: '/project', name: '历史任务', preview: '', turns: [] }],
      readThread: async () => ({ id: 'session-1', turns: [{ id: 'turn-1', status: 'completed', items: [] }] }),
    };
    const create = vi.fn();
    const gateway = new FeishuGateway(codex as any) as any;
    gateway.client = { im: { message: { create, reply: vi.fn() } } };
    gateway.projectGroups = new Map([['/project', { projectPath: '/project', projectName: 'Project', chatId: 'chat-1' }]]);
    gateway.sessionTopics = new Map();
    gateway.syncedTurns = new Map();

    await gateway.syncDesktopSessions(true);

    expect(create).not.toHaveBeenCalled();
    expect(gateway.syncedTurns.get('session-1')).toEqual(['turn-1']);
  });
});
