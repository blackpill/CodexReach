import type { CodexClient } from '../codex-client.js';
import type { CodexTurn, RpcNotification } from '../types.js';
import { logger } from '../logger.js';
import { collectTurnActionContext, type TurnActionContext } from './action-collector.js';
import { detectStructuredActions, type StructuredAction, type StructuredActionClassifier, type StructuredDetectionResult } from './action-detector.js';
import { prefilterActionContext } from './action-prefilter.js';
import { createCandidate, mergeIntoBestCandidate } from './candidate-merger.js';
import { collectGitEvidence } from './git-evidence.js';
import { heuristicActionClassifier } from './heuristic-classifier.js';
import { EvaluationStore } from './store.js';
import type { ActionCandidate } from './types.js';

export type ActionProcessorOptions = {
  enabled?: boolean;
  classifier?: StructuredActionClassifier;
  collectGit?: typeof collectGitEvidence;
  now?: () => string;
  onCandidateSaved?: (input: {
    candidate: ActionCandidate;
    actions: StructuredAction[];
    detection: StructuredDetectionResult;
    context: TurnActionContext;
  }) => Promise<void> | void;
};

export class ActionProcessor {
  private readonly enabled: boolean;
  private readonly classifier: StructuredActionClassifier;
  private readonly collectGit: typeof collectGitEvidence;
  private readonly now: () => string;
  private readonly onCandidateSaved?: ActionProcessorOptions['onCandidateSaved'];
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly codex: Pick<CodexClient, 'readThread'>,
    private readonly store: EvaluationStore,
    options: ActionProcessorOptions = {},
  ) {
    this.enabled = options.enabled ?? false;
    this.classifier = options.classifier ?? heuristicActionClassifier;
    this.collectGit = options.collectGit ?? collectGitEvidence;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onCandidateSaved = options.onCandidateSaved;
  }

  async handleNotification(notification: RpcNotification): Promise<void> {
    if (!this.enabled || notification.method !== 'turn/completed') return;
    const params = notification.params as any;
    const sessionId = params?.threadId ?? params?.thread?.id;
    const turnId = params?.turn?.id;
    if (!sessionId || !turnId) return;
    const eventId = `codex:turn.completed:${sessionId}:${turnId}`;
    if (this.store.hasProcessedEvent(eventId)) return;
    if (this.inFlight.has(eventId)) return;
    this.inFlight.add(eventId);
    try {
      const thread = await this.codex.readThread(sessionId);
      const fullTurn = thread.turns.find((turn) => turn.id === turnId);
      const notificationTurn = params?.turn as CodexTurn | undefined;
      const turn = fullTurn?.items?.length ? fullTurn : notificationTurn;
      if (!turn) {
        logger.warn('evaluation_turn_not_found', { sessionId, turnId });
        return;
      }
      const git = await this.collectGit(thread.cwd);
      const context = collectTurnActionContext({ thread, turn, completedAt: this.now(), git });
      const prefilter = prefilterActionContext(context);
      if (!prefilter.eligible) {
        this.store.markEventProcessed(eventId, this.now());
        logger.info('evaluation_turn_filtered', { eventId, projectId: context.projectId, signals: prefilter.signals });
        return;
      }
      const detection = await detectStructuredActions(this.classifier, context, prefilter);
      const actions = detection.actions.filter((action) => action.requiresEvaluation);
      if (!actions.length) {
        this.store.markEventProcessed(eventId, this.now());
        return;
      }
      const incoming = createCandidate({ context, actions });
      const merged = mergeIntoBestCandidate(this.store.listActiveCandidates(context.projectId), incoming);
      this.store.saveCandidate(merged.candidate);
      await this.onCandidateSaved?.({ candidate: merged.candidate, actions, detection, context });
      this.store.markEventProcessed(eventId, this.now());
      logger.info('evaluation_candidate_saved', {
        eventId,
        candidateId: merged.candidate.id,
        mergedCandidateId: merged.mergedCandidateId,
        projectId: context.projectId,
        productionStates: [...new Set(actions.map((action) => action.productionState))],
      });
    } catch (error) {
      logger.error('evaluation_action_processing_failed', error, { eventId });
    } finally {
      this.inFlight.delete(eventId);
    }
  }
}
