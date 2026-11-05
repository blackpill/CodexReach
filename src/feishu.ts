import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { CodexClient, ThreadGoal } from './codex-client.js';
import { groupProjects, type Project } from './types.js';
import { logger } from './logger.js';
import { codexEventId, StateStore } from './state-store.js';
import type { EvaluationDraft } from './evaluation/batch-service.js';
import type { ActionBatch, EvaluationNode } from './evaluation/types.js';
import type { ExtractedEvaluationResult } from './evaluation/result-extractor.js';

type Card = { config: Record<string, unknown>; header: Record<string, unknown>; elements: Array<Record<string, unknown>> };
type Reply = string | Card;
type ProjectGroup = { projectPath: string; projectName: string; chatId: string; shareLink?: string };
type SessionTopic = { sessionId: string; chatId: string; threadId: string; rootMessageId: string };
type Target = { chatId: string; openId: string; rootMessageId?: string };
type QueuedMessage = { text: string; target: Target; at: number };
type TaskState = { startedAt: number; lastActivityAt: number; turnId?: string; cardMessageId?: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout'; detail?: string; lastPrompt?: string };
type PlanState = { explanation?: string | null; plan: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> };
type PendingReference = { type: 'file' | 'skill' | 'app'; value: string; label?: string; selectedAt: number };
type DocumentBinding = { fileToken: string; fileType: 'doc' | 'docx'; url: string; projectPath: string; projectName: string };
type CommentTarget = { fileToken: string; fileType: 'doc' | 'docx'; commentId: string; replyId?: string; openId: string };
type EvaluationDraftHandler = (batchId: string, action: 'confirm' | 'ignore') => Promise<void> | void;
type EvaluationDueHandler = (nodeId: string, action: 'start' | 'postpone' | 'cancel') => Promise<void> | void;

const CODEX_REACH_LABEL = 'CodexReach';

function projectGroupName(projectName: string) {
  // 自建应用通常没有企业级群 Label 管理权限，因此用稳定前缀作为可见标签。
  return `${CODEX_REACH_LABEL}｜${projectName}`.slice(0, 60);
}

export function parseNewCommand(raw: string, isDirectory = (candidate: string) => {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}) {
  const quoted = raw.match(/^(["'])(.*?)\1\s+([\s\S]+)$/);
  if (quoted) return { cwd: quoted[2], prompt: quoted[3].trim() };

  const parts = raw.trim().split(/\s+/);
  // Prefer the longest existing directory prefix, so absolute paths containing
  // spaces work without requiring quotes.
  for (let index = parts.length - 1; index >= 1; index--) {
    const cwd = parts.slice(0, index).join(' ');
    if (path.isAbsolute(cwd) && isDirectory(cwd)) {
      return { cwd, prompt: parts.slice(index).join(' ') };
    }
  }
  return null;
}

export class FeishuGateway {
  private selected = new Map<string, string>();
  private targets = new Map<string, Target>();
  private projectGroups = new Map<string, ProjectGroup>();
  private sessionTopics = new Map<string, SessionTopic>();
  private handledMessages: string[] = [];
  private projectsCache?: { at: number; projects: Project[] };
  private queues = new Map<string, QueuedMessage[]>();
  private tasks = new Map<string, TaskState>();
  private plans = new Map<string, PlanState>();
  private goals = new Map<string, ThreadGoal>();
  private planCardMessages = new Map<string, string>();
  private goalCardMessages = new Map<string, string>();
  private controlCardTimers = new Map<string, NodeJS.Timeout>();
  private pendingReferences = new Map<string, PendingReference[]>();
  private sessionOptions = new Map<string, { model?: string; mode?: 'default' | 'plan' }>();
  private documentBindings = new Map<string, DocumentBinding>();
  private commentSessions = new Map<string, string>();
  private commentTargets = new Map<string, CommentTarget>();
  private commentQueues = new Map<string, string[]>();
  private handledComments: string[] = [];
  private syncedTurns = new Map<string, string[]>();
  private evaluationHubTopics = new Map<string, SessionTopic>();
  private evaluationDraftHandler?: EvaluationDraftHandler;
  private evaluationDueHandler?: EvaluationDueHandler;
  private evaluationTasklistGuid?: string;
  private evaluationTasklistPromise?: Promise<string>;
  private client?: lark.Client;
  private watchdog?: NodeJS.Timeout;
  private desktopSyncTimer?: NodeJS.Timeout;
  private desktopSyncRunning = false;
  private readonly stateStore = new StateStore(
    process.env.CODEXREACH_STATE_DB ? path.resolve(process.env.CODEXREACH_STATE_DB) : path.resolve('.data/feishu-state.sqlite'),
  );
  constructor(private codex: CodexClient) { this.loadState(); }

  setEvaluationDraftHandler(handler: EvaluationDraftHandler) {
    this.evaluationDraftHandler = handler;
  }

  setEvaluationDueHandler(handler: EvaluationDueHandler) {
    this.evaluationDueHandler = handler;
  }

  async sendEvaluationDraft(projectPath: string, sourceSessionId: string, draft: EvaluationDraft): Promise<boolean> {
    if (!this.client) return false;
    const group = this.projectGroups.get(projectPath);
    if (!group) {
      logger.warn('evaluation_project_group_missing', { projectPath, batchId: draft.batch.id });
      return false;
    }
    const topic = this.sessionTopics.get(sourceSessionId) ?? await this.ensureEvaluationHubTopic(this.client, group);
    const actionLines = draft.actions.map((action) => `• ${action.summary}`).join('\n').slice(0, 1800);
    const content = JSON.stringify({
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: '检测到需要后续评估的生产变更' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**项目**\n${group.projectName}\n\n**生产生效时间**\n${draft.deployment.effectiveAt}\n\n**行动批次**\n${actionLines}\n\n**建议模板**\n${draft.candidate.suggestedTemplate.toUpperCase()}` } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `Commit：${draft.deployment.commitSha ?? '未识别'}　批次：${draft.batch.id}` }] },
        { tag: 'action', actions: [
          { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '确认创建' }, value: { action: 'evaluation_draft_confirm', batchId: draft.batch.id } },
          { tag: 'button', text: { tag: 'plain_text', content: '无需评估' }, value: { action: 'evaluation_draft_ignore', batchId: draft.batch.id } },
        ] },
      ],
    });
    const sent = await this.client.im.message.reply({ path: { message_id: topic.rootMessageId }, data: { msg_type: 'interactive', content } });
    if (sent.code) throw new Error(`发送评估草稿失败：${sent.msg}`);
    logger.info('evaluation_draft_sent', { batchId: draft.batch.id, projectPath, sourceSessionId, rootMessageId: topic.rootMessageId });
    return true;
  }

  async createEvaluationTasks(input: {
    projectName: string;
    batch: ActionBatch;
    template: string;
    nodes: EvaluationNode[];
  }): Promise<EvaluationNode[]> {
    if (!this.client) throw new Error('飞书客户端尚未初始化');
    const tasklistGuid = await this.ensureEvaluationTasklist(this.client);
    const assignee = process.env.EVALUATION_DEFAULT_ASSIGNEE_OPEN_ID
      || (process.env.FEISHU_ALLOWED_OPEN_IDS ?? '').split(',').map((item) => item.trim()).find(Boolean);
    const updated: EvaluationNode[] = [];
    for (const node of input.nodes) {
      if (node.feishuTaskGuid) { updated.push(node); continue; }
      const delayDays = Math.max(0, Math.round((Date.parse(node.dueAt) - Date.parse(input.batch.effectiveAt)) / 86_400_000));
      const result = await this.client.task.v2.task.create({
        params: { user_id_type: 'open_id' },
        data: {
          summary: `[效果评估] ${input.projectName}｜${input.template.toUpperCase()}｜${delayDays} 天`,
          description: [
            `原行动：${input.batch.summary}`,
            `生产生效时间：${input.batch.effectiveAt}`,
            `本次目标：${node.purpose}`,
            `行动批次：${input.batch.id}`,
            `评估节点：${node.id}`,
            '到期后 CodexReach 会在原项目话题询问是否启动 Codex 评估。',
          ].join('\n\n').slice(0, 3000),
          due: { timestamp: String(Date.parse(node.dueAt)), is_all_day: false },
          reminders: [{ relative_fire_minute: 0 }],
          client_token: node.id,
          tasklists: [{ tasklist_guid: tasklistGuid }],
          members: assignee ? [{ id: assignee, type: 'user', role: 'assignee' }] : undefined,
          extra: Buffer.from(JSON.stringify({ evaluationNodeId: node.id, batchId: input.batch.id })).toString('base64'),
        },
      });
      const task = result.data?.task;
      if (result.code || !task?.guid) throw new Error(`创建评估任务失败：${result.msg ?? '未返回任务 GUID'}`);
      updated.push({
        ...node,
        feishuTaskGuid: task.guid,
        feishuTaskUrl: task.url,
        updatedAt: new Date().toISOString(),
      });
    }
    return updated;
  }

  async sendEvaluationDueCard(input: {
    projectPath: string;
    sourceSessionId?: string;
    projectName: string;
    batchSummary: string;
    template: string;
    node: EvaluationNode;
  }): Promise<boolean> {
    if (!this.client) return false;
    const group = this.projectGroups.get(input.projectPath);
    if (!group) return false;
    const topic = await this.resolveEvaluationTopic(this.client, group, input.sourceSessionId);
    const content = JSON.stringify({
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: '评估任务已到期' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**项目**\n${input.projectName}\n\n**原行动**\n${input.batchSummary}\n\n**评估目标**\n${input.node.purpose}\n\n**计划时间**\n${input.node.dueAt}\n\n**类型**\n${input.template.toUpperCase()}` } },
        { tag: 'action', actions: [
          { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '开始评估' }, value: { action: 'evaluation_due_start', nodeId: input.node.id } },
          { tag: 'button', text: { tag: 'plain_text', content: '延期 7 天' }, value: { action: 'evaluation_due_postpone', nodeId: input.node.id } },
          { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '取消评估' }, value: { action: 'evaluation_due_cancel', nodeId: input.node.id } },
        ] },
      ],
    });
    const sent = await this.client.im.message.reply({ path: { message_id: topic.rootMessageId }, data: { msg_type: 'interactive', content } });
    if (sent.code) throw new Error(`发送到期评估卡片失败：${sent.msg}`);
    return true;
  }

  async sendEvaluationReminder(input: {
    projectPath: string;
    sourceSessionId?: string;
    node: EvaluationNode;
    stage: 1 | 3 | 7;
  }): Promise<boolean> {
    if (!this.client) return false;
    const group = this.projectGroups.get(input.projectPath);
    if (!group) return false;
    const topic = await this.resolveEvaluationTopic(this.client, group, input.sourceSessionId);
    const label = input.stage === 7 ? '最后一次提醒' : `第 ${input.stage} 天提醒`;
    const sent = await this.client.im.message.reply({ path: { message_id: topic.rootMessageId }, data: {
      msg_type: 'text', content: JSON.stringify({ text: `${label}：评估任务尚未处理\n\n${input.node.purpose}\n\n请处理上方“评估任务已到期”卡片。` }),
    }});
    if (sent.code) throw new Error(`发送评估提醒失败：${sent.msg}`);
    return true;
  }

  async sendEvaluationResult(input: {
    projectPath: string;
    sourceSessionId?: string;
    projectName: string;
    node: EvaluationNode;
    result?: ExtractedEvaluationResult;
    error?: string;
    evaluationTopicId?: string;
  }): Promise<boolean> {
    if (!this.client) return false;
    const group = this.projectGroups.get(input.projectPath);
    if (!group) return false;
    const topic = await this.resolveEvaluationTopic(this.client, group, input.sourceSessionId);
    const conclusionLabels: Record<string, string> = {
      effective: '倾向有效', negative: '倾向负向', no_material_change: '无明显变化',
      insufficient_data: '数据不足', not_attributable: '无法归因', technical_issue: '技术异常',
    };
    const text = input.error
      ? `⚠️ 评估执行失败\n\n项目：${input.projectName}\n目标：${input.node.purpose}\n原因：${input.error}`
      : [
          '✅ 后续评估已完成',
          `项目：${input.projectName}`,
          `目标：${input.node.purpose}`,
          `结论：${conclusionLabels[input.result!.conclusion] ?? input.result!.conclusion}`,
          `置信度：${Math.round(input.result!.confidence * 100)}%`,
          `摘要：${input.result!.summary}`,
          `建议：${input.result!.recommendation}`,
          input.evaluationTopicId ? `评估话题 ID：${input.evaluationTopicId}` : '',
        ].filter(Boolean).join('\n\n');
    const sent = await this.client.im.message.reply({ path: { message_id: topic.rootMessageId }, data: {
      msg_type: 'text', content: JSON.stringify({ text: text.slice(0, 3900) }),
    }});
    if (sent.code) throw new Error(`回写评估结果失败：${sent.msg}`);
    return true;
  }

  async startEvaluationSession(input: {
    projectPath: string;
    sourceSessionId?: string;
    title: string;
    prompt: string;
    onPrepared?: (sessionId: string, topicId: string) => Promise<void> | void;
  }): Promise<{ sessionId: string; topicId: string }> {
    if (!this.client) throw new Error('飞书客户端尚未初始化');
    const group = this.projectGroups.get(input.projectPath);
    if (!group) throw new Error(`找不到项目群：${input.projectPath}`);
    const thread = await this.codex.prepareThread(input.projectPath, input.title);
    const topic = await this.ensureSessionTopic(this.client, group, thread.id, input.title);
    this.targets.set(thread.id, { chatId: group.chatId, openId: '', rootMessageId: topic.rootMessageId });
    this.saveState();
    await input.onPrepared?.(thread.id, topic.threadId);
    const turn = await this.codex.send(thread.id, input.prompt);
    if (turn?.turn?.id) this.recordBridgeTurn(thread.id, turn.turn.id);
    return { sessionId: thread.id, topicId: topic.threadId };
  }

  async rescheduleEvaluationTask(taskGuid: string | undefined, dueAt: string) {
    if (!this.client || !taskGuid) return;
    const result = await this.client.task.v2.task.patch({
      path: { task_guid: taskGuid },
      data: { task: { due: { timestamp: String(Date.parse(dueAt)), is_all_day: false } }, update_fields: ['due'] },
    });
    if (result.code) throw new Error(`延期飞书评估任务失败：${result.msg}`);
  }

  async completeEvaluationTask(taskGuid: string | undefined, completedAt = new Date().toISOString()) {
    if (!this.client || !taskGuid) return;
    const result = await this.client.task.v2.task.patch({
      path: { task_guid: taskGuid },
      data: { task: { completed_at: String(Date.parse(completedAt)) }, update_fields: ['completed_at'] },
    });
    if (result.code) throw new Error(`完成飞书评估任务失败：${result.msg}`);
  }

  start() {
    const appId = process.env.FEISHU_APP_ID, appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return false;
    const allowed = new Set((process.env.FEISHU_ALLOWED_OPEN_IDS ?? '').split(',').filter(Boolean));
    const client = new lark.Client({ appId, appSecret });
    this.client = client;
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (event: any) => {
        const openId = event.sender?.sender_id?.open_id ?? '';
        if (allowed.size && !allowed.has(openId)) return;
        const messageType = event.message?.message_type ?? 'text';
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
        const text = await this.parseIncomingMessage(client, event.message, messageType);
        if (!text) return;

        // Project 群中的一个飞书话题严格对应一个 Codex Session。
        let projectGroup = [...this.projectGroups.values()].find((group) => group.chatId === chatId);
        if (!projectGroup && threadId) {
          const recovery = await this.recoverProjectBinding(chatId, rawThreadId, rootMessageId);
          projectGroup = recovery.group;
          if (!projectGroup && recovery.candidates.length) {
            await client.im.message.reply({ path: { message_id: rootMessageId }, data: {
              msg_type: 'interactive', content: JSON.stringify(projectBindingRecoveryCard(chatId, recovery.candidates)),
            }});
            return;
          }
        }
        if (projectGroup && /^\/(bind-doc|unbind-doc|docs)(?:\s|$)/.test(text)) {
          const reply = await this.handle(openId, text, client, { chatId }).catch((error) => `执行失败：${formatFeishuError(error)}`);
          await client.im.message.reply({ path: { message_id: rootMessageId }, data: { msg_type: 'text', content: JSON.stringify({ text: String(reply) }) } });
          return;
        }
        if (projectGroup && threadId) {
          try {
            let topic = [...this.sessionTopics.values()].find((item) => item.chatId === chatId && (
              (rawThreadId && item.threadId === rawThreadId)
              || item.rootMessageId === rootMessageId
            ));
            console.info('[feishu-route]', { chatId, rawThreadId, rootMessageId, matchedSessionId: topic?.sessionId ?? null });
            if (!topic) {
              const created = await this.codex.create(projectGroup.projectPath, text);
              if (created.startedTurnId) this.recordBridgeTurn(created.id, created.startedTurnId);
              topic = { sessionId: created.id, chatId, threadId, rootMessageId };
              this.sessionTopics.set(created.id, topic);
              this.targets.set(created.id, { chatId, openId, rootMessageId });
              this.saveState();
              this.tasks.set(created.id, { startedAt: Date.now(), lastActivityAt: Date.now(), status: 'running', lastPrompt: text });
              await this.sendTaskCard(created.id, { chatId, openId, rootMessageId }, 'running');
              return;
            }
            this.targets.set(topic.sessionId, { chatId, openId, rootMessageId: topic.rootMessageId });
            this.saveState();
            if (/^\/(plan|goal|files|skills|apps|context|stop|model|mode|sessions|diff|commit|retry|continue)(?:\s|$)/.test(text)) {
              const reply = await this.handleSessionControl(topic.sessionId, text, { chatId, openId, rootMessageId: topic.rootMessageId });
              const sent = await client.im.message.reply({ path: { message_id: topic.rootMessageId }, data: {
                msg_type: typeof reply === 'string' ? 'text' : 'interactive',
                content: JSON.stringify(typeof reply === 'string' ? { text: reply } : reply),
              }});
              this.rememberControlCard(topic.sessionId, text, sent.data?.message_id);
              return;
            }
            const enriched = this.applyPendingReferences(topic.sessionId, openId, text);
            await this.enqueue(topic.sessionId, enriched, { chatId, openId, rootMessageId: topic.rootMessageId }, true);
            this.clearPendingReferences(topic.sessionId, openId);
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
        const reply = await this.handle(openId, text, client, { chatId }).catch((error) => `执行失败：${formatFeishuError(error)}`);
        const selectedId = this.selected.get(openId);
        if (selectedId && (!text.startsWith('/') || text.startsWith('/new'))) {
          this.targets.set(selectedId, { chatId, openId });
          this.saveState();
        }
        const sentReply = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
          receive_id: chatId,
          msg_type: typeof reply === 'string' ? 'text' : 'interactive',
          content: JSON.stringify(typeof reply === 'string' ? { text: reply } : reply),
        }});
        if (typeof reply !== 'string' && selectedId) {
          const state = this.tasks.get(selectedId);
          if (state && (sentReply as any).data?.message_id) state.cardMessageId = (sentReply as any).data.message_id;
          this.rememberControlCard(selectedId, text, (sentReply as any).data?.message_id);
        }
      },
      'card.action.trigger': async (event: any) => {
        const openId = event.operator?.open_id ?? event.open_id ?? '';
        if (allowed.size && !allowed.has(openId)) return;
        const value = event.action?.value ?? {};
        const projects = await this.getProjects();
        if (value.action === 'projects_page') return cardResponse(projectCard(projects, Number(value.page) || 0));
        if (value.action === 'project_sync') {
          const project = projects.find((item) => item.path === value.projectPath);
          if (!project) return toastResponse('项目不存在或已移动', 'error');
          const group = await this.ensureProjectGroup(client, project, openId);
          let created = 0;
          for (const session of project.sessions) {
            if (!this.sessionTopics.has(session.id) && !this.restoreSessionTopicFromTarget(group, session.id)) {
              await this.ensureSessionTopic(client, group, session.id, session.name || session.preview || '未命名 Session');
              created++;
            }
          }
          this.saveState();
          return toastResponse('已同步 ' + project.name + '，新增 ' + created + ' 个 Session 话题', 'success');
        }
        if (value.action === 'bind_project_confirm') {
          const project = projects.find((item) => item.path === value.projectPath);
          if (!project || !value.chatId) return toastResponse('项目不存在或群信息已失效', 'error');
          this.projectGroups.set(project.path, { projectPath: project.path, projectName: project.name, chatId: value.chatId });
          this.saveState();
          logger.info('project_binding_confirmed', { projectPath: project.path, chatId: value.chatId });
          return toastResponse(`已将当前群绑定到 ${project.name}，请重新发送刚才的消息`, 'success');
        }
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
        if (value.action === 'task_stop') {
          await this.stopTask(value.sessionId);
          return toastResponse('已发送停止指令', 'success');
        }
        if (value.action === 'task_refresh') {
          return cardResponse(await this.taskCard(value.sessionId));
        }
        if (value.action === 'task_retry') {
          const state = this.tasks.get(value.sessionId);
          if (!state?.lastPrompt) return toastResponse('没有可重试的任务', 'error');
          const target = this.targets.get(value.sessionId);
          if (!target) return toastResponse('找不到回复目标', 'error');
          await this.enqueue(value.sessionId, state.lastPrompt, target, false);
          return toastResponse('已加入执行队列', 'success');
        }
        if (value.action === 'model_select') {
          this.setSessionOptions(value.sessionId, { model: value.model });
          return toastResponse(`已选择模型：${value.model}`, 'success');
        }
        if (value.action === 'mode_select') {
          this.setSessionOptions(value.sessionId, { mode: value.mode });
          return toastResponse(`已切换为 ${value.mode === 'plan' ? 'Plan' : 'Default'} 模式`, 'success');
        }
        if (value.action === 'git_commit_confirm') {
          const thread = await this.codex.readThread(value.sessionId);
          const message = String(value.message || 'chore: update from Feishu');
          execFileSync('git', ['add', '-A'], { cwd: thread.cwd });
          const output = execFileSync('git', ['commit', '-m', message], { cwd: thread.cwd, encoding: 'utf8' });
          return toastResponse(output.split('\n')[0] || '已创建 Commit', 'success');
        }
        if (value.action === 'reference_select') {
          const key = `${value.sessionId}:${openId}`;
          const refs = this.pendingReferences.get(key) ?? [];
          const reference: PendingReference = { type: value.referenceType, value: value.referenceValue, label: value.referenceLabel, selectedAt: Date.now() };
          if (!refs.some((item) => item.type === reference.type && item.value === reference.value)) refs.push(reference);
          this.pendingReferences.set(key, refs.slice(-10));
          this.saveState();
          return toastResponse(`已选择 ${formatReference(reference)}，请继续发送任务内容`, 'success');
        }
        if (value.action === 'reference_remove') {
          const key = `${value.sessionId}:${openId}`;
          const refs = (this.pendingReferences.get(key) ?? []).filter((item) => !(item.type === value.referenceType && item.value === value.referenceValue));
          if (refs.length) this.pendingReferences.set(key, refs); else this.pendingReferences.delete(key);
          this.saveState();
          return cardResponse(contextCard(value.sessionId, refs));
        }
        if (value.action === 'reference_clear') {
          this.clearPendingReferences(value.sessionId, openId);
          return cardResponse(contextCard(value.sessionId, []));
        }
        if (value.action === 'plan_refresh') return cardResponse(planCard(value.sessionId, this.plans.get(value.sessionId)));
        if (['goal_pause', 'goal_resume', 'goal_complete', 'goal_clear'].includes(value.action)) {
          if (value.action === 'goal_clear') {
            await this.codex.clearGoal(value.sessionId);
            this.goals.delete(value.sessionId);
            this.saveState();
            return cardResponse(goalCard(value.sessionId, null));
          }
          const status = value.action === 'goal_pause' ? 'paused' : value.action === 'goal_resume' ? 'active' : 'complete';
          const goal = await this.codex.setGoal(value.sessionId, { status });
          this.goals.set(value.sessionId, goal);
          this.saveState();
          return cardResponse(goalCard(value.sessionId, goal));
        }
        if (value.action === 'evaluation_draft_confirm' || value.action === 'evaluation_draft_ignore') {
          if (!this.evaluationDraftHandler) return toastResponse('评估系统尚未启用', 'error');
          await this.evaluationDraftHandler(value.batchId, value.action === 'evaluation_draft_confirm' ? 'confirm' : 'ignore');
          return toastResponse(value.action === 'evaluation_draft_confirm' ? '已确认评估计划草稿' : '已标记为无需评估', 'success');
        }
        if (['evaluation_due_start', 'evaluation_due_postpone', 'evaluation_due_cancel'].includes(value.action)) {
          if (!this.evaluationDueHandler) return toastResponse('评估调度器尚未启用', 'error');
          const action = value.action === 'evaluation_due_start' ? 'start' : value.action === 'evaluation_due_postpone' ? 'postpone' : 'cancel';
          await this.evaluationDueHandler(value.nodeId, action);
          const labels = { start: '已启动评估', postpone: '已延期 7 天', cancel: '已取消评估' };
          return toastResponse(labels[action], 'success');
        }
      },
      'drive.notice.comment_add_v1': async (event: any) => {
        await this.handleCommentEvent(client, event, allowed).catch((error) => logger.error('comment_event_failed', error));
      },
    });
    this.codex.on('notification', async (notification: any) => {
      const threadId = notification.params?.threadId ?? notification.params?.thread?.id;
      if (threadId && notification.method === 'turn/plan/updated') {
        this.plans.set(threadId, { explanation: notification.params?.explanation, plan: notification.params?.plan ?? [] });
        this.saveState();
        this.scheduleControlCardUpdate('plan', threadId);
      }
      if (threadId && notification.method === 'thread/goal/updated' && notification.params?.goal) {
        this.goals.set(threadId, notification.params.goal);
        this.saveState();
        this.scheduleControlCardUpdate('goal', threadId);
      }
      if (threadId && notification.method === 'thread/goal/cleared') {
        this.goals.delete(threadId); this.saveState(); this.scheduleControlCardUpdate('goal', threadId);
      }
      if (threadId) {
        const state = this.tasks.get(threadId);
        if (state) {
          state.lastActivityAt = Date.now();
          state.turnId = notification.params?.turn?.id ?? state.turnId;
          state.detail = summarizeNotification(notification);
          if (notification.method === 'turn/completed') state.status = notification.params?.turn?.status === 'failed' ? 'failed' : notification.params?.turn?.status === 'interrupted' ? 'stopped' : 'completed';
          await this.updateTaskCard(threadId).catch((error) => logger.error('card_update_failed', error, { threadId }));
        }
      }
      if (notification.method !== 'turn/completed') return;
      const completedTurnId = notification.params?.turn?.id;
      // 只有从飞书桥接发起的回合才直接视为已展示。Desktop 发起的
      // 回合必须留给轮询器读取完整的 userMessage + agentMessage。
      if (threadId && completedTurnId && this.stateStore.isCodexReachTurn(threadId, completedTurnId)) {
        const status = notification.params?.turn?.status ?? 'completed';
        this.stateStore.recordTurn({
          eventId: codexEventId(threadId, completedTurnId, 'turn.completed'),
          sessionId: threadId,
          turnId: completedTurnId,
          eventType: 'turn.completed',
          origin: 'codexreach',
          status,
        });
        this.markTurnSynced(threadId, completedTurnId);
      }
      const commentTarget = threadId ? this.commentTargets.get(threadId) : undefined;
      if (threadId && commentTarget) {
        await this.completeCommentRun(threadId, commentTarget, notification.params?.turn).catch((error) => logger.error('comment_reply_failed', error, { threadId }));
        await this.runNextComment(threadId);
        return;
      }
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
        if (turn) await this.sendTurnImages(client, target, turn, threadId, this.tasks.get(threadId)?.startedAt);
      } catch (error) { console.error('[feishu-notify]', error); }
      await this.runNext(threadId);
    });
    const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.info });
    void ws.start({ eventDispatcher: dispatcher });
    this.watchdog = setInterval(() => void this.checkIdleTasks(), 30_000);
    const syncIntervalMs = Math.max(5_000, Number(process.env.FEISHU_DESKTOP_SYNC_INTERVAL_SECONDS ?? 10) * 1_000);
    this.desktopSyncTimer = setInterval(() => void this.syncDesktopSessions(), syncIntervalMs);
    // 启动后先建立已有会话的同步基线，之后只增量回写，避免历史消息刷屏。
    void this.syncDesktopSessions(true);
    return true;
  }

  private async syncDesktopSessions(establishBaseline = false) {
    if (!this.client || this.desktopSyncRunning) return;
    this.desktopSyncRunning = true;
    try {
      const threads = await this.codex.listThreads();
      for (const thread of threads) {
        const group = this.projectGroups.get(thread.cwd);
        if (!group) continue;
        // thread/list 的 turns 通常为空（itemsView=notLoaded），必须读取完整
        // Session 才能发现由 Codex Desktop 产生的新回合。
        const fullThread = await this.codex.readThread(thread.id);
        const completed = fullThread.turns.filter((turn) => turn.status !== 'inProgress');
        const hasSyncState = this.syncedTurns.has(thread.id);
        const known = new Set(this.syncedTurns.get(thread.id) ?? []);
        // 启动建立基线时不得创建话题。否则每次服务重启都会把
        // 所有历史 Session 逐条发到飞书，看起来像机器人自动列项目清单。
        if (establishBaseline && !hasSyncState) {
          this.syncedTurns.set(thread.id, completed.map((turn) => turn.id).slice(-100));
          continue;
        }
        const topicBeforeSync = this.sessionTopics.get(thread.id);
        // 新发现的 Desktop Session 默认同步最近一轮；已有 Session 同步所有新增回合。
        const pending = !hasSyncState
          ? completed.slice(-1)
          : completed.filter((turn) => !known.has(turn.id));
        // 没有新内容时不为历史 Session 补建话题。
        if (!pending.length) continue;
        const topic = topicBeforeSync ?? await this.ensureSessionTopic(this.client, group, thread.id, thread.name || thread.preview || '未命名 Session');
        for (const turn of pending) {
          const messages = formatDesktopTurnMessages(turn);
          if (!messages.length) {
            logger.warn('desktop_turn_content_not_loaded', { sessionId: thread.id, turnId: turn.id, itemTypes: turn.items.map((item: any) => item.type) });
            continue;
          }
          const messageIds: string[] = [];
          for (const text of messages) {
            const sent = await this.client.im.message.reply({ path: { message_id: topic.rootMessageId }, data: {
              msg_type: 'text', content: JSON.stringify({ text }),
            }});
            if (sent.data?.message_id) messageIds.push(sent.data.message_id);
          }
          await this.sendTurnImages(this.client, { chatId: topic.chatId, openId: '', rootMessageId: topic.rootMessageId }, turn, thread.id);
          logger.info('desktop_turn_synced', { sessionId: thread.id, turnId: turn.id, messageIds, messageCount: messages.length, rootMessageId: topic.rootMessageId });
          this.markTurnSynced(thread.id, turn.id);
        }
      }
      this.saveState();
    } catch (error) {
      logger.error('desktop_session_sync_failed', error);
    } finally {
      this.desktopSyncRunning = false;
    }
  }

  private markTurnSynced(sessionId: string, turnId: string) {
    const ids = this.syncedTurns.get(sessionId) ?? [];
    if (!ids.includes(turnId)) ids.push(turnId);
    this.syncedTurns.set(sessionId, ids.slice(-100));
    this.saveState();
  }

  async handle(user: string, input: string, client?: lark.Client, context?: { chatId?: string }): Promise<Reply> {
    const [command, ...rest] = input.split(/\s+/);
    if (command === '/bind-doc') {
      const group = [...this.projectGroups.values()].find((item) => item.chatId === context?.chatId);
      if (!group) return '请在已同步的 CodexReach Project 群中执行 /bind-doc <飞书文档链接>。';
      const parsed = parseDocumentUrl(rest[0] ?? '');
      if (!parsed) return '目前只支持 doc/docx 文档链接。\n用法：/bind-doc <飞书文档链接>';
      const binding: DocumentBinding = { ...parsed, projectPath: group.projectPath, projectName: group.projectName };
      this.documentBindings.set(parsed.fileToken, binding); this.saveState();
      logger.info('document_bound', { fileToken: digest(parsed.fileToken), projectPath: group.projectPath });
      return `文档已绑定到 Project：${group.projectName}\n${group.projectPath}\n\n之后在该文档评论中 @Bot 即可创建 Codex 任务。`;
    }
    if (command === '/unbind-doc') {
      const parsed = parseDocumentUrl(rest[0] ?? '');
      if (!parsed) return '用法：/unbind-doc <飞书文档链接>';
      const binding = this.documentBindings.get(parsed.fileToken);
      const group = [...this.projectGroups.values()].find((item) => item.chatId === context?.chatId);
      if (!binding || !group || binding.projectPath !== group.projectPath) return '没有找到当前 Project 对该文档的绑定。';
      this.documentBindings.delete(parsed.fileToken); this.saveState();
      return '已解除文档绑定。';
    }
    if (command === '/docs') {
      const group = [...this.projectGroups.values()].find((item) => item.chatId === context?.chatId);
      if (!group) return '请在 CodexReach Project 群中使用 /docs。';
      const bindings = [...this.documentBindings.values()].filter((item) => item.projectPath === group.projectPath);
      return bindings.length ? `Project：${group.projectName}\n\n${bindings.map((item, index) => `${index + 1}. ${item.url}`).join('\n')}` : '当前 Project 尚未绑定飞书文档。';
    }
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
          if (!this.sessionTopics.has(session.id) && !this.restoreSessionTopicFromTarget(group, session.id)) {
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
        if (!this.sessionTopics.has(session.id) && !this.restoreSessionTopicFromTarget(group, session.id)) {
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
      if (!id) {
        const health = await this.codex.health();
        return `桥接状态：${health.online ? '正常' : '异常'}\nCodex：${health.online ? `在线（${health.latencyMs}ms）` : health.error}\n运行任务：${[...this.tasks.values()].filter((x) => x.status === 'running').length}\n排队消息：${[...this.queues.values()].reduce((n, q) => n + q.length, 0)}`;
      }
      return this.taskCard(id);
    }
    if (command === '/doctor') return this.doctor();
    if (command === '/new') {
      const raw = input.slice('/new'.length).trim();
      const parsed = parseNewCommand(raw);
      if (!parsed?.cwd || !parsed.prompt) return '用法：/new <绝对路径> <任务>；项目目录必须存在，路径含空格时可直接输入或使用引号。';
      const { cwd, prompt } = parsed;
      const thread = await this.codex.create(cwd, prompt);
      if (thread.startedTurnId) this.recordBridgeTurn(thread.id, thread.startedTurnId);
      this.selected.set(user, thread.id); this.tasks.set(thread.id, { startedAt: Date.now(), lastActivityAt: Date.now(), status: 'running', lastPrompt: prompt }); this.saveState();
      return this.taskCard(thread.id);
    }
    if (command === '/stop') { const id = this.selected.get(user); if (!id) return '请先用 /use 选择 Session'; await this.stopTask(id); return '已发送停止指令'; }
    if (['/plan', '/goal', '/files', '/skills', '/apps', '/context', '/model', '/mode', '/sessions', '/diff', '/commit', '/retry', '/continue'].includes(command)) {
      const id = this.selected.get(user); if (!id) return '请先用 /use 选择 Session';
      return this.handleSessionControl(id, input, this.targets.get(id) ?? { chatId: '', openId: user });
    }
    if (command === '/help') return '/sessions：查看和切换 Session\n/stop：中止当前任务\n/retry：重试上一条任务\n/continue [指令]：恢复失败任务或向运行中任务追加指令\n/model [模型 ID]：查看或选择模型\n/mode [default|plan]：切换执行模式\n/diff：查看 Git 变更\n/commit [提交说明]：预览并确认提交\n/files、/skills、/apps、/context、/plan、/goal：上下文与计划控制\n\n支持直接发送飞书图片、文件、@相对路径 和 $Skill。';
    const id = this.selected.get(user); if (!id) return '请先发送 /sessions，再用 /use <session-id> 选择会话。';
    const target = this.targets.get(id) ?? { chatId: '', openId: user };
    const enriched = this.applyPendingReferences(id, user, input);
    await this.enqueue(id, enriched, target, false);
    this.clearPendingReferences(id, user);
    return this.taskCard(id);
  }

  private async handleSessionControl(sessionId: string, input: string, target: Target): Promise<Reply> {
    const [command, action = '', ...rest] = input.trim().split(/\s+/);
    if (command === '/stop') { await this.stopTask(sessionId); return '已发送停止指令。'; }
    if (command === '/retry') {
      const state = this.tasks.get(sessionId);
      if (!state?.lastPrompt) return '没有可重试的上一条任务。';
      await this.enqueue(sessionId, state.lastPrompt, target, true); return this.taskCard(sessionId);
    }
    if (command === '/continue') {
      const instruction = [action, ...rest].join(' ').trim() || '继续上一个任务，从中断或失败处恢复，不要重复已完成的工作。';
      const state = this.tasks.get(sessionId);
      if (state?.status === 'running') await this.codex.steer(sessionId, instruction);
      else await this.enqueue(sessionId, instruction, target, true);
      return this.taskCard(sessionId);
    }
    if (command === '/model') {
      if (action) {
        const model = (await this.codex.listModels()).find((item) => item.id === action || item.model === action);
        if (!model) return `未找到模型：${action}`;
        this.setSessionOptions(sessionId, { model: model.model });
        return `已选择模型：${model.displayName}（${model.model}）`;
      }
      return modelCard(sessionId, await this.codex.listModels(), this.codex.getSessionOptions(sessionId).model);
    }
    if (command === '/mode') {
      if (action === 'plan' || action === 'default') {
        this.setSessionOptions(sessionId, { mode: action });
        return `已切换为 ${action === 'plan' ? 'Plan' : 'Default'} 模式。`;
      }
      return modeCard(sessionId, this.codex.getSessionOptions(sessionId).mode ?? 'default');
    }
    if (command === '/sessions') {
      const thread = await this.codex.readThread(sessionId);
      const project = (await this.getProjects()).find((item) => item.path === thread.cwd);
      return project ? sessionCard(project, 0) : '当前项目没有可用 Session。';
    }
    if (command === '/diff') {
      const thread = await this.codex.readThread(sessionId);
      let output = execFileSync('git', ['diff', '--stat'], { cwd: thread.cwd, encoding: 'utf8' }).trim();
      const detail = execFileSync('git', ['diff', '--no-ext-diff', '--unified=2'], { cwd: thread.cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
      if (!output && !detail) return gitDiffCard(sessionId, '当前没有未提交变更。');
      return gitDiffCard(sessionId, `${output}\n\n${detail}`.slice(0, 12000));
    }
    if (command === '/commit') {
      const message = [action, ...rest].join(' ').trim() || 'chore: update from Feishu';
      const thread = await this.codex.readThread(sessionId);
      const status = execFileSync('git', ['status', '--short'], { cwd: thread.cwd, encoding: 'utf8' }).trim();
      if (!status) return '当前没有可提交变更。';
      return commitCard(sessionId, message, status);
    }
    if (command === '/context') {
      if (action === 'clear') {
        this.clearPendingReferences(sessionId, target.openId);
        return contextCard(sessionId, []);
      }
      return contextCard(sessionId, this.getPendingReferences(sessionId, target.openId));
    }
    if (command === '/files') {
      const thread = await this.codex.readThread(sessionId);
      const files = searchProjectFiles(thread.cwd, [action, ...rest].join(' ').trim());
      return referenceCard('文件', sessionId, files.map((value) => ({ type: 'file' as const, value })));
    }
    if (command === '/skills') {
      const thread = await this.codex.readThread(sessionId);
      const query = [action, ...rest].join(' ').trim().toLowerCase();
      const skills = (await this.codex.listSkills(thread.cwd)).filter((item) => item.enabled !== false && (!query || item.name.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query))).slice(0, 20);
      return referenceCard('Skills', sessionId, skills.map((item) => ({ type: 'skill' as const, value: item.name, description: item.description })));
    }
    if (command === '/apps') {
      const query = [action, ...rest].join(' ').trim().toLowerCase();
      // App discovery is catalog-level and must keep working when a persisted Feishu
      // session has not yet been restored into the freshly restarted App Server.
      const apps = await this.codex.listApps(undefined, { query, limit: 20 });
      return appCard(sessionId, apps);
    }
    if (command === '/plan') {
      const task = input.slice('/plan'.length).trim();
      if (task) {
        const prompt = `请先进入规划：使用 update_plan 制定清晰的分步计划；除非为了制定可执行计划所必需，否则先不要修改文件或执行实现。\n\n任务：${task}`;
        await this.enqueue(sessionId, prompt, target, true);
        return this.taskCard(sessionId);
      }
      return planCard(sessionId, this.plans.get(sessionId));
    }
    if (command !== '/goal') return '不支持的控制命令。';
    if (!action || action === 'show') {
      const goal = await this.codex.getGoal(sessionId);
      if (goal) this.goals.set(sessionId, goal);
      return goalCard(sessionId, goal);
    }
    if (action === 'create' || action === 'set') {
      const raw = rest.join(' ');
      const budgetMatch = raw.match(/(?:^|\s)--budget\s+(\d+)(?:\s|$)/);
      const objective = raw.replace(/(?:^|\s)--budget\s+\d+(?=\s|$)/, ' ').trim();
      if (!objective) return '用法：/goal create <目标> [--budget 数字]';
      const goal = await this.codex.setGoal(sessionId, { objective, status: 'active', tokenBudget: budgetMatch ? Number(budgetMatch[1]) : undefined });
      this.goals.set(sessionId, goal);
      return goalCard(sessionId, goal);
    }
    if (action === 'clear') {
      await this.codex.clearGoal(sessionId); this.goals.delete(sessionId);
      return 'Goal 已清除。';
    }
    const statuses: Record<string, ThreadGoal['status']> = { pause: 'paused', resume: 'active', complete: 'complete' };
    if (statuses[action]) {
      const goal = await this.codex.setGoal(sessionId, { status: statuses[action] });
      this.goals.set(sessionId, goal);
      return goalCard(sessionId, goal);
    }
    return '用法：/goal；/goal create <目标> [--budget 数字]；/goal pause|resume|complete|clear';
  }

  private getPendingReferences(sessionId: string, openId: string): PendingReference[] {
    const key = `${sessionId}:${openId}`;
    const cutoff = Date.now() - 30 * 60_000;
    const refs = (this.pendingReferences.get(key) ?? []).filter((item) => (item.selectedAt ?? Date.now()) >= cutoff);
    if (refs.length) this.pendingReferences.set(key, refs); else this.pendingReferences.delete(key);
    return refs;
  }

  private applyPendingReferences(sessionId: string, openId: string, text: string): string {
    const refs = this.getPendingReferences(sessionId, openId);
    if (!refs.length) return text;
    const prefix = refs.map(formatReference).join(' ');
    return `${prefix}\n${text}`;
  }

  private clearPendingReferences(sessionId: string, openId: string) {
    this.pendingReferences.delete(`${sessionId}:${openId}`);
    this.saveState();
  }

  private setSessionOptions(sessionId: string, options: { model?: string; mode?: 'default' | 'plan' }) {
    const next = { ...(this.sessionOptions.get(sessionId) ?? {}), ...options };
    this.sessionOptions.set(sessionId, next);
    this.codex.setSessionOptions(sessionId, next);
    this.saveState();
  }

  private rememberControlCard(sessionId: string, input: string, messageId?: string) {
    if (!messageId) return;
    if (/^\/plan(?:\s|$)/.test(input)) this.planCardMessages.set(sessionId, messageId);
    if (/^\/goal(?:\s|$)/.test(input)) this.goalCardMessages.set(sessionId, messageId);
    this.saveState();
  }

  private scheduleControlCardUpdate(type: 'plan' | 'goal', sessionId: string) {
    if (!this.client) return;
    const key = `${type}:${sessionId}`;
    clearTimeout(this.controlCardTimers.get(key));
    this.controlCardTimers.set(key, setTimeout(() => {
      this.controlCardTimers.delete(key);
      void this.updateControlCard(type, sessionId).catch((error) => logger.error('control_card_update_failed', error, { type, sessionId }));
    }, 900));
  }

  private async updateControlCard(type: 'plan' | 'goal', sessionId: string) {
    if (!this.client) return;
    const messageId = (type === 'plan' ? this.planCardMessages : this.goalCardMessages).get(sessionId);
    if (!messageId) return;
    const content = type === 'plan' ? planCard(sessionId, this.plans.get(sessionId)) : goalCard(sessionId, this.goals.get(sessionId) ?? null);
    await (this.client.im.message as any).patch({ path: { message_id: messageId }, data: { content: JSON.stringify(content) } });
  }

  private async enqueue(sessionId: string, text: string, target: Target, createCard = true) {
    this.targets.set(sessionId, target);
    const current = this.tasks.get(sessionId);
    if (current?.status === 'running') {
      const queue = this.queues.get(sessionId) ?? [];
      const last = queue.at(-1);
      if (last && Date.now() - last.at < 1_500) last.text += `\n${text}`;
      else queue.push({ text, target, at: Date.now() });
      this.queues.set(sessionId, queue);
      logger.info('message_queued', { sessionId, queueLength: queue.length });
      await this.updateTaskCard(sessionId);
      return;
    }
    const state: TaskState = { startedAt: Date.now(), lastActivityAt: Date.now(), status: 'running', lastPrompt: text };
    this.tasks.set(sessionId, state);
    const started = await this.codex.send(sessionId, text);
    if (started?.turn?.id) this.recordBridgeTurn(sessionId, started.turn.id);
    if (createCard) await this.sendTaskCard(sessionId, target, 'running');
  }

  private async runNext(sessionId?: string) {
    if (!sessionId) return;
    const queue = this.queues.get(sessionId);
    if (!queue?.length) return;
    const next = queue.shift()!;
    if (!queue.length) this.queues.delete(sessionId);
    const state: TaskState = { startedAt: Date.now(), lastActivityAt: Date.now(), status: 'running', lastPrompt: next.text, cardMessageId: this.tasks.get(sessionId)?.cardMessageId };
    this.tasks.set(sessionId, state);
    try { const started = await this.codex.send(sessionId, next.text); if (started?.turn?.id) this.recordBridgeTurn(sessionId, started.turn.id); await this.updateTaskCard(sessionId); }
    catch (error) { state.status = 'failed'; state.detail = formatCodexSubmitError(error); await this.updateTaskCard(sessionId); }
  }

  private async stopTask(sessionId: string) {
    const thread = await this.codex.readThread(sessionId);
    const turn = [...thread.turns].reverse().find((item) => item.status === 'inProgress');
    if (!turn) throw new Error('当前没有运行中的任务');
    await this.codex.interrupt(sessionId, turn.id);
    const state = this.tasks.get(sessionId); if (state) state.status = 'stopped';
    this.queues.delete(sessionId);
    await this.updateTaskCard(sessionId);
  }

  private async sendTaskCard(sessionId: string, target: Target, _status: TaskState['status']) {
    if (!this.client || !target.chatId) return;
    const content = JSON.stringify(await this.taskCard(sessionId));
    const result = target.rootMessageId
      ? await this.client.im.message.reply({ path: { message_id: target.rootMessageId }, data: { msg_type: 'interactive', content } })
      : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: target.chatId, msg_type: 'interactive', content } });
    const messageId = (result as any).data?.message_id;
    const state = this.tasks.get(sessionId); if (state && messageId) state.cardMessageId = messageId;
  }

  private async updateTaskCard(sessionId: string) {
    const state = this.tasks.get(sessionId);
    if (!state?.cardMessageId || !this.client) return;
    await (this.client.im.message as any).patch({ path: { message_id: state.cardMessageId }, data: { content: JSON.stringify(await this.taskCard(sessionId)) } });
  }

  private async taskCard(sessionId: string): Promise<Card> {
    const state = this.tasks.get(sessionId);
    let detail = state?.detail;
    if (!detail) try { detail = formatStatus(await this.codex.readThread(sessionId)); } catch { detail = '正在读取任务状态…'; }
    const status = state?.status ?? 'completed';
    const labels: Record<string, string> = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', timeout: '已超时' };
    const queued = this.queues.get(sessionId)?.length ?? 0;
    const elapsed = state ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000)) : 0;
    const actions: Array<Record<string, unknown>> = [
      { tag: 'button', text: { tag: 'plain_text', content: '刷新' }, value: { action: 'task_refresh', sessionId } },
    ];
    if (status === 'running') actions.unshift({ tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '停止' }, value: { action: 'task_stop', sessionId } });
    if (status === 'failed' || status === 'timeout') actions.unshift({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '重试' }, value: { action: 'task_retry', sessionId } });
    return { config: { wide_screen_mode: true, update_multi: true }, header: { template: status === 'failed' || status === 'timeout' ? 'red' : status === 'completed' ? 'green' : 'blue', title: { tag: 'plain_text', content: `Codex · ${labels[status] ?? status}` } }, elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**Session**\n${sessionId}\n\n**运行时间** ${elapsed}s　**队列** ${queued}` } },
      { tag: 'div', text: { tag: 'lark_md', content: String(detail).slice(0, 3000) } },
      { tag: 'action', actions },
    ] };
  }

  private async doctor(): Promise<string> {
    const health = await this.codex.health();
    const checks = [
      `Codex App Server：${health.online ? `正常（${health.latencyMs}ms）` : `异常：${health.error}`}`,
      `飞书长连接：${this.client ? '已初始化' : '未初始化'}`,
      `状态数据库：${fs.existsSync(this.stateStore.databasePath) ? '可用' : '尚未创建'}`,
      `附件目录：${this.ensureMediaDir()}`,
      `运行任务：${[...this.tasks.values()].filter((x) => x.status === 'running').length}`,
      `排队消息：${[...this.queues.values()].reduce((n, q) => n + q.length, 0)}`,
    ];
    logger.info('doctor', { online: health.online });
    return `诊断结果（不含凭据）\n\n${checks.map((x) => `• ${x}`).join('\n')}`;
  }

  private async checkIdleTasks() {
    const timeoutMs = Number(process.env.FEISHU_IDLE_TIMEOUT_MINUTES ?? 15) * 60_000;
    if (!timeoutMs) return;
    for (const [sessionId, state] of this.tasks) {
      if (state.status !== 'running' || Date.now() - state.lastActivityAt < timeoutMs) continue;
      state.status = 'timeout'; state.detail = `超过 ${Math.round(timeoutMs / 60_000)} 分钟没有新事件，已自动停止。`;
      try { await this.stopTask(sessionId); state.status = 'timeout'; } catch { /* turn may already be done */ }
      await this.updateTaskCard(sessionId).catch(() => undefined);
      logger.warn('task_idle_timeout', { sessionId });
    }
  }

  private async handleCommentEvent(client: lark.Client, event: any, allowed: Set<string>) {
    const fileToken = event.notice_meta?.file_token;
    const fileType = event.notice_meta?.file_type;
    const openId = event.notice_meta?.from_user_id?.open_id ?? '';
    const commentId = event.comment_id;
    const replyId = event.reply_id;
    const dedupeKey = `${event.event_id ?? event.uuid ?? ''}:${fileToken}:${commentId}:${replyId ?? ''}`;
    if (!event.is_mentioned || !fileToken || !commentId || !['doc', 'docx'].includes(fileType)) return;
    if (!allowed.size || !allowed.has(openId)) {
      logger.warn('comment_unauthorized', { openId, fileToken: digest(fileToken) });
      return;
    }
    if (this.handledComments.includes(dedupeKey)) return;
    const binding = this.documentBindings.get(fileToken);
    // 事件中的 file_type 对新版文档仍可能返回旧值 `doc`，Drive API 则要求
    // 与文档 URL 一致的 `docx`。已绑定文档以绑定时解析出的类型为准。
    const apiFileType: 'doc' | 'docx' = binding?.fileType ?? fileType;
    const target: CommentTarget = { fileToken, fileType: apiFileType, commentId, replyId, openId };
    if (!binding) {
      await this.postCommentReply(client, target, '该文档尚未绑定 Codex Project。请在目标 CodexReach Project 群中发送：\n/bind-doc <当前文档链接>');
      this.markCommentHandled(dedupeKey);
      return;
    }
    // 评论新增事件有时会先于 Drive 评论数据完成复制，短时间内读取会返回 400。
    // 重试可避免把一次暂时性失败永久写入去重记录。
    let response: Awaited<ReturnType<typeof client.drive.fileComment.get>> | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        response = await client.drive.fileComment.get({ path: { file_token: fileToken, comment_id: commentId }, params: { file_type: apiFileType, user_id_type: 'open_id' } });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
    if (!response) throw lastError;
    if (response.code) throw new Error(`读取评论失败：${response.msg}`);
    const replies = response.data?.reply_list?.replies ?? [];
    const targetReply = (replyId ? replies.find((item) => item.reply_id === replyId) : undefined) ?? replies.at(-1);
    const question = commentElementsText(targetReply?.content?.elements ?? []);
    if (!question) {
      this.markCommentHandled(dedupeKey);
      return;
    }
    const targetIndex = targetReply ? replies.indexOf(targetReply) : replies.length;
    const priorReplies = replies.slice(0, Math.max(0, targetIndex)).map((item) => commentElementsText(item.content?.elements ?? [])).filter(Boolean).slice(-8);
    const prompt = buildCommentPrompt(binding, question, response.data?.quote, priorReplies);
    const scope = `${fileToken}:${commentId}`;
    const existingSession = this.commentSessions.get(scope);
    if (existingSession && this.tasks.get(existingSession)?.status === 'running') {
      const queue = this.commentQueues.get(existingSession) ?? [];
      queue.push(prompt); this.commentQueues.set(existingSession, queue); this.saveState();
      await this.postCommentReply(client, target, `当前评论线程已有任务运行，本条已排队（前方 ${queue.length - 1} 条）。`);
      this.markCommentHandled(dedupeKey);
      return;
    }
    let sessionId = existingSession;
    if (sessionId) {
      const started = await this.codex.send(sessionId, prompt);
      if (started?.turn?.id) this.recordBridgeTurn(sessionId, started.turn.id);
    } else {
      const thread = await this.codex.create(binding.projectPath, prompt);
      if (thread.startedTurnId) this.recordBridgeTurn(thread.id, thread.startedTurnId);
      sessionId = thread.id;
      this.commentSessions.set(scope, thread.id);
    }
    if (!sessionId) throw new Error('未能创建评论 Session');
    this.commentTargets.set(sessionId, target);
    this.tasks.set(sessionId, { startedAt: Date.now(), lastActivityAt: Date.now(), status: 'running', lastPrompt: prompt });
    this.markCommentHandled(dedupeKey);
    this.saveState();
    logger.info('comment_run_started', { threadId: sessionId, fileToken: digest(fileToken), projectPath: binding.projectPath });
  }

  private markCommentHandled(dedupeKey: string) {
    if (!this.handledComments.includes(dedupeKey)) this.handledComments.push(dedupeKey);
    this.handledComments = this.handledComments.slice(-500);
    this.saveState();
  }

  private async completeCommentRun(threadId: string, target: CommentTarget, turn?: any) {
    const state = this.tasks.get(threadId);
    const failed = turn?.status === 'failed';
    const answer = extractAgentAnswer(turn) || state?.detail || (failed ? '任务执行失败，请稍后重试。' : '任务已完成。');
    const prefix = failed ? '⚠️ Codex 执行失败\n\n' : '✅ Codex 已完成\n\n';
    await this.postCommentReply(this.client!, target, `${prefix}${answer}`.slice(0, 1900));
    logger.info('comment_run_completed', { threadId, status: turn?.status ?? 'completed' });
  }

  private async runNextComment(threadId: string) {
    const queue = this.commentQueues.get(threadId);
    if (!queue?.length) return;
    const prompt = queue.shift()!;
    if (!queue.length) this.commentQueues.delete(threadId);
    this.saveState();
    const state: TaskState = { startedAt: Date.now(), lastActivityAt: Date.now(), status: 'running', lastPrompt: prompt };
    this.tasks.set(threadId, state);
    try { const started = await this.codex.send(threadId, prompt); if (started?.turn?.id) this.recordBridgeTurn(threadId, started.turn.id); }
    catch (error) {
      state.status = 'failed'; state.detail = formatCodexSubmitError(error);
      const target = this.commentTargets.get(threadId);
      if (target && this.client) await this.postCommentReply(this.client, target, `⚠️ 排队任务启动失败\n\n${state.detail}`);
    }
  }

  private async postCommentReply(client: lark.Client, target: CommentTarget, text: string) {
    const content = { elements: [{ type: 'text_run' as const, text_run: { text: text.slice(0, 2000) } }] };
    try {
      const result = await client.drive.fileCommentReply.create({
        path: { file_token: target.fileToken, comment_id: target.commentId },
        params: { file_type: target.fileType, user_id_type: 'open_id' },
        data: { content },
      });
      if (result.code) throw new Error(`回复评论失败：${result.msg}`);
    } catch (error: any) {
      const code = error?.response?.data?.code;
      if (code !== 1069302) throw error;
      // 部分新版文档允许创建全文评论，但关闭了评论内回复。此时退化为
      // 新建一条全文评论，确保接收确认和最终结果仍能回写到同一文档。
      const result = await client.drive.fileComment.create({
        path: { file_token: target.fileToken },
        params: { file_type: target.fileType, user_id_type: 'open_id' },
        data: { reply_list: { replies: [{ content }] } },
      });
      if (result.code) throw new Error(`创建回执评论失败：${result.msg}`);
      logger.warn('comment_reply_fallback_created', { commentId: target.commentId, fallbackCommentId: result.data?.comment_id });
    }
  }

  private ensureMediaDir() {
    const dir = path.resolve('.data/media');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async sendTurnImages(client: lark.Client, target: Target, turn: any, threadId?: string, startedAt?: number) {
    for (const imagePath of extractTurnImagePaths(turn, threadId, startedAt)) {
      try {
        const uploaded: any = await client.im.v1.image.create({ data: { image_type: 'message', image: fs.createReadStream(imagePath) } });
        const imageKey = uploaded?.image_key ?? uploaded?.data?.image_key;
        if (!imageKey) throw new Error('飞书上传图片未返回 image_key');
        const data = { msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) };
        if (target.rootMessageId) await client.im.message.reply({ path: { message_id: target.rootMessageId }, data });
        else await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: target.chatId, ...data } });
        logger.info('turn_image_sent', { imagePath, threadRootMessageId: target.rootMessageId });
      } catch (error) {
        logger.error('turn_image_send_failed', error, { imagePath });
      }
    }
  }

  private async parseIncomingMessage(client: lark.Client, message: any, messageType: string): Promise<string> {
    let content: any = {};
    try { content = JSON.parse(message.content ?? '{}'); } catch { return ''; }
    if (messageType === 'text') return content.text?.trim() ?? '';
    // 在飞书编辑器里粘贴图片后，消息会由 text/image 变成富文本 post。
    // post 中的图片仍然需要通过 messageResource 下载，不能只读取文本，否则
    // 纯图片消息会被当成空消息，而“图片 + /new”也会丢失附件。
    if (messageType === 'post') {
      const localeContent = content.zh_cn ?? content.en_us ?? content.ja_jp ?? content;
      const paragraphs = Array.isArray(localeContent?.content) ? localeContent.content : [];
      const parts: string[] = [];
      if (typeof localeContent?.title === 'string' && localeContent.title.trim()) parts.push(localeContent.title.trim());
      for (const paragraph of paragraphs) {
        const line: string[] = [];
        for (const element of Array.isArray(paragraph) ? paragraph : []) {
          if ((element?.tag === 'text' || element?.tag === 'a') && typeof element.text === 'string') line.push(element.text);
          if (element?.tag === 'at' && element.user_name) line.push(`@${element.user_name}`);
          const imageKey = element?.image_key ?? element?.img_key;
          if ((element?.tag === 'img' || imageKey) && imageKey) {
            const localPath = await this.downloadMessageResource(client, message, imageKey, 'image');
            if (localPath) line.push(`\n请处理我粘贴的图片。本地路径：${localPath}\n`);
          }
        }
        if (line.join('').trim()) parts.push(line.join('').trim());
      }
      return parts.join('\n').trim();
    }
    const key = content.file_key ?? content.image_key;
    if (!key || !['file', 'image', 'audio', 'media'].includes(messageType)) return '';
    const safeName = path.basename(content.file_name || `${messageType}-${Date.now()}${messageType === 'image' ? '.png' : ''}`).replace(/[^\p{L}\p{N}._-]+/gu, '_');
    const sessionDir = path.join(this.ensureMediaDir(), String(message.chat_id || 'unknown'));
    fs.mkdirSync(sessionDir, { recursive: true });
    const destination = path.join(sessionDir, `${Date.now()}-${safeName}`);
    try {
      const api: any = (client.im as any).messageResource;
      const response = await api.get({ path: { message_id: message.message_id, file_key: key }, params: { type: messageType === 'image' ? 'image' : 'file' } });
      const payload = response?.data ?? response;
      if (Buffer.isBuffer(payload)) fs.writeFileSync(destination, payload);
      else if (payload?.writeFile) await payload.writeFile(destination);
      else if (payload?.getReadableStream) {
        const chunks: Buffer[] = [];
        for await (const chunk of payload.getReadableStream()) chunks.push(Buffer.from(chunk));
        fs.writeFileSync(destination, Buffer.concat(chunks));
      } else throw new Error('飞书未返回可写入的附件内容');
      logger.info('attachment_downloaded', { messageType, destination });
      return `请处理我发送的${messageType === 'image' ? '图片' : '文件'}。本地路径：${destination}${content.file_name ? `\n原文件名：${content.file_name}` : ''}`;
    } catch (error) {
      logger.error('attachment_download_failed', error, { messageType });
      if (this.client && message.message_id) await this.client.im.message.reply({ path: { message_id: message.message_id }, data: { msg_type: 'text', content: JSON.stringify({ text: `❌ 附件下载失败：${formatFeishuError(error)}` }) } }).catch(() => undefined);
      return '';
    }
  }

  private async downloadMessageResource(client: lark.Client, message: any, key: string, type: 'image' | 'file'): Promise<string> {
    const safeName = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${type === 'image' ? '.png' : ''}`;
    const sessionDir = path.join(this.ensureMediaDir(), String(message.chat_id || 'unknown'));
    fs.mkdirSync(sessionDir, { recursive: true });
    const destination = path.join(sessionDir, safeName);
    try {
      const api: any = (client.im as any).messageResource;
      const response = await api.get({ path: { message_id: message.message_id, file_key: key }, params: { type } });
      const payload = response?.data ?? response;
      if (Buffer.isBuffer(payload)) fs.writeFileSync(destination, payload);
      else if (payload?.writeFile) await payload.writeFile(destination);
      else if (payload?.getReadableStream) {
        const chunks: Buffer[] = [];
        for await (const chunk of payload.getReadableStream()) chunks.push(Buffer.from(chunk));
        fs.writeFileSync(destination, Buffer.concat(chunks));
      } else throw new Error('飞书未返回可写入的附件内容');
      logger.info('attachment_downloaded', { messageType: type, destination, richText: true });
      return destination;
    } catch (error) {
      logger.error('attachment_download_failed', error, { messageType: type, richText: true });
      return '';
    }
  }

  private async getProjects(refresh = false) {
    if (!refresh && this.projectsCache && Date.now() - this.projectsCache.at < 30_000) return this.projectsCache.projects;
    const projects = groupProjects(await this.codex.listThreads());
    this.projectsCache = { at: Date.now(), projects };
    return projects;
  }

  private async recoverProjectBinding(chatId: string, threadId: string, rootMessageId: string): Promise<{ group?: ProjectGroup; candidates: Project[] }> {
    const evidence = new Set<string>();
    for (const [sessionId, target] of this.targets) {
      if (target.chatId !== chatId) continue;
      try { evidence.add((await this.codex.readThread(sessionId)).cwd); } catch { /* 历史会话可能已归档或不可读 */ }
    }
    for (const topic of this.sessionTopics.values()) {
      if (topic.chatId !== chatId) continue;
      try { evidence.add((await this.codex.readThread(topic.sessionId)).cwd); } catch { /* 同上 */ }
    }
    const projects = await this.getProjects(true);
    const candidates = projects.filter((project) => evidence.has(project.path));
    if (candidates.length !== 1) {
      logger.warn('project_binding_recovery_ambiguous', { chatId, candidatePaths: candidates.map((item) => item.path), evidencePaths: [...evidence] });
      return { candidates: candidates.length ? candidates : projects.slice(0, 20) };
    }
    const project = candidates[0];
    const group = { projectPath: project.path, projectName: project.name, chatId };
    this.projectGroups.set(project.path, group);
    for (const [sessionId, target] of this.targets) {
      if (target.chatId !== chatId || target.rootMessageId !== rootMessageId) continue;
      this.sessionTopics.set(sessionId, { sessionId, chatId, threadId, rootMessageId });
    }
    this.saveState();
    logger.info('project_binding_recovered', { projectPath: project.path, chatId, evidenceCount: evidence.size });
    return { group, candidates };
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
    const restored = this.restoreSessionTopicFromTarget(group, sessionId);
    if (restored) return restored;
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

  private restoreSessionTopicFromTarget(group: ProjectGroup, sessionId: string): SessionTopic | undefined {
    const target = this.targets.get(sessionId);
    if (!target?.rootMessageId || target.chatId !== group.chatId) return undefined;
    // 历史 target 已保存飞书话题根消息。即使 thread_id 丢失，rootMessageId 也足以稳定路由回复。
    const topic = { sessionId, chatId: group.chatId, threadId: '', rootMessageId: target.rootMessageId };
    this.sessionTopics.set(sessionId, topic);
    logger.info('session_topic_recovered', { sessionId, chatId: group.chatId, rootMessageId: target.rootMessageId });
    return topic;
  }

  private async ensureEvaluationHubTopic(client: lark.Client, group: ProjectGroup): Promise<SessionTopic> {
    const existing = this.evaluationHubTopics.get(group.projectPath);
    if (existing) return existing;
    const sent = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
      receive_id: group.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: '部署与评估\n\n本话题由 CodexReach 自动创建，用于处理无法关联原 Codex Session 的部署、评估确认和异常。' }),
      uuid: `codex-evaluation-hub-${Buffer.from(group.projectPath).toString('base64url')}`.slice(0, 50),
    }});
    if (sent.code || !sent.data?.message_id || !sent.data.thread_id) throw new Error(`创建部署与评估话题失败：${sent.msg ?? '未返回 thread_id'}`);
    const topic = { sessionId: `evaluation-hub:${group.projectPath}`, chatId: group.chatId, threadId: sent.data.thread_id, rootMessageId: sent.data.message_id };
    this.evaluationHubTopics.set(group.projectPath, topic);
    this.saveState();
    return topic;
  }

  private async resolveEvaluationTopic(client: lark.Client, group: ProjectGroup, sourceSessionId?: string): Promise<SessionTopic> {
    return (sourceSessionId ? this.sessionTopics.get(sourceSessionId) : undefined)
      ?? this.ensureEvaluationHubTopic(client, group);
  }

  private async ensureEvaluationTasklist(client: lark.Client): Promise<string> {
    if (this.evaluationTasklistGuid) return this.evaluationTasklistGuid;
    if (this.evaluationTasklistPromise) return this.evaluationTasklistPromise;
    this.evaluationTasklistPromise = this.findOrCreateEvaluationTasklist(client);
    try { return await this.evaluationTasklistPromise; }
    finally { this.evaluationTasklistPromise = undefined; }
  }

  private async findOrCreateEvaluationTasklist(client: lark.Client): Promise<string> {
    let pageToken: string | undefined;
    do {
      const result = await client.task.v2.tasklist.list({ params: { page_size: 100, page_token: pageToken } });
      if (result.code) throw new Error(`查询评估任务清单失败：${result.msg}`);
      const existing = result.data?.items?.find((item) => item.name === 'Codex 后续评估' && !item.archive_msec);
      if (existing?.guid) {
        this.evaluationTasklistGuid = existing.guid;
        this.saveState();
        return existing.guid;
      }
      pageToken = result.data?.has_more ? result.data.page_token : undefined;
    } while (pageToken);

    const assignee = process.env.EVALUATION_DEFAULT_ASSIGNEE_OPEN_ID
      || (process.env.FEISHU_ALLOWED_OPEN_IDS ?? '').split(',').map((item) => item.trim()).find(Boolean);
    const created = await client.task.v2.tasklist.create({
      params: { user_id_type: 'open_id' },
      data: {
        name: 'Codex 后续评估',
        members: assignee ? [{ id: assignee, type: 'user', role: 'editor' }] : undefined,
      },
    });
    const guid = created.data?.tasklist?.guid;
    if (created.code || !guid) throw new Error(`创建评估任务清单失败：${created.msg ?? '未返回清单 GUID'}`);
    this.evaluationTasklistGuid = guid;
    this.saveState();
    return guid;
  }

  private loadState() {
    try {
      const data = this.stateStore.loadSnapshot();
      this.selected = new Map(data.selected ?? []);
      this.targets = new Map(data.targets ?? []);
      this.projectGroups = new Map(data.projectGroups ?? []);
      this.sessionTopics = new Map(data.sessionTopics ?? []);
      this.evaluationHubTopics = new Map(data.evaluationHubTopics ?? []);
      this.evaluationTasklistGuid = (data.evaluationTasklistGuid ?? []).map((entry: any) => Array.isArray(entry) ? entry[1] : entry).find(Boolean);
      this.handledMessages = (data.handledMessages ?? []).map((entry: any) => Array.isArray(entry) ? entry[1] : entry);
      this.documentBindings = new Map(data.documentBindings ?? []);
      this.commentSessions = new Map(data.commentSessions ?? []);
      this.commentTargets = new Map(data.commentTargets ?? []);
      this.commentQueues = new Map(data.commentQueues ?? []);
      this.handledComments = (data.handledComments ?? []).map((entry: any) => Array.isArray(entry) ? entry[1] : entry);
      this.syncedTurns = new Map(data.syncedTurns ?? []);
      this.pendingReferences = new Map(data.pendingReferences ?? []);
      this.plans = new Map(data.plans ?? []);
      this.goals = new Map(data.goals ?? []);
      this.planCardMessages = new Map(data.planCardMessages ?? []);
      this.goalCardMessages = new Map(data.goalCardMessages ?? []);
      this.sessionOptions = new Map(data.sessionOptions ?? []);
      for (const [sessionId, options] of this.sessionOptions) this.codex.setSessionOptions(sessionId, options);
    } catch { /* 首次启动 */ }
  }

  private saveState() {
    this.stateStore.saveSnapshot({
      selected: [...this.selected], targets: [...this.targets], projectGroups: [...this.projectGroups], sessionTopics: [...this.sessionTopics], evaluationHubTopics: [...this.evaluationHubTopics], handledMessages: this.handledMessages,
      documentBindings: [...this.documentBindings], commentSessions: [...this.commentSessions], commentTargets: [...this.commentTargets], commentQueues: [...this.commentQueues], handledComments: this.handledComments,
      syncedTurns: [...this.syncedTurns],
      pendingReferences: [...this.pendingReferences],
      plans: [...this.plans], goals: [...this.goals], planCardMessages: [...this.planCardMessages], goalCardMessages: [...this.goalCardMessages],
      sessionOptions: [...this.sessionOptions],
      evaluationTasklistGuid: this.evaluationTasklistGuid ? [['guid', this.evaluationTasklistGuid]] : [],
    });
  }

  private recordBridgeTurn(sessionId: string, turnId: string) {
    this.stateStore.recordTurn({
      eventId: codexEventId(sessionId, turnId, 'turn.started'),
      sessionId,
      turnId,
      eventType: 'turn.started',
      origin: 'codexreach',
      status: 'running',
    });
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

function summarizeNotification(notification: any): string {
  const method = String(notification.method ?? '');
  const item = notification.params?.item ?? notification.params?.turn?.items?.at?.(-1);
  if (item?.type === 'agentMessage' && item.text) return String(item.text).slice(0, 3000);
  if (item?.tool || /ToolCall$/.test(item?.type ?? '')) return `正在执行：${item.tool ?? item.type}`;
  if (method === 'turn/started') return '任务已经开始执行。';
  if (method === 'turn/completed') return `任务已${notification.params?.turn?.status === 'failed' ? '失败' : '完成'}。`;
  return `正在执行：${method.replace(/^item\//, '').replace(/^turn\//, '')}`;
}

const PAGE_SIZE = 10;

export function searchProjectFiles(cwd: string, query = '', limit = 20): string[] {
  const root = path.resolve(cwd);
  const ignored = new Set(['.git', 'node_modules', 'dist', 'dist-web', '.next', 'coverage', '.data']);
  const needle = query.trim().toLowerCase();
  const matches: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (matches.length >= limit || depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (matches.length >= limit) break;
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute);
        if (!needle || relative.toLowerCase().includes(needle)) matches.push(relative);
      }
    }
  };
  visit(root, 0);
  return matches;
}

function quoteReference(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function formatReference(reference: PendingReference): string {
  if (reference.type === 'file') return `@${quoteReference(reference.value)}`;
  if (reference.type === 'skill') return `$${reference.value}`;
  return `[$${reference.label ?? reference.value}](app://${reference.value})`;
}

function referenceCard(title: string, sessionId: string, references: Array<{ type: 'file' | 'skill'; value: string; description?: string }>): Card {
  if (!references.length) return card(`Codex · ${title}`, [{ tag: 'div', text: { tag: 'lark_md', content: '没有找到匹配项。' } }]);
  const elements: Array<Record<string, unknown>> = references.map((item) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${item.type === 'file' ? '@' : '$'}${item.value}**${item.description ? `\n${item.description.slice(0, 160)}` : ''}` },
    extra: { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '选择' }, value: { action: 'reference_select', sessionId, referenceType: item.type, referenceValue: item.value } },
  }));
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '可连续选择多个项目；选择完成后直接发送任务内容。' }] });
  return card(`Codex · ${title}`, elements);
}

function appCard(sessionId: string, apps: Array<{ id: string; name: string; description?: string | null; installUrl?: string | null; isAccessible: boolean; isEnabled: boolean; installed: boolean; callable: boolean }>): Card {
  if (!apps.length) return card('Codex · Apps', [{ tag: 'div', text: { tag: 'lark_md', content: '没有找到匹配的 App。' } }]);
  const elements: Array<Record<string, unknown>> = apps.map((app) => {
    const status = app.callable ? '可调用' : app.installed ? '已安装但当前不可调用' : app.isAccessible ? '可安装' : '需要授权';
    const action = app.callable
      ? { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '选择' }, value: { action: 'reference_select', sessionId, referenceType: 'app', referenceValue: app.id, referenceLabel: app.name } }
      : app.installUrl
        ? { tag: 'button', text: { tag: 'plain_text', content: '安装/授权' }, url: app.installUrl }
        : undefined;
    return {
      tag: 'div',
      text: { tag: 'lark_md', content: `**$${app.name}** · ${status}${app.description ? `\n${app.description.slice(0, 180)}` : ''}` },
      ...(action ? { extra: action } : {}),
    };
  });
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: 'App 选择后会作为 Connector 引用附加到下一条任务；授权通常需要在浏览器完成。' }] });
  return card('Codex · Apps', elements);
}

function modelCard(sessionId: string, models: Array<{ model: string; displayName: string; description?: string; isDefault: boolean }>, selected?: string): Card {
  const elements: Array<Record<string, unknown>> = models.slice(0, 12).map((model) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${model.displayName}**${model.model === selected ? ' · 当前' : model.isDefault ? ' · 默认' : ''}\n${model.model}${model.description ? `\n${model.description.slice(0, 140)}` : ''}` },
    extra: { tag: 'button', type: model.model === selected ? 'default' : 'primary', text: { tag: 'plain_text', content: model.model === selected ? '已选择' : '选择' }, value: { action: 'model_select', sessionId, model: model.model } },
  }));
  return card('Codex · Model', elements.length ? elements : [{ tag: 'div', text: { tag: 'plain_text', content: '没有可用模型。' } }]);
}

function modeCard(sessionId: string, selected: 'default' | 'plan'): Card {
  return card('Codex · Mode', [
    { tag: 'div', text: { tag: 'lark_md', content: `当前模式：**${selected === 'plan' ? 'Plan' : 'Default'}**\n\nPlan 会要求 Codex 先制定计划，不立即修改文件。` } },
    { tag: 'action', actions: [
      { tag: 'button', type: selected === 'default' ? 'default' : 'primary', text: { tag: 'plain_text', content: 'Default' }, value: { action: 'mode_select', sessionId, mode: 'default' } },
      { tag: 'button', type: selected === 'plan' ? 'default' : 'primary', text: { tag: 'plain_text', content: 'Plan' }, value: { action: 'mode_select', sessionId, mode: 'plan' } },
    ] },
  ]);
}

function gitDiffCard(sessionId: string, output: string): Card {
  return card('Codex · Git Diff', [
    { tag: 'div', text: { tag: 'lark_md', content: `**Session**\n${sessionId}\n\n\`\`\`diff\n${output.replaceAll('```', '\`\`\`')}\n\`\`\``.slice(0, 13000) } },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '输出过长时仅显示前 12,000 字符。' }] },
  ]);
}

function commitCard(sessionId: string, message: string, status: string): Card {
  return card('Codex · Commit 确认', [
    { tag: 'div', text: { tag: 'lark_md', content: `**提交说明**\n${message}\n\n**将提交的变更**\n\`\`\`\n${status.slice(0, 6000)}\n\`\`\`` } },
    { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '确认 Commit' }, value: { action: 'git_commit_confirm', sessionId, message } }] },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '点击后将执行 git add -A 并创建本地 Commit，不会 Push。' }] },
  ]);
}

function contextCard(sessionId: string, references: PendingReference[]): Card {
  if (!references.length) return card('Codex · Context', [{ tag: 'div', text: { tag: 'lark_md', content: `**Session**\n${sessionId}\n\n当前没有待发送的上下文。` } }]);
  const elements: Array<Record<string, unknown>> = references.map((item) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${formatReference(item)}**` },
    extra: { tag: 'button', text: { tag: 'plain_text', content: '移除' }, value: { action: 'reference_remove', sessionId, referenceType: item.type, referenceValue: item.value } },
  }));
  elements.push({ tag: 'action', actions: [{ tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '全部清空' }, value: { action: 'reference_clear', sessionId } }] });
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '上下文会附加到下一条任务，发送成功后自动清空；30 分钟未使用将过期。' }] });
  return card('Codex · Context', elements);
}

function planCard(sessionId: string, state?: PlanState): Card {
  const icons = { pending: '⬜', inProgress: '🔄', completed: '✅' } as const;
  const content = state?.plan.length
    ? state.plan.map((item) => `${icons[item.status]} ${item.step}`).join('\n')
    : '当前 Session 暂无计划。发送 `/plan <任务>` 让 Codex 先制定计划。';
  const title = state?.plan.length ? `Codex · Plan（${state.plan.filter((item) => item.status === 'completed').length}/${state.plan.length}）` : 'Codex · Plan';
  return card(title, [
    { tag: 'div', text: { tag: 'lark_md', content: `**Session**\n${sessionId}${state?.explanation ? `\n\n${state.explanation}` : ''}\n\n${content}` } },
    { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '刷新计划' }, value: { action: 'plan_refresh', sessionId } }] },
  ]);
}

function goalCard(sessionId: string, goal: ThreadGoal | null): Card {
  if (!goal) return card('Codex · Goal', [{ tag: 'div', text: { tag: 'lark_md', content: `**Session**\n${sessionId}\n\n当前没有 Goal。\n发送 \`/goal create <目标>\` 创建。` } }]);
  const labels: Record<ThreadGoal['status'], string> = { active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '预算已用尽', complete: '已完成' };
  const budget = goal.tokenBudget == null ? '不限' : `${goal.tokensUsed}/${goal.tokenBudget} tokens`;
  const actions: Array<Record<string, unknown>> = [];
  if (goal.status === 'active') actions.push({ tag: 'button', text: { tag: 'plain_text', content: '暂停' }, value: { action: 'goal_pause', sessionId } });
  if (goal.status === 'paused' || goal.status === 'blocked') actions.push({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '恢复' }, value: { action: 'goal_resume', sessionId } });
  if (goal.status !== 'complete') actions.push({ tag: 'button', text: { tag: 'plain_text', content: '完成' }, value: { action: 'goal_complete', sessionId } });
  actions.push({ tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '清除' }, value: { action: 'goal_clear', sessionId } });
  return card('Codex · Goal', [
    { tag: 'div', text: { tag: 'lark_md', content: `**Session**\n${sessionId}\n\n**目标**\n${goal.objective}\n\n**状态** ${labels[goal.status]}　**预算** ${budget}\n**运行时间** ${Math.round(goal.timeUsedSeconds / 60)} 分钟` } },
    { tag: 'action', actions },
  ]);
}

function projectCard(projects: Project[], page: number): Card {
  const pages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const elements: Array<Record<string, unknown>> = projects.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).flatMap((project) => ([
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**${project.name}**（${project.sessions.length} 个 Session）\n${project.path}` },
    },
    {
      tag: 'action',
      actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看 Sessions' }, value: { action: 'project_sessions', projectPath: project.path } },
        { tag: 'button', text: { tag: 'plain_text', content: '同步' }, value: { action: 'project_sync', projectPath: project.path } },
      ],
    },
    { tag: 'hr' },
  ]));
  elements.push(navigation('projects_page', current, pages));
  return card(`项目（${current + 1}/${pages}）`, elements);
}

function projectBindingRecoveryCard(chatId: string, projects: Project[]): Card {
  const elements: Array<Record<string, unknown>> = [{
    tag: 'div', text: { tag: 'lark_md', content: '检测到群绑定记录缺失，但历史证据无法唯一确定项目。请选择当前群对应的 Codex Project：' },
  }];
  for (const project of projects.slice(0, 20)) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${project.name}**（${project.sessions.length} 个 Session）\n${project.path}` },
      extra: { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '绑定到此项目' }, value: { action: 'bind_project_confirm', chatId, projectPath: project.path } },
    });
  }
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '绑定只会复用当前群，不会新建重复群。确认后请重新发送刚才的消息。' }] });
  return card('Codex · 修复群绑定', elements);
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

export function parseDocumentUrl(value: string): Pick<DocumentBinding, 'fileToken' | 'fileType' | 'url'> | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(docx|docs)\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    return { fileToken: match[2], fileType: match[1] === 'docs' ? 'doc' : 'docx', url: `${url.origin}${url.pathname}` };
  } catch { return null; }
}

function digest(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 16); }

function commentElementsText(elements: Array<any>): string {
  return elements.map((item) => item.text_run?.text ?? item.docs_link?.url ?? '').join('').trim();
}

function buildCommentPrompt(binding: DocumentBinding, question: string, quote?: string, priorReplies: string[] = []): string {
  return [
    '状态：已接收，正在交给 Codex 处理。',
    '以下任务来自飞书文档评论。请在当前项目中处理，并在最终回复中简要列出修改内容、测试结果和需要人工确认的事项。',
    `文档：${binding.url}`,
    quote ? `评论引用内容：\n${quote}` : '',
    priorReplies.length ? `评论线程此前讨论：\n${priorReplies.map((item) => `- ${item}`).join('\n')}` : '',
    `本次要求：\n${question}`,
  ].filter(Boolean).join('\n\n');
}

function extractAgentAnswer(turn: any): string {
  const item = [...(turn?.items ?? [])].reverse().find((entry: any) => entry.type === 'agentMessage' && entry.text);
  return String(item?.text ?? '').trim();
}

export function formatDesktopTurn(turn: any): string {
  const userItem = (turn?.items ?? []).find((item: any) => item.type === 'userMessage');
  const agentItem = [...(turn?.items ?? [])].reverse().find((item: any) => item.type === 'agentMessage' && item.text);
  const userText = extractUserText(userItem);
  const agentText = String(agentItem?.text ?? '').trim();
  if (!userText && !agentText) return '';
  return [
    '🖥️ 来自 Codex Desktop',
    userText ? `\n你：\n${userText}` : '',
    agentText ? `\nCodex：\n${agentText}` : '',
  ].filter(Boolean).join('\n');
}

export function formatDesktopTurnMessages(turn: any, maxLength = 3500): string[] {
  const userItem = (turn?.items ?? []).find((item: any) => item.type === 'userMessage');
  const agentItem = [...(turn?.items ?? [])].reverse().find((item: any) => item.type === 'agentMessage' && item.text);
  const userText = extractUserText(userItem);
  const agentText = String(agentItem?.text ?? '').trim();
  if (!userText && !agentText) return [];
  const combined = formatDesktopTurn(turn);
  if (combined.length <= maxLength) return [combined];
  const messages: string[] = [];
  for (const [index, part] of chunkText(userText, maxLength - 80).entries()) {
    messages.push(`${index === 0 ? '🖥️ 来自 Codex Desktop\n\n你：' : '你（续）：'}\n${part}`);
  }
  for (const [index, part] of chunkText(agentText, maxLength - 80).entries()) {
    messages.push(`${index === 0 ? 'Codex：' : 'Codex（续）：'}\n${part}`);
  }
  return messages;
}

export function extractTurnImagePaths(turn: any, threadId?: string, startedAt?: number): string[] {
  const paths = new Set<string>();
  const agentItems = (turn?.items ?? []).filter((item: any) => item?.type === 'agentMessage');
  for (const item of agentItems) {
    const text = String(item?.text ?? '');
    // Codex 图片结果通常会在最终回复中以绝对路径 Markdown 图片呈现。
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      let candidate = match[1].trim().replace(/^<|>$/g, '');
      try { candidate = decodeURIComponent(candidate.replace(/^file:\/\//, '')); } catch { /* 保留原路径 */ }
      if (path.isAbsolute(candidate) && fs.existsSync(candidate) && /\.(png|jpe?g|webp|gif|bmp|ico|tiff?|heic)$/i.test(candidate)) paths.add(candidate);
    }
  }
  // ImageGen 的结果不一定写入最终回复；Codex 会把它保存到线程专属目录。
  // 飞书发起的回合有 startedAt，因此只回传本轮新生成的文件，避免把历史图重复发送。
  if (threadId && startedAt) {
    const generatedDir = path.join(process.env.HOME ?? '', '.codex', 'generated_images', threadId);
    if (fs.existsSync(generatedDir)) {
      for (const name of fs.readdirSync(generatedDir)) {
        const candidate = path.join(generatedDir, name);
        try {
          if (/\.(png|jpe?g|webp|gif)$/i.test(name) && fs.statSync(candidate).mtimeMs >= startedAt - 2_000) paths.add(candidate);
        } catch { /* 文件可能正被清理 */ }
      }
    }
  }
  return [...paths];
}

function chunkText(value: string, size: number): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) chunks.push(value.slice(offset, offset + size));
  return chunks;
}

function extractUserText(item: any): string {
  if (!item) return '';
  if (typeof item.text === 'string') return item.text.trim();
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part: any) => part?.text ?? part?.inputText ?? '').filter(Boolean).join('\n').trim();
}
