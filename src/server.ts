import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import * as lark from '@larksuiteoapi/node-sdk';
import { CodexClient } from './codex-client.js';
import { AuthStore } from './auth.js';
import { FeishuGateway } from './feishu.js';
import { groupProjects } from './types.js';
import { logger } from './logger.js';
import { ActionProcessor } from './evaluation/action-processor.js';
import { EvaluationStore } from './evaluation/store.js';
import { BatchService } from './evaluation/batch-service.js';
import { PlanService } from './evaluation/plan-service.js';
import { EvaluationScheduler } from './evaluation/scheduler.js';
import { EvaluationResultProcessor } from './evaluation/result-processor.js';
import { IssueStore } from './issue-auto/store.js';
import { readIssueConfig } from './issue-auto/config.js';
import { createIssueAutomation } from './issue-auto/boot.js';
import { BaseSyncService, LarkEvaluationBaseApi } from './evaluation/base-sync.js';
import { createYouTubeAutomation } from './youtube-monitor/boot.js';

try { process.loadEnvFile(); } catch { /* .env 可选 */ }

const app = Fastify({ logger: true });
const codex = new CodexClient(); const auth = new AuthStore();
const issueGuardStore = new IssueStore(process.env.CODEXREACH_STATE_DB ? path.resolve(process.env.CODEXREACH_STATE_DB) : path.resolve('.data/feishu-state.sqlite'));
codex.setIssueSessionGuard(id => issueGuardStore.isManagedSession(id));
await auth.init(); await codex.start();
await app.register(websocket);

const evaluationStore = new EvaluationStore(
  process.env.CODEXREACH_STATE_DB ? path.resolve(process.env.CODEXREACH_STATE_DB) : path.resolve('.data/feishu-state.sqlite'),
);
const evaluationBatchService = new BatchService(evaluationStore);
const evaluationPlanService = new PlanService(evaluationStore);
const evaluationProjectPaths = new Set((process.env.EVALUATION_PROJECT_PATHS ?? '').split(',').map((item) => item.trim()).filter(Boolean));
const feishu = new FeishuGateway(codex);
const evaluationBaseConfig = process.env.EVALUATION_BASE_TOKEN
  && process.env.EVALUATION_BASE_PROJECT_TABLE_ID
  && process.env.EVALUATION_BASE_ACTION_TABLE_ID
  && process.env.EVALUATION_BASE_PLAN_TABLE_ID
  && process.env.EVALUATION_BASE_RESULT_TABLE_ID
  && process.env.FEISHU_APP_ID
  && process.env.FEISHU_APP_SECRET
  ? {
      baseToken: process.env.EVALUATION_BASE_TOKEN,
      projectTableId: process.env.EVALUATION_BASE_PROJECT_TABLE_ID,
      actionTableId: process.env.EVALUATION_BASE_ACTION_TABLE_ID,
      planTableId: process.env.EVALUATION_BASE_PLAN_TABLE_ID,
      resultTableId: process.env.EVALUATION_BASE_RESULT_TABLE_ID,
    }
  : undefined;
const evaluationBaseSync = evaluationBaseConfig
  ? new BaseSyncService(
      evaluationStore,
      new LarkEvaluationBaseApi(new lark.Client({ appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET! }), evaluationBaseConfig.baseToken),
      evaluationBaseConfig,
    )
  : undefined;

async function syncPlanToBase(batchId: string) {
  if (!evaluationBaseSync) return;
  const batch = evaluationStore.getBatch(batchId);
  const candidate = batch?.candidateIds.map((id) => evaluationStore.getCandidate(id)).find(Boolean);
  const plan = batch ? evaluationStore.getPlanByBatch(batch.id) : undefined;
  if (!batch || !candidate || !plan) return;
  await evaluationBaseSync.syncPlan({ batch, candidate, plan, nodes: evaluationStore.listNodesByPlan(plan.id) });
}

feishu.setEvaluationDraftHandler(async (batchId, action) => {
  const batch = evaluationBatchService.updateDraftStatus(batchId, action === 'confirm' ? 'confirmed' : 'ignored');
  if (action === 'confirm') {
    const planned = evaluationPlanService.confirmBatch(batchId);
    const taskNodes = await feishu.createEvaluationTasks({
      projectName: batch.projectName || path.basename(batch.projectPath || '') || 'Codex 项目',
      batch,
      template: planned.plan.template,
      nodes: planned.nodes,
    });
    for (const node of taskNodes) evaluationStore.saveNode(node);
    // Base 同步是附属持久化，失败不能让飞书卡片回调整体失败；否则飞书会
    // 显示 200671，用户重试按钮时还会重复执行已经成功的任务创建流程。
    await syncPlanToBase(batchId).catch((error) => {
      logger.error('evaluation_base_sync_failed', error, { batchId });
    });
  }
  logger.info('evaluation_draft_action', { batchId, action });
});
feishu.setEvaluationDueHandler(async (nodeId, action) => {
  const node = evaluationStore.getNode(nodeId);
  if (!node) throw new Error(`Evaluation node not found: ${nodeId}`);
  if (action === 'postpone') {
    const now = new Date().toISOString();
    const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    evaluationStore.saveNode({ ...node, status: 'postponed', updatedAt: now });
    const scheduled = { ...node, status: 'scheduled' as const, dueAt, reminderStage: 0 as const, firstPromptedAt: undefined, lastRemindedAt: undefined, updatedAt: now };
    evaluationStore.saveNode(scheduled);
    await feishu.rescheduleEvaluationTask(node.feishuTaskGuid, dueAt);
    await syncPlanToBase(evaluationStore.getPlan(node.planId)?.batchId ?? '');
    return;
  }
  if (action === 'cancel') {
    const now = new Date().toISOString();
    evaluationStore.saveNode({ ...node, status: 'cancelled', updatedAt: now });
    await feishu.completeEvaluationTask(node.feishuTaskGuid, now);
    await syncPlanToBase(evaluationStore.getPlan(node.planId)?.batchId ?? '');
    return;
  }
  if (node.status === 'running' && node.startedSessionId) return;
  if (node.status !== 'waiting_confirmation' && node.status !== 'failed') {
    throw new Error(`Evaluation node is not ready to start: ${node.status}`);
  }
  const plan = evaluationStore.getPlan(node.planId);
  const batch = plan ? evaluationStore.getBatch(plan.batchId) : undefined;
  if (!plan || !batch?.projectPath) throw new Error(`Evaluation context not found: ${nodeId}`);
  const prompt = [
    '你正在执行一次后续效果评估。',
    `项目：${batch.projectName ?? path.basename(batch.projectPath)}`,
    `原行动：${batch.summary}`,
    `生产生效时间：${batch.effectiveAt}`,
    `评估类型：${plan.template}`,
    `评估目标：${node.purpose}`,
    '',
    '要求：',
    '1. 检查数据是否足够；',
    '2. 保存可核查的证据；',
    '3. 说明可能的混杂因素；',
    '4. 输出结构化结论与建议；',
    '5. 不要未经确认直接修改或回滚线上系统。',
    '',
    '最终回复必须包含一个 JSON 代码块：',
    '{"conclusion":"effective|negative|no_material_change|insufficient_data|not_attributable|technical_issue","confidence":0.0,"summary":"...","recommendation":"...","evidence":{}}',
  ].join('\n');
  try {
    await feishu.startEvaluationSession({
      projectPath: batch.projectPath,
      sourceSessionId: batch.sourceSessionId,
      title: `评估｜${batch.projectName ?? path.basename(batch.projectPath)}｜${plan.template.toUpperCase()}`,
      prompt,
      onPrepared: async (sessionId, topicId) => {
        evaluationStore.saveNode({ ...node, status: 'running', startedSessionId: sessionId, evaluationTopicId: topicId, updatedAt: new Date().toISOString() });
        await syncPlanToBase(batch.id);
      },
    });
  } catch (error) {
    const current = evaluationStore.getNode(node.id);
    if (current?.status === 'running') evaluationStore.saveNode({ ...current, status: 'failed', updatedAt: new Date().toISOString() });
    throw error;
  }
});
const evaluationProcessor = new ActionProcessor(codex, evaluationStore, {
  enabled: process.env.EVALUATION_SYSTEM_ENABLED === 'true',
  allowedProjectPaths: evaluationProjectPaths,
  onCandidateSaved: async ({ candidate, actions, context }) => {
    if (!actions.some((action) => action.productionState === 'deployed')) return;
    const draft = evaluationBatchService.createFromVerifiedTurn({ candidate, actions, context });
    const sent = await feishu.sendEvaluationDraft(context.projectPath, context.sessionId, draft);
    if (!sent) {
      const now = new Date().toISOString();
      evaluationStore.enqueue({
        id: `outbox-${draft.batch.id}`,
        idempotencyKey: `evaluation-draft:${draft.batch.id}`,
        eventType: 'feishu.evaluation-draft.send',
        aggregateId: draft.batch.id,
        payload: { projectPath: context.projectPath, sourceSessionId: context.sessionId },
        status: 'pending', retryCount: 0, nextRetryAt: now, createdAt: now, updatedAt: now,
      });
    }
  },
});
const evaluationScheduler = new EvaluationScheduler(evaluationStore, {
  enabled: process.env.EVALUATION_SYSTEM_ENABLED === 'true',
  intervalMs: Math.max(5, Number(process.env.EVALUATION_SCHEDULER_INTERVAL_SECONDS ?? 60)) * 1_000,
  onDue: ({ node, plan, batch }) => feishu.sendEvaluationDueCard({
    projectPath: batch.projectPath ?? '',
    sourceSessionId: batch.sourceSessionId,
    projectName: batch.projectName || path.basename(batch.projectPath || '') || 'Codex 项目',
    batchSummary: batch.summary,
    template: plan.template,
    node,
  }),
  onReminder: ({ node, batch }, stage) => feishu.sendEvaluationReminder({
    projectPath: batch.projectPath ?? '',
    sourceSessionId: batch.sourceSessionId,
    node,
    stage,
  }),
  onStateChanged: ({ batch }) => syncPlanToBase(batch.id),
});
const evaluationResultProcessor = new EvaluationResultProcessor(codex, evaluationStore, {
  enabled: process.env.EVALUATION_SYSTEM_ENABLED === 'true',
  onCompleted: async ({ node, batch, result }) => {
    if (!batch.projectPath) throw new Error(`Evaluation project path missing: ${batch.id}`);
    const run = evaluationStore.getRunBySession(node.startedSessionId ?? '');
    const plan = evaluationStore.getPlan(node.planId);
    if (evaluationBaseSync && run && plan) await evaluationBaseSync.syncResult({ batch, plan, node, run, result });
    await feishu.sendEvaluationResult({
      projectPath: batch.projectPath,
      sourceSessionId: batch.sourceSessionId,
      projectName: batch.projectName || path.basename(batch.projectPath),
      node,
      result,
      evaluationTopicId: node.evaluationTopicId,
    });
    await feishu.completeEvaluationTask(node.feishuTaskGuid);
  },
  onFailed: async ({ node, batch }, error) => {
    if (!batch.projectPath) return;
    await feishu.sendEvaluationResult({
      projectPath: batch.projectPath,
      sourceSessionId: batch.sourceSessionId,
      projectName: batch.projectName || path.basename(batch.projectPath),
      node,
      error,
      evaluationTopicId: node.evaluationTopicId,
    });
  },
});

const sockets = new Set<any>();
codex.on('notification', (event) => {
  const payload = JSON.stringify({ type: 'codex-event', event });
  for (const socket of sockets) if (socket.readyState === 1) socket.send(payload);
  void evaluationProcessor.handleNotification(event);
  void evaluationResultProcessor.handleNotification(event);
});
codex.on('online', () => logger.info('codex_online'));
codex.on('offline', () => logger.warn('codex_offline'));
codex.on('log', (message) => logger.info('codex_log', { message: String(message).slice(0, 4000) }));

app.addHook('preHandler', async (request, reply) => {
  if (request.url.startsWith('/api/pair') || !request.url.startsWith('/api/')) return;
  if (!auth.verify(request.headers.authorization)) return reply.code(401).send({ error: '未配对或登录已失效' });
});
app.post('/api/pair', async (request, reply) => {
  const token = auth.pair((request.body as any)?.code); if (!token) return reply.code(401).send({ error: '配对码无效或已过期' });
  return { token };
});
app.get('/api/projects', async () => ({ projects: groupProjects(await codex.listThreads()) }));
app.get('/api/threads/:id', async (request) => ({ thread: await codex.readThread((request.params as any).id) }));
app.post('/api/threads/:id/turns', async (request) => codex.send((request.params as any).id, (request.body as any).text));
app.post('/api/threads', async (request) => codex.create((request.body as any).cwd, (request.body as any).text));
app.post('/api/threads/:id/interrupt', async (request) => codex.interrupt((request.params as any).id, (request.body as any).turnId));
app.get('/api/events', { websocket: true }, (socket, request) => {
  const token = (request.query as any)?.token; if (!auth.verify(`Bearer ${token}`)) return socket.close(1008, 'Unauthorized');
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.send(JSON.stringify({ type: 'connected' }));
});

const webRoot = path.resolve('dist-web');
await app.register(fastifyStatic, { root: webRoot, wildcard: false });
app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));

function localIp() { return Object.values(os.networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1'; }
const host = process.env.HOST ?? '0.0.0.0', port = Number(process.env.PORT ?? 4317);
const feishuReady = feishu.start();
evaluationScheduler.start();
let youtubeAutomation: ReturnType<typeof createYouTubeAutomation>;
try {
  youtubeAutomation = createYouTubeAutomation(process.env, {
    onEvent: (event, data) => logger.info(event, data),
  });
  youtubeAutomation?.start();
} catch {
  logger.warn('youtube_monitor_disabled_invalid_config');
}
app.addHook('onClose', async () => { await youtubeAutomation?.stop(); });
let issueAutomation: ReturnType<typeof createIssueAutomation> | undefined;
app.addHook('onClose', async () => { if (issueAutomation) await issueAutomation.stop(); codex.setIssueSessionGuard(); issueGuardStore.close(); });
await app.listen({ host, port });
try {
  const issueConfig = readIssueConfig(process.env);
  if (issueConfig) {
    if (!feishuReady) throw new Error('飞书客户端未启用');
    issueAutomation = createIssueAutomation(issueConfig, codex, feishu, () => logger.warn('issue_auto_step_failed'));
    issueAutomation.start();
    logger.info('issue_auto_started');
  }
} catch { logger.warn('issue_auto_disabled_invalid_config'); }
const url = `http://${localIp()}:${port}`; const code = auth.rotatePairCode();
app.log.info(`手机控制台：${url}  配对码：${code}`);
app.log.info(`配对二维码：\n${await QRCode.toString(`${url}?pair=${code}`, { type: 'terminal', small: true })}`);
