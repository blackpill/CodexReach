import { createHash } from 'node:crypto';
import type { CodexClient } from '../codex-client.js';
import { logger } from '../logger.js';
import type { CodexTurn, RpcNotification } from '../types.js';
import { extractEvaluationResult, type ExtractedEvaluationResult } from './result-extractor.js';
import { EvaluationStore } from './store.js';
import type { ActionBatch, EvaluationNode, EvaluationPlan, EvaluationRun } from './types.js';

export type EvaluationResultContext = {
  node: EvaluationNode;
  plan: EvaluationPlan;
  batch: ActionBatch;
  run: EvaluationRun;
  result: ExtractedEvaluationResult;
};

export type EvaluationResultProcessorOptions = {
  enabled?: boolean;
  now?: () => string;
  onCompleted?: (context: EvaluationResultContext) => Promise<void> | void;
  onFailed?: (context: Omit<EvaluationResultContext, 'result'>, error: string) => Promise<void> | void;
};

function agentAnswer(turn: CodexTurn): string {
  const item = [...(turn.items ?? [])].reverse().find((entry) => entry.type === 'agentMessage' && typeof entry.text === 'string');
  return typeof item?.text === 'string' ? item.text : '';
}

function runId(nodeId: string, sessionId: string) {
  return `run-${createHash('sha256').update(`${nodeId}\0${sessionId}`).digest('hex').slice(0, 24)}`;
}

export class EvaluationResultProcessor {
  private readonly enabled: boolean;
  private readonly now: () => string;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly codex: Pick<CodexClient, 'readThread'>,
    private readonly store: EvaluationStore,
    private readonly options: EvaluationResultProcessorOptions = {},
  ) {
    this.enabled = options.enabled ?? false;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async handleNotification(notification: RpcNotification) {
    if (!this.enabled || notification.method !== 'turn/completed') return;
    const params = notification.params as any;
    const sessionId = params?.threadId ?? params?.thread?.id;
    const turnId = params?.turn?.id;
    if (!sessionId || !turnId) return;
    const node = this.store.getNodeBySession(sessionId);
    if (!node) return;
    const eventId = `evaluation-result:${sessionId}:${turnId}`;
    if (this.store.hasProcessedEvent(eventId) || this.inFlight.has(eventId)) return;
    this.inFlight.add(eventId);
    try {
      const plan = this.store.getPlan(node.planId);
      const batch = plan ? this.store.getBatch(plan.batchId) : undefined;
      if (!plan || !batch) throw new Error(`Evaluation context not found for node: ${node.id}`);
      const thread = await this.codex.readThread(sessionId);
      const turn = thread.turns.find((entry) => entry.id === turnId) ?? params.turn as CodexTurn;
      const now = this.now();
      const failed = turn.status === 'failed' || turn.status === 'interrupted';
      if (failed) {
        const message = `评估 Session ${turn.status}`;
        const run: EvaluationRun = { id: runId(node.id, sessionId), nodeId: node.id, sessionId, startedAt: node.updatedAt, finishedAt: now, conclusion: 'technical_issue', confidence: 1, error: message };
        this.store.transaction(() => {
          this.store.saveRun(run);
          this.store.saveNode({ ...node, status: 'failed', updatedAt: now });
        });
        await this.options.onFailed?.({ node, plan, batch, run }, message);
        this.store.markEventProcessed(eventId, now);
        return;
      }
      const result = extractEvaluationResult(agentAnswer(turn));
      const run: EvaluationRun = {
        id: runId(node.id, sessionId), nodeId: node.id, sessionId,
        startedAt: node.updatedAt, finishedAt: now,
        conclusion: result.conclusion, confidence: result.confidence,
        evidence: result.evidence, recommendation: result.recommendation,
      };
      this.store.saveRun(run);
      await this.options.onCompleted?.({ node, plan, batch, run, result });
      this.store.transaction(() => {
        this.store.saveNode({ ...node, status: 'completed', updatedAt: now });
        this.store.markEventProcessed(eventId, now);
      });
      logger.info('evaluation_result_saved', { nodeId: node.id, sessionId, conclusion: result.conclusion, confidence: result.confidence });
    } catch (error) {
      logger.error('evaluation_result_processing_failed', error, { sessionId, turnId });
    } finally {
      this.inFlight.delete(eventId);
    }
  }
}
