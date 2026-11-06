import type { PreviewManager } from './preview-manager.js';
type Progress = { stage: string; version: number; context: Record<string, unknown> };
type Store = {
  getProgress(id: string): Progress | undefined;
  pendingNotices(): Array<{ taskId: string }>;
  transition?(
    taskId: string,
    version: number,
    stage: import('./supervisor.js').Stage,
    context: Record<string, unknown>,
  ): boolean;
};
type GitHub = {
  pullState?(pr: number): Promise<'open' | 'closed'>;
  checkCi(pr: number, required: string[]): Promise<{ status: string; headSha?: string }>;
};
/** Recheck PR revision after the potentially slow build and before sending any test URL. */
export class PreviewReview {
  private lastClosureCheck?: number;
  constructor(
    private store: Store,
    private preview: PreviewManager,
    private github: GitHub,
    private sendNotice: (message: string, taskId: string) => Promise<void>,
  ) {}
  private async message(taskId: string, base: string): Promise<string> {
    const before = this.store.getProgress(taskId),
      c = before?.context;
    if (
      before?.stage !== 'PR_READY' ||
      !Number.isSafeInteger(c?.prNumber) ||
      typeof c?.ciHeadSha !== 'string' ||
      !Array.isArray(c?.required)
    )
      throw Error('PR is not ready for preview');
    const url = await this.preview.ensure(taskId, c.prNumber as number, c.ciHeadSha);
    const latest = await this.github.checkCi(c.prNumber as number, c.required as string[]),
      after = this.store.getProgress(taskId);
    if (
      latest.status !== 'passed' ||
      latest.headSha !== c.ciHeadSha ||
      after?.stage !== 'PR_READY' ||
      after.version !== before.version ||
      after.context.ciHeadSha !== c.ciHeadSha
    ) {
      if (after?.stage === 'PR_READY' && after.version === before.version)
        this.store.transition?.(taskId, before.version, 'CI_CHECKING', {
          ...c,
          ciStartedAt: Date.now(),
          ciReason: 'changed_during_preview',
        });
      throw Error('PR changed while preparing preview');
    }
    return `${base}\n\n局域网测试链接：${url}\n预览提交：${c.ciHeadSha}\n手机与 Mac 需在同一可互通局域网，Mac 需保持开机联网。飞书内打不开时请用系统浏览器打开。`;
  }
  async send(taskId: string, base: string): Promise<void> {
    const text = await this.message(taskId, base);
    await this.sendNotice(text, taskId);
    this.preview.markNotified(taskId);
  }
  async reconcile(taskId: string): Promise<void> {
    const p = this.store.getProgress(taskId);
    if (p?.stage === 'PAUSED' && p.context.reason === 'pr_closed') {
      await this.preview.release(taskId);
      return;
    }
    if (p?.stage !== 'PR_READY') return;
    if (this.store.pendingNotices().some((n) => n.taskId === taskId)) return;
    const text = await this.message(
      taskId,
      `PR #${p.context.prNumber} 的局域网验收预览已就绪：https://github.com/blackpill/usmapgames.com/pull/${p.context.prNumber}`,
    );
    if (this.preview.needsNotice(taskId)) {
      await this.sendNotice(text, taskId);
      this.preview.markNotified(taskId);
    }
  }
  async cleanupClosed(): Promise<void> {
    const check =
      this.lastClosureCheck === undefined || Date.now() - this.lastClosureCheck >= 300000;
    if (check) this.lastClosureCheck = Date.now();
    for (const r of this.preview.records()) {
      const p = this.store.getProgress(r.taskId);
      if (
        (p?.stage === 'PAUSED' && p.context.reason === 'pr_closed') ||
        (check && this.github.pullState && (await this.github.pullState(r.pr)) === 'closed')
      )
        await this.preview.release(r.taskId);
    }
  }
}
