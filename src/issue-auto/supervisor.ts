export type Stage =
  | 'RECEIVED'
  | 'PREPARING'
  | 'DEVELOPING'
  | 'VALIDATING'
  | 'CREATING_PR'
  | 'CI_CHECKING'
  | 'PR_READY'
  | 'BLOCKED'
  | 'WAITING_QUOTA'
  | 'PAUSED';
export type DecisionInput = {
  stage: Stage;
  turn?: string;
  validation?: string;
  headSha?: string;
  checkedSha?: string;
  required?: string[];
  checks?: Record<string, string>;
  failures: number;
  noProgress: number;
};
export function decideNext(input: DecisionInput): { stage: Stage; reason?: string } {
  if (input.stage === 'DEVELOPING' && input.turn === 'completed') return { stage: 'VALIDATING' };
  if (input.stage === 'DEVELOPING' && input.turn === 'quota')
    return { stage: 'WAITING_QUOTA', reason: 'quota' };
  if (input.stage === 'DEVELOPING' && ['failed', 'interrupted'].includes(input.turn ?? ''))
    return { stage: 'BLOCKED', reason: 'turn_failed' };
  if (input.stage === 'VALIDATING' && input.validation === 'passed')
    return { stage: 'CREATING_PR' };
  if (input.stage === 'VALIDATING' && input.validation === 'failed') {
    if (input.failures >= 3 || input.noProgress >= 2)
      return { stage: 'BLOCKED', reason: 'retry_limit' };
    return { stage: 'DEVELOPING' };
  }
  if (input.stage === 'CI_CHECKING') {
    if (!input.required?.length) return { stage: 'BLOCKED', reason: 'no_required_checks' };
    if (!input.headSha || input.checkedSha !== input.headSha) return { stage: 'CI_CHECKING' };
    const results = input.required.map((name) => input.checks?.[name]);
    if (results.some((result) => ['skipped', 'cancelled', 'timed_out'].includes(result ?? '')))
      return { stage: 'BLOCKED', reason: 'ci_inconclusive' };
    if (results.some((result) => result === 'failure'))
      return input.failures >= 3
        ? { stage: 'BLOCKED', reason: 'ci_retry_limit' }
        : { stage: 'DEVELOPING' };
    if (results.every((result) => result === 'success')) return { stage: 'PR_READY' };
  }
  return { stage: input.stage };
}
