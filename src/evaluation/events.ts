import type { EvaluationConclusion, EvaluationTemplate, ISODateTime } from './types.js';

export type TurnCompleted = {
  type: 'turn.completed';
  eventId: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  completedAt: ISODateTime;
};

export type CandidateDetected = {
  type: 'candidate.detected';
  eventId: string;
  candidateId: string;
  projectId: string;
  template: EvaluationTemplate;
  detectedAt: ISODateTime;
};

export type DeploymentVerified = {
  type: 'deployment.verified';
  eventId: string;
  deploymentId: string;
  batchId: string;
  verifiedAt: ISODateTime;
};

export type DraftConfirmed = {
  type: 'draft.confirmed';
  eventId: string;
  batchId: string;
  confirmedAt: ISODateTime;
};

export type EvaluationDue = {
  type: 'evaluation.due';
  eventId: string;
  nodeId: string;
  dueAt: ISODateTime;
};

export type EvaluationStarted = {
  type: 'evaluation.started';
  eventId: string;
  nodeId: string;
  runId: string;
  sessionId: string;
  startedAt: ISODateTime;
};

export type EvaluationFinished = {
  type: 'evaluation.finished';
  eventId: string;
  nodeId: string;
  runId: string;
  conclusion: EvaluationConclusion;
  finishedAt: ISODateTime;
};

export type EvaluationDomainEvent =
  | TurnCompleted
  | CandidateDetected
  | DeploymentVerified
  | DraftConfirmed
  | EvaluationDue
  | EvaluationStarted
  | EvaluationFinished;
