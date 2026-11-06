import type { IssueStore, IssueTask } from './store.js';

type Context = Record<string, unknown>;
export type CoordinatorOps = {
  eligible(task: IssueTask): Promise<boolean>;
  prepare(task: IssueTask): Promise<Context>;
  launch(context: Context, failureEvidence: string): Promise<{ threadId: string; turnId: string }>;
  turn(context: Context): Promise<'running' | 'completed' | 'failed'>;
  interrupt?(context: Context): Promise<void>;
  validate(context: Context): Promise<{ passed: boolean; evidence?: string; commit?: string }>;
  publish(context: Context): Promise<{ prNumber: number }>;
  required: string[];
  ciTimeoutMs: number;
};
/** State transitions record intent before external side effects. Ambiguous effects stop for review. */
export class Coordinator {
  private active = new Set<string>();
  constructor(
    private store: IssueStore,
    private ops: CoordinatorOps,
  ) {}
  async step(taskId: string): Promise<void> {
    if (this.active.has(taskId)) return;
    this.active.add(taskId);
    try {
      await this.advance(taskId);
    } finally {
      this.active.delete(taskId);
    }
  }
  private async advance(taskId: string): Promise<void> {
    const task = this.store.get(taskId),
      p = this.store.getProgress(taskId);
    if (!task || !p) return;
    const c = p.context;
    const block = (reason: string) =>
      this.store.transition(
        taskId,
        p.version,
        'BLOCKED',
        { ...c, reason },
        `Issue #${task.issueNumber} 需要人工处理：${reason}`,
      );
    if (typeof c.startedAt === 'number' && Date.now() - c.startedAt >= 2 * 60 * 60_000) {
      if (p.stage === 'DEVELOPING' && c.phase === 'running') {
        try {
          if (!this.ops.interrupt) throw new Error('unavailable');
          await this.ops.interrupt(c);
        } catch {
          block('执行时间达到上限，中断失败，Turn 可能仍在运行');
          return;
        }
        block('执行时间达到上限，已请求中断，请确认 Turn 已停止');
        return;
      }
      block('任务执行时间达到上限');
      return;
    }
    if (p.stage === 'RECEIVED') {
      if (!(await this.ops.eligible(task))) {
        block('Issue 已关闭或没有 Auto 标签');
        return;
      }
      this.store.transition(taskId, p.version, 'PREPARING', {
        phase: 'preparing',
        startedAt: Date.now(),
        turnCount: 0,
      });
      return;
    }
    if (p.stage === 'PREPARING' && c.phase === 'preparing') {
      if (
        !this.store.transition(taskId, p.version, 'PREPARING', { ...c, phase: 'preparing-active' })
      )
        return;
      const prepared = await this.ops.prepare(task);
      this.store.transition(taskId, p.version + 1, 'PREPARING', {
        ...c,
        ...prepared,
        phase: 'ready',
      });
      return;
    }
    if (p.stage === 'PREPARING' && c.phase === 'preparing-active') {
      block('安装或工作区准备结果不确定，进程可能仍在运行');
      return;
    }
    if (
      (p.stage === 'PREPARING' && c.phase === 'ready') ||
      (p.stage === 'DEVELOPING' && c.phase === 'repair-ready')
    ) {
      if (Number(c.turnCount ?? 0) >= 6) {
        block('任务轮次达到上限');
        return;
      }
      if (!(await this.ops.eligible(task))) {
        block('Issue 已关闭或没有 Auto 标签');
        return;
      }
      const launched = { ...c, phase: 'launching', turnCount: Number(c.turnCount ?? 0) + 1 };
      if (!this.store.transition(taskId, p.version, p.stage, launched)) return;
      try {
        const turn = await this.ops.launch(launched, String(c.failedChecks ?? ''));
        if (!turn.threadId || !turn.turnId) throw new Error('missing turn identity');
        this.store.transition(taskId, p.version + 1, 'DEVELOPING', {
          ...launched,
          ...turn,
          phase: 'running',
        });
      } catch {
        this.store.transition(
          taskId,
          p.version + 1,
          'BLOCKED',
          launched,
          `Issue #${task.issueNumber} Codex 启动结果不确定，需要人工核对`,
        );
      }
      return;
    }
    if ((p.stage === 'PREPARING' || p.stage === 'DEVELOPING') && c.phase === 'launching') {
      block('Codex 启动结果不确定，未重复启动');
      return;
    }
    if (p.stage === 'DEVELOPING' && c.phase === 'running') {
      const result = await this.ops.turn(c);
      if (result === 'completed')
        this.store.transition(taskId, p.version, 'VALIDATING', { ...c, phase: 'needs-validation' });
      else if (result === 'failed') block('Codex Turn 失败或中断');
      return;
    }
    if (p.stage === 'VALIDATING' && c.phase === 'validation-active') {
      block('验证结果不确定，验证进程可能仍在运行');
      return;
    }
    if (p.stage === 'VALIDATING') {
      if (
        !this.store.transition(taskId, p.version, 'VALIDATING', {
          ...c,
          phase: 'validation-active',
        })
      )
        return;
      const result = await this.ops.validate(c);
      const version = p.version + 1;
      if (result.passed && result.commit && /^[0-9a-f]{40}$/.test(result.commit))
        this.store.transition(taskId, version, 'CREATING_PR', {
          ...c,
          commit: result.commit,
          phase: 'ready-to-publish',
        });
      else {
        const failures = Number(c.validationFailures ?? 0) + 1;
        const noProgress =
          result.commit && result.commit === c.lastFailedCommit ? Number(c.noProgress ?? 0) + 1 : 0;
        const reason =
          noProgress >= 2
            ? '连续两轮无可验证进展'
            : failures > 3
              ? '本地验证连续失败，达到重试上限'
              : undefined;
        if (reason)
          this.store.transition(
            taskId,
            version,
            'BLOCKED',
            { ...c, reason },
            `Issue #${task.issueNumber} 需要人工处理：${reason}`,
          );
        else
          this.store.transition(taskId, version, 'DEVELOPING', {
            ...c,
            validationFailures: failures,
            noProgress,
            lastFailedCommit: result.commit,
            failedChecks: String(result.evidence ?? '验证失败').slice(0, 4000),
            phase: 'repair-ready',
          });
      }
      return;
    }
    if (p.stage === 'CREATING_PR' && c.phase === 'ready-to-publish') {
      if (
        !this.ops.required.length ||
        !Number.isFinite(this.ops.ciTimeoutMs) ||
        this.ops.ciTimeoutMs <= 0
      ) {
        block('CI 检查或超时时限未配置');
        return;
      }
      if (!this.store.transition(taskId, p.version, 'CREATING_PR', { ...c, phase: 'publishing' }))
        return;
      try {
        const pr = await this.ops.publish(c);
        if (!Number.isSafeInteger(pr.prNumber) || pr.prNumber < 1) throw new Error('invalid PR');
        this.store.transition(taskId, p.version + 1, 'CI_CHECKING', {
          ...c,
          ...pr,
          required: this.ops.required,
          ciStartedAt: Date.now(),
          ciTimeoutMs: this.ops.ciTimeoutMs,
        });
      } catch {
        this.store.transition(
          taskId,
          p.version + 1,
          'BLOCKED',
          { ...c, phase: 'publishing' },
          `Issue #${task.issueNumber} PR 创建或推送结果不确定，需要人工核对`,
        );
      }
      return;
    }
    if (p.stage === 'CREATING_PR' && c.phase === 'publishing')
      block('PR 创建或推送结果不确定，未重复提交');
  }
}
