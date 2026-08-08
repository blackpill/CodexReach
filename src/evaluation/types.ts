export type ISODateTime = string;

export type ActionCandidateStatus =
  | 'candidate'
  | 'stale'
  | 'deployed'
  | 'abandoned'
  | 'expired';

export type DraftStatus = 'draft_pending' | 'confirmed' | 'ignored' | 'draft_expired';

export type EvaluationNodeStatus =
  | 'scheduled'
  | 'waiting_confirmation'
  | 'running'
  | 'postponed'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'manual_completed';

export type EvaluationConclusion =
  | 'effective'
  | 'negative'
  | 'no_material_change'
  | 'insufficient_data'
  | 'not_attributable'
  | 'technical_issue';

export type EvaluationTemplate = 'seo' | 'release' | 'manual';

export type ActionCandidate = {
  id: string;
  projectId: string;
  sourceSessionIds: string[];
  firstDetectedAt: ISODateTime;
  lastUpdatedAt: ISODateTime;
  baseCommit?: string;
  currentCommit?: string;
  changedFiles: string[];
  actionSummaries: string[];
  suggestedTemplate: EvaluationTemplate;
  affectedTargets: string[];
  confidence: number;
  status: ActionCandidateStatus;
  staleAt: ISODateTime;
  expiresAt: ISODateTime;
};

export type ActionBatch = {
  id: string;
  projectId: string;
  projectPath?: string;
  projectName?: string;
  candidateIds: string[];
  summary: string;
  effectiveAt: ISODateTime;
  draftStatus: DraftStatus;
  sourceTopicId?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type Deployment = {
  id: string;
  batchId: string;
  provider: 'codex' | 'cloudflare-pages' | 'cloudflare-workers' | 'web-fingerprint' | 'manual';
  resourceId?: string;
  deploymentId?: string;
  commitSha?: string;
  productionUrl: string;
  deployedAt?: ISODateTime;
  verifiedAt: ISODateTime;
  effectiveAt: ISODateTime;
  evidence: Record<string, unknown>;
};

export type EvaluationPlan = {
  id: string;
  batchId: string;
  template: EvaluationTemplate;
  confirmedAt: ISODateTime;
  createdAt: ISODateTime;
};

export type EvaluationNode = {
  id: string;
  planId: string;
  purpose: string;
  dueAt: ISODateTime;
  status: EvaluationNodeStatus;
  reminderStage: 0 | 1 | 3 | 7;
  feishuTaskGuid?: string;
  feishuTaskUrl?: string;
  sourceTopicId?: string;
  evaluationTopicId?: string;
  startedSessionId?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type EvaluationRun = {
  id: string;
  nodeId: string;
  sessionId: string;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime;
  conclusion?: EvaluationConclusion;
  confidence?: number;
  evidence?: Record<string, unknown>;
  recommendation?: string;
  error?: string;
};

export type BaselineSnapshot = {
  id: string;
  batchId: string;
  source: string;
  capturedAt: ISODateTime;
  periodStart?: string;
  periodEnd?: string;
  scope: Record<string, unknown>;
  metrics: Record<string, unknown>;
  status: 'complete' | 'partial' | 'missing' | 'superseded';
  supersedesId?: string;
  evidenceRef?: string;
};

export type OutboxEventStatus = 'pending' | 'processing' | 'delivered' | 'failed';

export type OutboxEvent<T = Record<string, unknown>> = {
  id: string;
  idempotencyKey: string;
  eventType: string;
  aggregateId: string;
  payload: T;
  status: OutboxEventStatus;
  retryCount: number;
  nextRetryAt: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};
