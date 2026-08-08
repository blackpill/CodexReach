import type { StructuredActionClassifier, StructuredDetectionResult } from './action-detector.js';

function compactSummary(text: string) {
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 240) || 'Codex 完成了一项需要后续评估的变更';
}

export const heuristicActionClassifier: StructuredActionClassifier = async ({ context, prefilter }) => {
  const isSeo = prefilter.signals.includes('seo_change');
  const isRelease = prefilter.signals.includes('release_change') || prefilter.signals.includes('deployment');
  const template = isSeo ? 'seo' : isRelease ? 'release' : 'manual';
  const productionState = prefilter.signals.includes('deployment') || prefilter.signals.includes('production_change')
    ? 'deployed'
    : prefilter.signals.includes('local_only') ? 'not_deployed' : 'unknown';
  const result: StructuredDetectionResult = {
    batchSummary: compactSummary(context.agentResult || context.userIntent),
    actions: [{
      actionType: isSeo ? 'seo_change' : isRelease ? 'release_change' : 'follow_up_action',
      summary: compactSummary(context.agentResult || context.userIntent),
      affectedTargets: context.git.changedFiles?.length
        ? context.git.changedFiles.slice(0, 100)
        : [context.projectPath],
      requiresEvaluation: true,
      template,
      confidence: Math.max(0.6, prefilter.score),
      productionState,
      reason: prefilter.reasons.join('；') || '规则预筛选认为需要后续评估',
    }],
  };
  return result;
};
