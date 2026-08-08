import { describe, expect, it, vi } from 'vitest';
import { FeishuGateway, formatDesktopTurn, parseDocumentUrl, parseNewCommand } from './feishu.js';
import type { EvaluationDraft } from './evaluation/batch-service.js';

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

describe('评估草稿路由', () => {
  it('优先回复到行动来源 Session 话题', async () => {
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'message-1' } }));
    const gateway = new FeishuGateway({} as any) as any;
    gateway.client = { im: { message: { reply } } };
    gateway.projectGroups = new Map([['/projects/site', { projectPath: '/projects/site', projectName: 'Site', chatId: 'chat-1' }]]);
    gateway.sessionTopics = new Map([['session-1', { sessionId: 'session-1', chatId: 'chat-1', threadId: 'thread-1', rootMessageId: 'root-1' }]]);
    const draft: EvaluationDraft = {
      batch: { id: 'batch-1', projectId: 'project-1', candidateIds: ['candidate-1'], summary: 'SEO', effectiveAt: '2026-08-08T00:00:00.000Z', draftStatus: 'draft_pending', createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z' },
      deployment: { id: 'deployment-1', batchId: 'batch-1', provider: 'codex', productionUrl: 'https://example.com', verifiedAt: '2026-08-08T00:00:00.000Z', effectiveAt: '2026-08-08T00:00:00.000Z', evidence: {} },
      candidate: { id: 'candidate-1', projectId: 'project-1', sourceSessionIds: ['session-1'], firstDetectedAt: '2026-08-08T00:00:00.000Z', lastUpdatedAt: '2026-08-08T00:00:00.000Z', changedFiles: [], actionSummaries: ['修改 title'], suggestedTemplate: 'seo', affectedTargets: ['/'], confidence: 0.9, status: 'deployed', staleAt: '2026-09-08T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z' },
      actions: [{ actionType: 'seo_change', summary: '修改 title', affectedTargets: ['/'], requiresEvaluation: true, template: 'seo', confidence: 0.9, productionState: 'deployed', reason: '需要观察' }],
    };

    await expect(gateway.sendEvaluationDraft('/projects/site', 'session-1', draft)).resolves.toBe(true);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'root-1' } }));
  });

  it('把评估节点创建到统一任务清单并分配负责人', async () => {
    const createTask = vi.fn(async () => ({ code: 0, data: { task: { guid: 'task-1', url: 'https://example.test/task-1' } } }));
    const gateway = new FeishuGateway({} as any) as any;
    gateway.client = { task: { v2: { task: { create: createTask } } } };
    gateway.evaluationTasklistGuid = 'tasklist-1';
    const previous = process.env.EVALUATION_DEFAULT_ASSIGNEE_OPEN_ID;
    process.env.EVALUATION_DEFAULT_ASSIGNEE_OPEN_ID = 'ou_owner';
    try {
      const nodes = await gateway.createEvaluationTasks({
        projectName: 'classgames.net',
        template: 'seo',
        batch: { id: 'batch-1', projectId: 'project-1', candidateIds: ['candidate-1'], summary: '修改 title', effectiveAt: '2026-08-08T00:00:00.000Z', draftStatus: 'confirmed', createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z' },
        nodes: [{ id: 'node-1', planId: 'plan-1', purpose: '检查抓取与索引', dueAt: '2026-08-15T00:00:00.000Z', status: 'scheduled', reminderStage: 0, createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z' }],
      });
      expect(nodes[0]).toMatchObject({ feishuTaskGuid: 'task-1', feishuTaskUrl: 'https://example.test/task-1' });
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        client_token: 'node-1',
        members: [{ id: 'ou_owner', type: 'user', role: 'assignee' }],
        tasklists: [{ tasklist_guid: 'tasklist-1' }],
      }) }));
    } finally {
      if (previous === undefined) delete process.env.EVALUATION_DEFAULT_ASSIGNEE_OPEN_ID;
      else process.env.EVALUATION_DEFAULT_ASSIGNEE_OPEN_ID = previous;
    }
  });
});
