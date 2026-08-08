import type { TurnActionContext } from './action-collector.js';
import type { PrefilterResult } from './action-prefilter.js';
import type { EvaluationTemplate } from './types.js';

export type StructuredAction = {
  actionType: string;
  summary: string;
  affectedTargets: string[];
  requiresEvaluation: boolean;
  template: EvaluationTemplate;
  confidence: number;
  productionState: 'not_deployed' | 'deployed' | 'unknown';
  reason: string;
};

export type StructuredDetectionResult = {
  actions: StructuredAction[];
  batchSummary: string;
};

export type StructuredActionClassifier = (input: {
  context: TurnActionContext;
  prefilter: PrefilterResult;
}) => Promise<unknown>;

const templates = new Set<EvaluationTemplate>(['seo', 'release', 'manual']);
const productionStates = new Set(['not_deployed', 'deployed', 'unknown']);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid action detection field: ${field}`);
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid action detection field: ${field}`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function parseStructuredDetection(value: unknown): StructuredDetectionResult {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('Invalid structured action detection JSON'); }
  }
  if (!value || typeof value !== 'object') throw new Error('Invalid structured action detection result');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.actions)) throw new Error('Invalid action detection field: actions');
  const actions = raw.actions.map((entry, index): StructuredAction => {
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid action detection action at index ${index}`);
    const action = entry as Record<string, unknown>;
    const template = action.template;
    const productionState = action.productionState;
    const confidence = Number(action.confidence);
    if (!templates.has(template as EvaluationTemplate)) throw new Error(`Invalid action detection field: actions[${index}].template`);
    if (!productionStates.has(String(productionState))) throw new Error(`Invalid action detection field: actions[${index}].productionState`);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`Invalid action detection field: actions[${index}].confidence`);
    if (typeof action.requiresEvaluation !== 'boolean') throw new Error(`Invalid action detection field: actions[${index}].requiresEvaluation`);
    return {
      actionType: requiredString(action.actionType, `actions[${index}].actionType`),
      summary: requiredString(action.summary, `actions[${index}].summary`),
      affectedTargets: stringArray(action.affectedTargets, `actions[${index}].affectedTargets`),
      requiresEvaluation: action.requiresEvaluation,
      template: template as EvaluationTemplate,
      confidence,
      productionState: productionState as StructuredAction['productionState'],
      reason: requiredString(action.reason, `actions[${index}].reason`),
    };
  });
  return { actions, batchSummary: requiredString(raw.batchSummary, 'batchSummary') };
}

export async function detectStructuredActions(
  classifier: StructuredActionClassifier,
  context: TurnActionContext,
  prefilter: PrefilterResult,
): Promise<StructuredDetectionResult> {
  if (!prefilter.eligible) return { actions: [], batchSummary: '未发现需要评估的行动' };
  return parseStructuredDetection(await classifier({ context, prefilter }));
}
