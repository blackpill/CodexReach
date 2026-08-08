import { createHash } from 'node:crypto';
import type { TurnActionContext } from './action-collector.js';
import type { StructuredAction } from './action-detector.js';
import type { ActionCandidate, EvaluationTemplate, ISODateTime } from './types.js';

const DAY = 24 * 60 * 60 * 1_000;

function unique(values: string[]) { return [...new Set(values.filter(Boolean))]; }

function timestamp(value: ISODateTime) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO date: ${value}`);
  return parsed;
}

function overlap(left: string[], right: string[]) {
  const normalizedLeft = new Set(left.map((item) => item.toLowerCase()));
  return right.some((item) => normalizedLeft.has(item.toLowerCase()));
}

function templateFor(actions: StructuredAction[]): EvaluationTemplate {
  if (actions.some((action) => action.template === 'seo')) return 'seo';
  if (actions.some((action) => action.template === 'release')) return 'release';
  return 'manual';
}

export function candidateFingerprint(projectId: string, sessionId: string, turnId: string) {
  return createHash('sha256').update(`${projectId}\0${sessionId}\0${turnId}`).digest('hex').slice(0, 24);
}

export function createCandidate(input: {
  context: TurnActionContext;
  actions: StructuredAction[];
  id?: string;
  staleAfterDays?: number;
  expireAfterDays?: number;
}): ActionCandidate {
  const { context } = input;
  const actions = input.actions.filter((action) => action.requiresEvaluation);
  if (!actions.length) throw new Error('Cannot create candidate without an evaluable action');
  const detectedAt = timestamp(context.completedAt);
  return {
    id: input.id ?? `candidate-${candidateFingerprint(context.projectId, context.sessionId, context.turnId)}`,
    projectId: context.projectId,
    sourceSessionIds: [context.sessionId],
    firstDetectedAt: context.completedAt,
    lastUpdatedAt: context.completedAt,
    baseCommit: context.git.baseCommit,
    currentCommit: context.git.headCommit,
    changedFiles: unique(context.git.changedFiles ?? []),
    actionSummaries: unique(actions.map((action) => action.summary)),
    suggestedTemplate: templateFor(actions),
    affectedTargets: unique(actions.flatMap((action) => action.affectedTargets)),
    confidence: Math.max(...actions.map((action) => action.confidence)),
    status: 'candidate',
    staleAt: new Date(detectedAt + (input.staleAfterDays ?? 30) * DAY).toISOString(),
    expiresAt: new Date(detectedAt + (input.expireAfterDays ?? 90) * DAY).toISOString(),
  };
}

export function canMergeCandidate(existing: ActionCandidate, incoming: ActionCandidate, maxGapDays = 14): boolean {
  if (existing.status !== 'candidate' && existing.status !== 'stale') return false;
  if (existing.projectId !== incoming.projectId) return false;
  if (timestamp(incoming.firstDetectedAt) - timestamp(existing.lastUpdatedAt) > maxGapDays * DAY) return false;
  const sameSession = overlap(existing.sourceSessionIds, incoming.sourceSessionIds);
  const sameFile = overlap(existing.changedFiles, incoming.changedFiles);
  const sameTarget = overlap(existing.affectedTargets, incoming.affectedTargets);
  const commitContinuity = Boolean(existing.currentCommit && incoming.baseCommit && existing.currentCommit === incoming.baseCommit);
  return sameSession || sameFile || sameTarget || commitContinuity;
}

export function mergeCandidates(existing: ActionCandidate, incoming: ActionCandidate): ActionCandidate {
  if (!canMergeCandidate(existing, incoming)) throw new Error('Candidates are not merge-compatible');
  const lastUpdatedAt = timestamp(existing.lastUpdatedAt) >= timestamp(incoming.lastUpdatedAt)
    ? existing.lastUpdatedAt
    : incoming.lastUpdatedAt;
  return {
    ...existing,
    sourceSessionIds: unique([...existing.sourceSessionIds, ...incoming.sourceSessionIds]),
    lastUpdatedAt,
    currentCommit: incoming.currentCommit ?? existing.currentCommit,
    changedFiles: unique([...existing.changedFiles, ...incoming.changedFiles]),
    actionSummaries: unique([...existing.actionSummaries, ...incoming.actionSummaries]),
    suggestedTemplate: templateFor([
      { template: existing.suggestedTemplate } as StructuredAction,
      { template: incoming.suggestedTemplate } as StructuredAction,
    ]),
    affectedTargets: unique([...existing.affectedTargets, ...incoming.affectedTargets]),
    confidence: Math.max(existing.confidence, incoming.confidence),
    status: 'candidate',
    staleAt: incoming.staleAt,
    expiresAt: incoming.expiresAt,
  };
}

export function mergeIntoBestCandidate(existing: ActionCandidate[], incoming: ActionCandidate): {
  candidate: ActionCandidate;
  mergedCandidateId?: string;
} {
  const matches = existing.filter((candidate) => canMergeCandidate(candidate, incoming));
  if (!matches.length) return { candidate: incoming };
  matches.sort((left, right) => timestamp(right.lastUpdatedAt) - timestamp(left.lastUpdatedAt));
  return { candidate: mergeCandidates(matches[0], incoming), mergedCandidateId: matches[0].id };
}
