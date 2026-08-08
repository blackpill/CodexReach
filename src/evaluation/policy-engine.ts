import { createHash } from 'node:crypto';
import type { ActionBatch, EvaluationNode, EvaluationPlan, EvaluationTemplate } from './types.js';

const DAY = 24 * 60 * 60 * 1_000;

type NodePolicy = { delayDays: number; purpose: string };

const policies: Record<EvaluationTemplate, NodePolicy[]> = {
  seo: [
    { delayDays: 7, purpose: '检查抓取、索引和 SEO 技术异常' },
    { delayDays: 28, purpose: '评估曝光、点击率、点击量和平均排名变化' },
  ],
  release: [
    { delayDays: 1, purpose: '检查错误、稳定性和关键线上流程' },
    { delayDays: 7, purpose: '评估功能使用、转化、反馈和稳定性' },
  ],
  manual: [
    { delayDays: 7, purpose: '执行人工定义的后续效果检查' },
  ],
};

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

export function buildEvaluationPlan(input: {
  batch: ActionBatch;
  template: EvaluationTemplate;
  confirmedAt: string;
}): { plan: EvaluationPlan; nodes: EvaluationNode[] } {
  const effectiveAt = Date.parse(input.batch.effectiveAt);
  if (!Number.isFinite(effectiveAt)) throw new Error(`Invalid batch effectiveAt: ${input.batch.effectiveAt}`);
  const planId = stableId('plan', input.batch.id);
  const plan: EvaluationPlan = {
    id: planId,
    batchId: input.batch.id,
    template: input.template,
    confirmedAt: input.confirmedAt,
    createdAt: input.confirmedAt,
  };
  const nodes = policies[input.template].map((policy): EvaluationNode => {
    const id = stableId('node', `${planId}:${policy.delayDays}:${policy.purpose}`);
    return {
      id,
      planId,
      purpose: policy.purpose,
      dueAt: new Date(effectiveAt + policy.delayDays * DAY).toISOString(),
      status: 'scheduled',
      reminderStage: 0,
      sourceTopicId: input.batch.sourceTopicId,
      createdAt: input.confirmedAt,
      updatedAt: input.confirmedAt,
    };
  });
  return { plan, nodes };
}
