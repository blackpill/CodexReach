import { createHash } from 'node:crypto';
import type { TurnActionContext } from './action-collector.js';
import type { StructuredAction } from './action-detector.js';
import { EvaluationStore } from './store.js';
import type { ActionBatch, ActionCandidate, Deployment, DraftStatus } from './types.js';

export type EvaluationDraft = {
  batch: ActionBatch;
  deployment: Deployment;
  candidate: ActionCandidate;
  actions: StructuredAction[];
};

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

export class BatchService {
  constructor(private readonly store: EvaluationStore) {}

  createFromVerifiedTurn(input: {
    candidate: ActionCandidate;
    context: TurnActionContext;
    actions: StructuredAction[];
  }): EvaluationDraft {
    const key = input.context.eventId;
    const batchId = stableId('batch', key);
    const deploymentId = stableId('deployment', key);
    const now = input.context.completedAt;
    const existing = this.store.getBatch(batchId);
    const batch: ActionBatch = existing ?? {
      id: batchId,
      projectId: input.candidate.projectId,
      projectPath: input.context.projectPath,
      projectName: input.context.projectName,
      candidateIds: [input.candidate.id],
      summary: input.actions.map((action) => action.summary).join('；').slice(0, 1000),
      effectiveAt: now,
      draftStatus: 'draft_pending',
      sourceTopicId: undefined,
      sourceSessionId: input.context.sessionId,
      createdAt: now,
      updatedAt: now,
    };
    const deployment: Deployment = this.store.getDeployment(deploymentId) ?? {
      id: deploymentId,
      batchId,
      provider: 'codex',
      deploymentId: input.context.eventId,
      commitSha: input.context.git.headCommit,
      productionUrl: input.context.projectPath,
      deployedAt: now,
      verifiedAt: now,
      effectiveAt: now,
      evidence: {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        agentResult: input.context.agentResult.slice(0, 2000),
      },
    };
    const deployedCandidate: ActionCandidate = { ...input.candidate, status: 'deployed', lastUpdatedAt: now };
    this.store.transaction(() => {
      if (!existing) this.store.saveBatch(batch);
      this.store.saveDeployment(deployment);
      if (input.candidate.status !== 'deployed') this.store.saveCandidate(deployedCandidate);
    });
    return { batch, deployment, candidate: deployedCandidate, actions: input.actions };
  }

  updateDraftStatus(batchId: string, status: Extract<DraftStatus, 'confirmed' | 'ignored'>, now = new Date().toISOString()) {
    const batch = this.store.getBatch(batchId);
    if (!batch) throw new Error(`Evaluation batch not found: ${batchId}`);
    const updated = { ...batch, draftStatus: status, updatedAt: now };
    this.store.saveBatch(updated);
    return updated;
  }
}
