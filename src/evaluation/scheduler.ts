import { logger } from '../logger.js';
import { EvaluationStore } from './store.js';
import type { ActionBatch, EvaluationNode, EvaluationPlan } from './types.js';

const DAY = 24 * 60 * 60 * 1_000;

export type EvaluationScheduleContext = {
  node: EvaluationNode;
  plan: EvaluationPlan;
  batch: ActionBatch;
};

export type EvaluationSchedulerOptions = {
  enabled?: boolean;
  intervalMs?: number;
  now?: () => string;
  onDue: (context: EvaluationScheduleContext) => Promise<boolean>;
  onReminder: (context: EvaluationScheduleContext, stage: 1 | 3 | 7) => Promise<boolean>;
  onStateChanged?: (context: EvaluationScheduleContext) => Promise<void> | void;
};

export class EvaluationScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly now: () => string;

  constructor(private readonly store: EvaluationStore, private readonly options: EvaluationSchedulerOptions) {
    this.enabled = options.enabled ?? false;
    this.intervalMs = Math.max(5_000, options.intervalMs ?? 60_000);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  start() {
    if (!this.enabled || this.timer) return false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    const now = this.now();
    try {
      for (const node of this.store.findDueNodes(now)) await this.processDue(node, now);
      for (const node of this.store.listNodesByStatus('waiting_confirmation')) await this.processReminder(node, now);
    } finally {
      this.running = false;
    }
  }

  private contextFor(node: EvaluationNode): EvaluationScheduleContext | undefined {
    const plan = this.store.getPlan(node.planId);
    const batch = plan ? this.store.getBatch(plan.batchId) : undefined;
    if (!plan || !batch) {
      logger.warn('evaluation_schedule_context_missing', { nodeId: node.id, planId: node.planId });
      return undefined;
    }
    return { node, plan, batch };
  }

  private async processDue(node: EvaluationNode, now: string) {
    const context = this.contextFor(node);
    if (!context) return;
    try {
      if (!await this.options.onDue(context)) return;
      const updated = { ...node, status: 'waiting_confirmation' as const, firstPromptedAt: now, lastRemindedAt: now, reminderStage: 0 as const, updatedAt: now };
      this.store.saveNode(updated);
      await this.options.onStateChanged?.({ ...context, node: updated });
    } catch (error) {
      logger.error('evaluation_due_delivery_failed', error, { nodeId: node.id });
    }
  }

  private async processReminder(node: EvaluationNode, now: string) {
    if (!node.firstPromptedAt || node.reminderStage === 7) return;
    const elapsedDays = Math.floor((Date.parse(now) - Date.parse(node.firstPromptedAt)) / DAY);
    const stage = ([7, 3, 1] as const).find((value) => elapsedDays >= value && node.reminderStage < value);
    if (!stage) return;
    const context = this.contextFor(node);
    if (!context) return;
    try {
      if (!await this.options.onReminder(context, stage)) return;
      const updated = { ...node, reminderStage: stage, lastRemindedAt: now, updatedAt: now };
      this.store.saveNode(updated);
      await this.options.onStateChanged?.({ ...context, node: updated });
    } catch (error) {
      logger.error('evaluation_reminder_delivery_failed', error, { nodeId: node.id, stage });
    }
  }
}
