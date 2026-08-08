import type { ActionCandidateStatus, DraftStatus, EvaluationNodeStatus } from './types.js';

const candidateTransitions: Record<ActionCandidateStatus, readonly ActionCandidateStatus[]> = {
  candidate: ['stale', 'deployed', 'abandoned', 'expired'],
  stale: ['candidate', 'deployed', 'abandoned', 'expired'],
  deployed: [],
  abandoned: [],
  expired: ['candidate', 'deployed'],
};

const draftTransitions: Record<DraftStatus, readonly DraftStatus[]> = {
  draft_pending: ['confirmed', 'ignored', 'draft_expired'],
  confirmed: [],
  ignored: [],
  draft_expired: ['draft_pending'],
};

const nodeTransitions: Record<EvaluationNodeStatus, readonly EvaluationNodeStatus[]> = {
  scheduled: ['waiting_confirmation', 'postponed', 'cancelled', 'manual_completed'],
  waiting_confirmation: ['running', 'postponed', 'cancelled', 'manual_completed'],
  running: ['completed', 'failed', 'postponed', 'cancelled'],
  postponed: ['scheduled', 'cancelled', 'manual_completed'],
  completed: [],
  cancelled: [],
  failed: ['running', 'postponed', 'cancelled', 'manual_completed'],
  manual_completed: [],
};

function assertTransition<T extends string>(kind: string, from: T, to: T, transitions: Record<T, readonly T[]>) {
  if (from === to) return;
  if (!transitions[from].includes(to)) {
    throw new Error(`Invalid ${kind} transition: ${from} -> ${to}`);
  }
}

export function assertCandidateTransition(from: ActionCandidateStatus, to: ActionCandidateStatus) {
  assertTransition('candidate', from, to, candidateTransitions);
}

export function assertDraftTransition(from: DraftStatus, to: DraftStatus) {
  assertTransition('draft', from, to, draftTransitions);
}

export function assertNodeTransition(from: EvaluationNodeStatus, to: EvaluationNodeStatus) {
  assertTransition('evaluation node', from, to, nodeTransitions);
}
