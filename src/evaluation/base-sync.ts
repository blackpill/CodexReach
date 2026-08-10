import type { ExtractedEvaluationResult } from './result-extractor.js';
import { EvaluationStore } from './store.js';
import type { ActionBatch, ActionCandidate, EvaluationNode, EvaluationPlan, EvaluationRun } from './types.js';

export type EvaluationBaseConfig = {
  baseToken: string;
  projectTableId: string;
  actionTableId: string;
  planTableId: string;
  resultTableId: string;
};

export type EvaluationBaseApi = {
  findProjectRecord(tableId: string, projectPath: string, projectName?: string): Promise<string | undefined>;
  createRecord(tableId: string, fields: Record<string, unknown>): Promise<string>;
  updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
};

const templateLabels = { seo: 'SEO', release: '发布', manual: '人工' } as const;
const conclusionLabels = {
  effective: '倾向有效', negative: '倾向负向', no_material_change: '无明显变化',
  insufficient_data: '数据不足', not_attributable: '无法归因', technical_issue: '技术异常',
} as const;
const nodeStatusLabels: Record<string, string> = {
  scheduled: '已计划', waiting_confirmation: '等待确认', running: '执行中',
  completed: '已完成', postponed: '已延期', cancelled: '已取消', failed: '失败', manual_completed: '已完成',
};

export class LarkEvaluationBaseApi implements EvaluationBaseApi {
  constructor(private readonly client: any, private readonly baseToken: string) {}

  async findProjectRecord(tableId: string, projectPath: string, projectName?: string) {
    const conditions = projectPath
      ? [{ field_name: '项目路径', operator: 'is', value: [projectPath] }]
      : [{ field_name: '项目名称', operator: 'is', value: [projectName ?? ''] }];
    const result = await this.client.bitable.appTableRecord.search({
      path: { app_token: this.baseToken, table_id: tableId },
      params: { page_size: 10 },
      data: { field_names: ['项目名称', '项目路径'], filter: { conjunction: 'and', conditions } },
    });
    if (result.code) throw new Error(`查询 Base 项目记录失败：${result.msg}`);
    return result.data?.items?.[0]?.record_id;
  }

  async createRecord(tableId: string, fields: Record<string, unknown>) {
    const result = await this.client.bitable.appTableRecord.create({
      path: { app_token: this.baseToken, table_id: tableId }, data: { fields },
    });
    const recordId = result.data?.record?.record_id;
    if (result.code || !recordId) throw new Error(`创建 Base 记录失败：${result.msg ?? '未返回 record_id'}`);
    return recordId;
  }

  async updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>) {
    const result = await this.client.bitable.appTableRecord.update({
      path: { app_token: this.baseToken, table_id: tableId, record_id: recordId }, data: { fields },
    });
    if (result.code) throw new Error(`更新 Base 记录失败：${result.msg}`);
  }
}

export class BaseSyncService {
  constructor(
    private readonly store: EvaluationStore,
    private readonly api: EvaluationBaseApi,
    private readonly config: EvaluationBaseConfig,
  ) {}

  private async upsert(entityType: string, entityId: string, tableId: string, fields: Record<string, unknown>) {
    fields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const existing = this.store.getBaseRecordId(entityType, entityId);
    if (existing) {
      await this.api.updateRecord(tableId, existing, fields);
      return existing;
    }
    const recordId = await this.api.createRecord(tableId, fields);
    this.store.saveBaseRecordId(entityType, entityId, recordId);
    return recordId;
  }

  private projectLink(recordId: string | undefined) { return recordId ? [recordId] : undefined; }

  async syncPlan(input: {
    batch: ActionBatch;
    candidate: ActionCandidate;
    plan: EvaluationPlan;
    nodes: EvaluationNode[];
  }) {
    const projectRecordId = await this.api.findProjectRecord(this.config.projectTableId, input.batch.projectPath ?? '', input.batch.projectName);
    const actionRecordId = await this.upsert('action', input.batch.id, this.config.actionTableId, {
      '行动ID': input.batch.id,
      '项目': this.projectLink(projectRecordId),
      '行动类型': templateLabels[input.candidate.suggestedTemplate],
      '行动摘要': input.batch.summary,
      '行动假设': input.candidate.actionSummaries.join('\n'),
      '影响对象': input.candidate.affectedTargets.join('\n'),
      '执行时间': Date.parse(input.batch.effectiveAt),
      '来源SessionID': input.batch.sourceSessionId ?? '',
      '来源话题ID': input.batch.sourceTopicId ?? '',
      'Git Commit': input.candidate.currentCommit ?? '',
      '部署版本': '',
      '识别置信度': input.candidate.confidence,
      '确认状态': '已确认',
      '当前结论': '待评估',
      '本地记录ID': input.batch.id,
    });
    for (const node of input.nodes) {
      const observationDays = Math.max(0, Math.round((Date.parse(node.dueAt) - Date.parse(input.batch.effectiveAt)) / 86_400_000));
      await this.upsert('plan-node', node.id, this.config.planTableId, {
        '评估ID': node.id,
        '行动': [actionRecordId],
        '项目': this.projectLink(projectRecordId),
        '评估类型': templateLabels[input.plan.template],
        '评估目标': node.purpose,
        '计划时间': Date.parse(node.dueAt),
        '观察周期天': observationDays,
        '评估指标': '',
        '成功标准': '',
        '数据来源': input.plan.template === 'seo' ? 'Google Search Console / 页面检查' : '人工补充',
        '状态': nodeStatusLabels[node.status] ?? node.status,
        '飞书任务GUID': node.feishuTaskGuid ?? '',
        // Base 的 URL 字段不能直接写字符串，必须使用 { link, text }。
        '飞书任务链接': node.feishuTaskUrl
          ? { link: node.feishuTaskUrl, text: '打开飞书任务' }
          : undefined,
        '原话题ID': node.sourceTopicId ?? input.batch.sourceTopicId ?? '',
        '评估话题ID': node.evaluationTopicId ?? '',
        '提醒阶段': node.reminderStage,
        '本地记录ID': node.id,
      });
    }
  }

  async syncResult(input: {
    batch: ActionBatch;
    plan: EvaluationPlan;
    node: EvaluationNode;
    run: EvaluationRun;
    result: ExtractedEvaluationResult;
  }) {
    const projectRecordId = await this.api.findProjectRecord(this.config.projectTableId, input.batch.projectPath ?? '', input.batch.projectName);
    const planRecordId = this.store.getBaseRecordId('plan-node', input.node.id);
    await this.upsert('result', input.run.id, this.config.resultTableId, {
      '结果ID': input.run.id,
      '评估计划': planRecordId ? [planRecordId] : undefined,
      '项目': this.projectLink(projectRecordId),
      '执行时间': Date.parse(input.run.finishedAt ?? new Date().toISOString()),
      '数据窗口': `${input.batch.effectiveAt} → ${input.run.finishedAt ?? ''}`,
      '数据是否充足': input.result.conclusion === 'insufficient_data' ? '否' : '是',
      '指标变化': input.result.summary,
      '证据摘要': JSON.stringify(input.result.evidence).slice(0, 10000),
      '影响因素': input.result.conclusion === 'not_attributable' ? input.result.summary : '',
      '结论': conclusionLabels[input.result.conclusion],
      '结论置信度': input.result.confidence,
      '建议': input.result.recommendation,
      'Codex Session ID': input.run.sessionId,
      '评估话题ID': input.node.evaluationTopicId ?? '',
      '原始结果 JSON': JSON.stringify(input.result).slice(0, 10000),
    });
    const actionRecordId = this.store.getBaseRecordId('action', input.batch.id);
    if (actionRecordId) await this.api.updateRecord(this.config.actionTableId, actionRecordId, { '当前结论': conclusionLabels[input.result.conclusion] });
    if (planRecordId) await this.api.updateRecord(this.config.planTableId, planRecordId, {
      '状态': '已完成', '评估话题ID': input.node.evaluationTopicId ?? '', '提醒阶段': input.node.reminderStage,
    });
  }
}
