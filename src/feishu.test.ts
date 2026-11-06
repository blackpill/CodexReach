import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FeishuGateway, extractTurnImagePaths, formatDesktopTurn, formatDesktopTurnMessages, parseDocumentUrl, parseNewCommand, searchProjectFiles } from './feishu.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EvaluationDraft } from './evaluation/batch-service.js';

const isolatedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-feishu-tests-'));
beforeAll(() => { vi.stubEnv('CODEXREACH_STATE_DB', path.join(isolatedStateDir, 'state.sqlite')); vi.stubEnv('CODEXREACH_LEGACY_STATE_JSON', path.join(isolatedStateDir, 'missing.json')); });
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(isolatedStateDir, { recursive: true, force: true }); });

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

describe('searchProjectFiles', () => {
  it('按关键词搜索项目文件并忽略依赖目录', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-files-'));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'server.ts'), '');
    fs.writeFileSync(path.join(cwd, 'node_modules', 'server.js'), '');
    expect(searchProjectFiles(cwd, 'server')).toEqual(['src/server.ts']);
  });
});

describe('待发送上下文', () => {
  it('解析粘贴图片形成的富文本消息，并保留命令与本地图片路径', async () => {
    const writeFile = vi.fn(async (destination: string) => fs.writeFileSync(destination, 'png'));
    const gateway = new FeishuGateway({} as any) as any;
    const client = { im: { messageResource: { get: vi.fn(async () => ({ writeFile })) } } };
    const text = await gateway.parseIncomingMessage(client, {
      message_id: 'message-1', chat_id: 'chat-1',
      content: JSON.stringify({ title: '', content: [[
        { tag: 'text', text: '/new 请检查这个页面' },
        { tag: 'img', image_key: 'img-key-1' },
      ]] }),
    }, 'post');

    expect(text).toContain('/new 请检查这个页面');
    expect(text).toMatch(/本地路径：.*\.data\/media\/chat-1\/.*\.png/);
    expect(client.im.messageResource.get).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: 'message-1', file_key: 'img-key-1' }, params: { type: 'image' },
    }));
  });

  it('生成任务引用时不会提前删除，便于发送失败后重试', () => {
    const gateway = new FeishuGateway({} as any) as any;
    gateway.pendingReferences = new Map([['session-1:user-1', [{ type: 'file', value: 'docs/my file.md', selectedAt: Date.now() }]]]);
    expect(gateway.applyPendingReferences('session-1', 'user-1', '检查内容')).toBe('@"docs/my file.md"\n检查内容');
    expect(gateway.pendingReferences.get('session-1:user-1')).toHaveLength(1);
  });

  it('自动忽略超过 30 分钟的选择', () => {
    const gateway = new FeishuGateway({} as any) as any;
    gateway.pendingReferences = new Map([['session-1:user-1', [{ type: 'skill', value: 'audit', selectedAt: Date.now() - 31 * 60_000 }]]]);
    expect(gateway.applyPendingReferences('session-1', 'user-1', '检查内容')).toBe('检查内容');
  });

  it('把 App 选择转换成 Codex Connector 引用', () => {
    const gateway = new FeishuGateway({} as any) as any;
    gateway.pendingReferences = new Map([['session-1:user-1', [{ type: 'app', value: 'google-drive', label: 'Google Drive', selectedAt: Date.now() }]]]);
    expect(gateway.applyPendingReferences('session-1', 'user-1', '查找文件')).toBe('[$Google Drive](app://google-drive)\n查找文件');
  });
});

describe('Plan 与 Goal 卡片', () => {
  it('Plan 卡片显示完成进度和刷新按钮', async () => {
    const gateway = new FeishuGateway({} as any) as any;
    gateway.plans = new Map([['session-1', { plan: [{ step: '分析', status: 'completed' }, { step: '实现', status: 'inProgress' }] }]]);
    const result = await gateway.handleSessionControl('session-1', '/plan', { chatId: 'chat-1', openId: 'user-1' });
    expect(result.header.title.content).toBe('Codex · Plan（1/2）');
    expect(JSON.stringify(result)).toContain('刷新计划');
  });

  it('Goal 卡片根据进行中状态显示暂停、完成和清除按钮', async () => {
    const goal = { threadId: 'session-1', objective: '完成测试', status: 'active', tokenBudget: 1000, tokensUsed: 20, timeUsedSeconds: 60, createdAt: 1, updatedAt: 1 };
    const gateway = new FeishuGateway({ getGoal: async () => goal } as any) as any;
    const result = await gateway.handleSessionControl('session-1', '/goal', { chatId: 'chat-1', openId: 'user-1' });
    const content = JSON.stringify(result);
    expect(content).toContain('暂停');
    expect(content).toContain('完成');
    expect(content).toContain('清除');
  });
});

describe('formatDesktopTurn', () => {
  it('提取回答 Markdown 中存在的本地生成图片', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-output-'));
    const image = path.join(dir, 'result image.png');
    fs.writeFileSync(image, 'png');
    const encoded = image.replace(/ /g, '%20');
    expect(extractTurnImagePaths({ items: [{ type: 'agentMessage', text: `已生成：![结果](file://${encoded})` }] })).toEqual([image]);
  });

  it('最终回复未列路径时从本轮 ImageGen 目录找到图片', () => {
    const oldHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-home-'));
    process.env.HOME = home;
    const dir = path.join(home, '.codex', 'generated_images', 'thread-1');
    fs.mkdirSync(dir, { recursive: true });
    const image = path.join(dir, 'exec-result.png');
    fs.writeFileSync(image, 'png');
    try {
      expect(extractTurnImagePaths({ items: [{ type: 'agentMessage', text: '图片已生成' }] }, 'thread-1', Date.now() - 1000)).toEqual([image]);
    } finally { process.env.HOME = oldHome; }
  });

  it('格式化 Desktop 的用户消息与最终回复', () => {
    expect(formatDesktopTurn({ items: [
      { type: 'userMessage', content: [{ type: 'inputText', text: '检查项目' }] },
      { type: 'agentMessage', text: '检查完成。' },
    ] })).toContain('你：\n检查项目\n\nCodex：\n检查完成。');
  });

  it('长请求与长结果分段发送且结果不会被截掉', () => {
    const messages = formatDesktopTurnMessages({ items: [
      { type: 'userMessage', content: [{ type: 'text', text: '请求'.repeat(2200) }] },
      { type: 'agentMessage', text: `最终结论-${'结果'.repeat(2200)}` },
    ] }, 1000);
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.join('')).toContain('最终结论-');
    expect(messages.at(-1)).toContain('结果');
    expect(messages.every((item) => item.length <= 1000)).toBe(true);
  });
});

describe('Desktop Session 同步', () => {
  it('优先从历史 target 恢复话题，避免再次同步时创建重复话题', async () => {
    const gateway = new FeishuGateway({} as any) as any;
    gateway.targets = new Map([['session-1', { chatId: 'chat-1', openId: 'user-1', rootMessageId: 'root-1' }]]);
    gateway.sessionTopics = new Map();
    const group = { projectPath: '/project', projectName: 'Project', chatId: 'chat-1' };

    const topic = gateway.restoreSessionTopicFromTarget(group, 'session-1');

    expect(topic).toEqual({ sessionId: 'session-1', chatId: 'chat-1', threadId: '', rootMessageId: 'root-1' });
    expect(gateway.sessionTopics.get('session-1')).toEqual(topic);
  });

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

describe('Issue Auto 通知', () => {
  it('仅向已绑定的项目群发送，并在发送失败时抛出错误以便重试', async () => {
    const gateway = new FeishuGateway({} as any) as any;
    const create = vi.fn().mockResolvedValue({code:0});
    gateway.client = {im:{message:{create}}};
    gateway.projectGroups.set('/project',{projectPath:'/project',projectName:'Project',chatId:'chat'});
    await gateway.sendIssueAutoNotice('/project', '需要审核 PR');
    expect(create).toHaveBeenCalledTimes(1);
    await expect(gateway.sendIssueAutoNotice('/missing','message')).rejects.toThrow('项目群');
    create.mockResolvedValue({code:1,msg:'failure'});
    await expect(gateway.sendIssueAutoNotice('/project','message')).rejects.toThrow('failure');
  });
});

describe('Issue worktree 会话映射', () => {
  it('将会话绑定到原项目群，并持久保存话题目标', async () => {
    const gateway = new FeishuGateway({} as any) as any;
    gateway.client = {}; gateway.projectGroups.set('/project',{projectPath:'/project',projectName:'P',chatId:'chat'});
    gateway.ensureSessionTopic = vi.fn().mockResolvedValue({sessionId:'session',chatId:'chat',threadId:'topic',rootMessageId:'root'});
    gateway.saveState = vi.fn();
    await expect(gateway.bindIssueSession('/project','session','Issue #1')).resolves.toBe('topic');
    expect(gateway.targets.get('session')).toMatchObject({chatId:'chat',rootMessageId:'root'});
    expect(gateway.saveState).toHaveBeenCalled();
    await expect(gateway.bindIssueSession('/unknown','session2','Issue')).rejects.toThrow('项目群');
  });
});
it('Issue 通知优先回复到已绑定的话题', async () => {
 const gateway=new FeishuGateway({} as any) as any;
 const reply=vi.fn().mockResolvedValue({code:0});gateway.client={im:{message:{reply}}};
 gateway.projectGroups.set('/p',{projectPath:'/p',projectName:'P',chatId:'chat'});
 gateway.sessionTopics.set('s',{sessionId:'s',chatId:'chat',threadId:'topic',rootMessageId:'root'});
 await gateway.sendIssueAutoNotice('/p','PR','s');expect(reply).toHaveBeenCalledWith(expect.objectContaining({path:{message_id:'root'}}));
});
it('managed Issue sessions reject manual queue and destructive controls before any side effects',async()=>{
 const codex={assertExternalControlAllowed:vi.fn(()=>{throw Error('managed Issue')}),send:vi.fn()};
 const gateway=new FeishuGateway(codex as any) as any;const target={chatId:'chat',openId:'user'};
 await expect(gateway.enqueue('managed','please change code',target)).rejects.toThrow('managed Issue');
 await expect(gateway.handleSessionControl('managed','/commit x',target)).rejects.toThrow('managed Issue');
 expect(codex.send).not.toHaveBeenCalled();expect(gateway.tasks.has('managed')).toBe(false);
});
it('runs Feishu tests against a dedicated state database',()=>{
 expect(process.env.CODEXREACH_STATE_DB).toBeTruthy();
 expect(path.resolve(process.env.CODEXREACH_STATE_DB!)).not.toBe(path.resolve('.data/feishu-state.sqlite'));
});
describe('Issue 自动任务实时进度',()=>{
 it('为已绑定的 Issue 会话创建进度卡，并跳过普通消息空闲超时',async()=>{
  const gateway=new FeishuGateway({} as any) as any;gateway.recordBridgeTurn=vi.fn();
  gateway.client={im:{message:{reply:vi.fn().mockResolvedValue({code:0,data:{message_id:'card'}})}}};
  gateway.targets.set('issue-session',{chatId:'chat',openId:'',rootMessageId:'root'});
  await gateway.recordIssueTurn('issue-session','turn');
  expect(gateway.tasks.get('issue-session')).toMatchObject({turnId:'turn',status:'running',managedIssue:true,cardMessageId:'card'});
  expect(gateway.client.im.message.reply).toHaveBeenCalledTimes(1);
  gateway.tasks.get('issue-session').lastActivityAt=Date.now()-60*60*1000;gateway.stopTask=vi.fn();
  await gateway.checkIdleTasks();expect(gateway.stopTask).not.toHaveBeenCalled();
 });
});
it('Issue 阶段变化更新同一张卡且不会把单轮结束误报为任务完成',async()=>{
 const gateway=new FeishuGateway({} as any) as any;gateway.recordBridgeTurn=vi.fn();gateway.saveState=vi.fn();
 const reply=vi.fn().mockResolvedValue({code:0,data:{message_id:'card'}});const patch=vi.fn().mockResolvedValue({code:0});
 gateway.client={im:{message:{reply,patch}}};gateway.targets.set('s',{chatId:'chat',openId:'',rootMessageId:'root'});
 await gateway.recordIssueTurn('s','turn');await gateway.updateIssueStage('s','VALIDATING');
 expect(reply).toHaveBeenCalledTimes(1);expect(gateway.tasks.get('s')).toMatchObject({managedIssue:true,status:'running',issueStage:'VALIDATING'});
 expect(gateway.tasks.get('s').detail).toContain('验证');
});
it('CI 结果尚未完成提醒复核时，进度卡不提前宣称 PR 已可审核',async()=>{
 const gateway=new FeishuGateway({} as any) as any;gateway.saveState=vi.fn();gateway.client={im:{message:{reply:vi.fn().mockResolvedValue({code:0,data:{message_id:'card'}})}}};gateway.targets.set('s',{chatId:'chat',openId:'',rootMessageId:'root'});
 await gateway.updateIssueStage('s','PR_READY');expect(gateway.tasks.get('s')).toMatchObject({status:'running'});expect(gateway.tasks.get('s').detail).toContain('复核');
});
it('并发阶段更新复用同一进度卡并使用稳定去重标识',async()=>{
 const gateway=new FeishuGateway({} as any) as any;gateway.recordBridgeTurn=vi.fn();gateway.saveState=vi.fn();let finish!:(x:any)=>void;
 const reply=vi.fn((_payload:any)=>new Promise(resolve=>{finish=resolve}));gateway.client={im:{message:{reply,patch:vi.fn().mockResolvedValue({code:0})}}};gateway.targets.set('s',{chatId:'chat',openId:'',rootMessageId:'root'});
 const one=gateway.recordIssueTurn('s','t');const two=gateway.updateIssueStage('s','DEVELOPING');await vi.waitFor(()=>expect(reply).toHaveBeenCalledTimes(1));
 expect(reply.mock.calls[0][0].data.uuid).toMatch(/^issue-progress-[0-9a-f]{32}$/);finish({code:0,data:{message_id:'card'}});await Promise.all([one,two]);expect(gateway.issueTaskCardIds.get('s')).toBe('card');
});
it('发送进度卡等待飞书返回期间发生阶段切换时，仍保存卡片 ID',async()=>{
 const gateway=new FeishuGateway({} as any) as any;gateway.recordBridgeTurn=vi.fn();gateway.saveState=vi.fn();let finish!:(x:any)=>void;
 const reply=vi.fn((_payload:any)=>new Promise(resolve=>{finish=resolve}));gateway.client={im:{message:{reply,patch:vi.fn().mockResolvedValue({code:0})}}};gateway.targets.set('s',{chatId:'chat',openId:'',rootMessageId:'root'});
 const first=gateway.recordIssueTurn('s','t');await vi.waitFor(()=>expect(reply).toHaveBeenCalledTimes(1));const second=gateway.updateIssueStage('s','VALIDATING');finish({code:0,data:{message_id:'card'}});await Promise.all([first,second]);
 expect(gateway.issueTaskCardIds.get('s')).toBe('card');expect(gateway.tasks.get('s').cardMessageId).toBe('card');expect(gateway.tasks.get('s').issueStage).toBe('VALIDATING');
});
it('执行事件使用可读状态而不是暴露底层事件名',async()=>{
 const {summarizeNotification}=await import('./feishu.js');
 expect(summarizeNotification({method:'item/commandExecution/outputDelta'})).toContain('命令');
 expect(summarizeNotification({method:'item/fileChange/outputDelta'})).toContain('文件');
 expect(summarizeNotification({method:'item/reasoning/summaryTextDelta'})).toContain('分析');
});
it('Issue 执行事件刷新状态，单轮完成时仍显示任务继续推进',async()=>{
 const gateway=new FeishuGateway({} as any) as any;gateway.recordBridgeTurn=vi.fn();gateway.saveState=vi.fn();gateway.client={im:{message:{reply:vi.fn().mockResolvedValue({code:0,data:{message_id:'card'}}),patch:vi.fn().mockResolvedValue({code:0})}}};gateway.targets.set('s',{chatId:'chat',openId:'',rootMessageId:'root'});
 await gateway.recordIssueTurn('s','turn');await gateway.handleTaskStatusNotification('s',{method:'item/commandExecution/outputDelta',params:{}});
 expect(gateway.tasks.get('s').detail).toContain('命令');
 await gateway.handleTaskStatusNotification('s',{method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
 expect(gateway.tasks.get('s')).toMatchObject({status:'running',managedIssue:true});expect(gateway.tasks.get('s').detail).toContain('继续验证');
});
it('飞书拒绝更新 Issue 进度卡时返回错误而不是假报成功',async()=>{
 const gateway=new FeishuGateway({} as any) as any;gateway.client={im:{message:{patch:vi.fn().mockResolvedValue({code:999,msg:'denied'})}}};gateway.tasks.set('s',{startedAt:Date.now(),lastActivityAt:Date.now(),status:'running',managedIssue:true,issueStage:'VALIDATING',detail:'验证中',cardMessageId:'card'});
 await expect(gateway.updateTaskCard('s')).rejects.toThrow('denied');
});
it('进度卡更新串行发送，较慢的旧请求不能覆盖新状态',async()=>{
 vi.useFakeTimers();try{
  const gateway=new FeishuGateway({} as any) as any;gateway.recordBridgeTurn=vi.fn();gateway.saveState=vi.fn();let finish!:(x:any)=>void;
  const patch=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValue({code:0});
  gateway.client={im:{message:{reply:vi.fn().mockResolvedValue({code:0,data:{message_id:'card'}}),patch}}};gateway.targets.set('s',{chatId:'chat',openId:'',rootMessageId:'root'});
  await gateway.recordIssueTurn('s','t');await vi.advanceTimersByTimeAsync(2000);expect(patch).toHaveBeenCalledTimes(1);
  await gateway.updateIssueStage('s','VALIDATING');await vi.advanceTimersByTimeAsync(5000);expect(patch).toHaveBeenCalledTimes(1);
  finish({code:0});await vi.advanceTimersByTimeAsync(2000);expect(patch).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});
it('Issue 验证和 CI 阶段不展示无法安全执行的停止按钮',async()=>{
 const gateway=new FeishuGateway({} as any) as any;
 for(const stage of ['VALIDATING','CI_CHECKING']){gateway.tasks.set('s',{startedAt:Date.now(),lastActivityAt:Date.now(),status:'running',managedIssue:true,issueStage:stage,detail:'正在执行'});const card=await gateway.taskCard('s');const actions=card.elements.find((x:any)=>x.tag==='action').actions;expect(actions.map((x:any)=>x.value.action)).not.toContain('task_stop');}
 gateway.tasks.set('s',{startedAt:Date.now(),lastActivityAt:Date.now(),status:'running',managedIssue:true,issueStage:'DEVELOPING',detail:'正在执行'});const card=await gateway.taskCard('s');expect(card.elements.find((x:any)=>x.tag==='action').actions.map((x:any)=>x.value.action)).toContain('task_stop');
});
it('Issue 阻塞卡不展示尚未接入的普通消息重试按钮',async()=>{
 const gateway=new FeishuGateway({} as any) as any;gateway.tasks.set('s',{startedAt:Date.now(),lastActivityAt:Date.now(),status:'failed',managedIssue:true,issueStage:'BLOCKED',detail:'需要人工处理'});const card=await gateway.taskCard('s');expect(card.elements.find((x:any)=>x.tag==='action').actions.map((x:any)=>x.value.action)).not.toContain('task_retry');
});
describe('正式关键通知的单聊与定位',()=>{
 it('回复 Topic 后返回本条消息的位置，并生成精准最新回复链接',async()=>{
  const g=new FeishuGateway({} as any) as any;const reply=vi.fn().mockResolvedValue({code:0,data:{message_id:'om_sent',chat_id:'oc_chat',thread_id:'omt_thread',thread_message_position:'12'}});g.client={im:{message:{reply}}};g.projectGroups.set('/p',{chatId:'oc_chat'});g.sessionTopics.set('s',{chatId:'oc_chat',threadId:'omt_thread',rootMessageId:'om_root'});
  const r=await g.sendIssueTopicRecord({projectPath:'/p',sessionId:'s',message:'ready',uuid:'dedupe'});const link=await g.resolveIssueTopicLink(r);expect(new URL(link).searchParams.get('thread_position')).toBe('12');expect(reply.mock.calls[0][0].data.uuid).toBe('dedupe');
 });
 it('仅查询刚发送的消息补足位置，不拉群历史',async()=>{
  const g=new FeishuGateway({} as any) as any;const get=vi.fn().mockResolvedValue({code:0,data:{items:[{message_id:'om_sent',chat_id:'oc_chat',thread_id:'omt_thread',thread_message_position:'9'}]}});g.client={im:{message:{get}}};const link=await g.resolveIssueTopicLink({messageId:'om_sent',chatId:'oc_chat'});expect(new URL(link).searchParams.get('thread_position')).toBe('9');expect(get).toHaveBeenCalledWith({path:{message_id:'om_sent'}});
 });
 it('单聊富文本包含定位消息、PR 与测试页面链接',async()=>{
  const g=new FeishuGateway({} as any) as any;const create=vi.fn().mockResolvedValue({code:0,data:{message_id:'om_dm'}});g.client={im:{message:{create}}};const link='https://applink.feishu.cn/client/thread/open?open_chat_id=oc_chat&open_thread_id=omt_thread&thread_position=12';
  await g.sendIssueDirectNotice({recipient:'ou_user',message:'PR：https://github.com/blackpill/usmapgames.com/pull/10\n测试：http://192.168.3.16:8801/',link,uuid:'stable'});const request=create.mock.calls[0][0];expect(request.params.receive_id_type).toBe('open_id');expect(request.data.msg_type).toBe('post');const content=JSON.parse(request.data.content);const links=content.zh_cn.content.flat().filter((x:any)=>x.tag==='a').map((x:any)=>x.href);expect(links).toContain(link);expect(links).toContain('http://192.168.3.16:8801/');expect(request.data.uuid).toBe('stable');
 });
});
