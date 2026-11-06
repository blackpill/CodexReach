import type { IssueStore } from './store.js';
/** One in-flight tick per process; errors in one subsystem do not stall other tasks. */
export class IssueService {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private busy = false;
  private active?: Promise<void>;
  private readyChecked = new Map<string, number>();
  private lastWebhookCheck?: number;
  constructor(
    private store: IssueStore,
    private queue: { poll(): Promise<void> },
    private coordinator: { step(taskId: string): Promise<void> },
    private checkCi: (taskId: string) => Promise<void>,
    private sendNotices: () => Promise<void>,
    private onError: (error: unknown) => void,
    private interval = 10000,
    private checkReady?: (taskId: string) => Promise<void>,
    private checkWebhook?: () => Promise<void>,
    private handoff?: () => Promise<void>,
  ) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      try {
        await this.queue.poll();
      } catch (e) {
        this.onError(e);
      }
      try {
        await this.handoff?.();
      } catch (error) {
        this.onError(error);
      }
      let executionSafe = true;
      try {
        this.store.recoverExecution();
      } catch (error) {
        executionSafe = false;
        this.onError(error);
      }
      const owner = this.store.executionOwner();
      const active = this.store.listActive();
      // An uncertain BLOCKED owner deliberately stops new work until an operator reconciles it.
      const selected = !executionSafe
        ? []
        : owner
          ? active.includes(owner)
            ? [owner]
            : []
          : active.slice(0, 1);
      for (const taskId of selected) {
        const controlProgress = this.store.getProgress(taskId);
        if (
          !controlProgress ||
          !this.store.canAdvanceAutomatic(
            taskId,
            controlProgress.stage,
            controlProgress.context.phase,
          )
        )
          continue;
        try {
          if (this.store.getProgress(taskId)?.stage === 'CI_CHECKING')
            await this.checkCi(taskId);
          else await this.coordinator.step(taskId);
        } catch (e) {
          this.onError(e);
          const p = this.store.getProgress(taskId);
          if (p && p.stage !== 'CI_CHECKING') {
            const errors =
              p.context.lastErrorStage === p.stage
                ? Number(p.context.taskErrors ?? 0) + 1
                : 1;
            const context = {
              ...p.context,
              lastErrorStage: p.stage,
              taskErrors: errors,
            };
            if (errors >= 3)
              this.store.transition(
                taskId,
                p.version,
                'BLOCKED',
                context,
                'Issue 任务连续执行失败，需要人工处理',
              );
            else this.store.transition(taskId, p.version, p.stage, context);
          }
        }
      }
      if (this.checkReady)
        for (const id of this.store.listReady()) {
          const last = this.readyChecked.get(id);
          if (last !== undefined && Date.now() - last < 300_000) continue;
          try {
            await this.checkReady(id);
            this.readyChecked.set(id, Date.now());
          } catch (e) {
            this.onError(e);
          }
        }
      if (
        this.checkWebhook &&
        (this.lastWebhookCheck === undefined ||
          Date.now() - this.lastWebhookCheck >= 300_000)
      ) {
        this.lastWebhookCheck = Date.now();
        try {
          await this.checkWebhook();
        } catch (e) {
          this.onError(e);
        }
      }
      try {
        await this.sendNotices();
      } catch (e) {
        this.onError(e);
      }
    } finally {
      this.busy = false;
    }
  }
  private async tick(): Promise<void> {
    this.active = this.runOnce();
    try {
      await this.active;
    } finally {
      this.active = undefined;
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.interval);
    }
  }
}
