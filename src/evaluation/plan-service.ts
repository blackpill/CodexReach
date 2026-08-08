import { buildEvaluationPlan } from './policy-engine.js';
import { EvaluationStore } from './store.js';

export class PlanService {
  constructor(private readonly store: EvaluationStore) {}

  confirmBatch(batchId: string, confirmedAt = new Date().toISOString()) {
    const batch = this.store.getBatch(batchId);
    if (!batch) throw new Error(`Evaluation batch not found: ${batchId}`);
    const candidate = batch.candidateIds.map((id) => this.store.getCandidate(id)).find(Boolean);
    if (!candidate) throw new Error(`Evaluation candidate not found for batch: ${batchId}`);
    const existingPlan = this.store.getPlanByBatch(batchId);
    if (existingPlan) return { plan: existingPlan, nodes: this.store.listNodesByPlan(existingPlan.id), created: false };
    const built = buildEvaluationPlan({ batch, template: candidate.suggestedTemplate, confirmedAt });
    this.store.transaction(() => {
      this.store.savePlan(built.plan);
      for (const node of built.nodes) this.store.saveNode(node);
    });
    return { ...built, created: true };
  }
}
