import type { IssueStore } from './store.js';
import type { CiResult } from './github.js';
export async function trackCi(
  store: IssueStore,
  taskId: string,
  github: {
    checkCi(prNumber: number, required: string[]): Promise<CiResult>;
    downloadJobLogs?(jobId: number): Promise<string>;
  },
  now = Date.now(),
  saveLog?: (taskId: string, jobId: number, log: string) => string,
): Promise<void> {
  const progress = store.getProgress(taskId);
  if (!progress || progress.stage !== 'CI_CHECKING') return;
  const c = progress.context;
  if (
    !Number.isSafeInteger(c.prNumber) ||
    (c.prNumber as number) < 1 ||
    !Array.isArray(c.required) ||
    c.required.some((x) => typeof x !== 'string')
  ) {
    store.transition(
      taskId,
      progress.version,
      'BLOCKED',
      { ...c, reason: 'invalid_ci_configuration' },
      'Issue 任务需要人工处理：CI 配置不完整',
    );
    return;
  }
  if (
    typeof c.ciStartedAt === 'number' &&
    typeof c.ciTimeoutMs === 'number' &&
    c.ciTimeoutMs > 0 &&
    now - c.ciStartedAt >= c.ciTimeoutMs
  ) {
    store.transition(
      taskId,
      progress.version,
      'BLOCKED',
      { ...c, reason: 'ci_timeout' },
      `CI 等待超时，需要人工处理：https://github.com/blackpill/usmapgames.com/pull/${c.prNumber}`,
    );
    return;
  }
  const result = await github.checkCi(c.prNumber as number, c.required as string[]);
  const context = { ...c, ciHeadSha: result.headSha, ciReason: result.reason };
  if (result.status === 'passed') {
    if (!result.headSha || !/^[0-9a-f]{40}$/.test(result.headSha))
      throw new Error('CI result missing head SHA');
    store.transition(
      taskId,
      progress.version,
      'PR_READY',
      context,
      `PR CI 已通过，请审核：https://github.com/blackpill/usmapgames.com/pull/${c.prNumber}\nIssue：#${store.get(taskId)?.issueNumber ?? '?'} ${String(c.issueTitle ?? '').slice(0, 200)}\n提交：${result.headSha}\n检查：${(c.required as string[]).join(', ')}\n未自动验证的业务条件请人工核对。`,
    );
  } else if (result.status === 'blocked' && result.reason === 'pr_closed') {
    store.transition(taskId, progress.version, 'PAUSED', { ...context, reason: 'pr_closed' });
  } else if (result.status === 'blocked') {
    store.transition(
      taskId,
      progress.version,
      'BLOCKED',
      context,
      `Issue 任务需要人工处理：${result.reason ?? 'CI 状态无法确认'}`,
    );
  } else if (result.status === 'failed') {
    const attempts = Number(c.ciFailures ?? 0);
    if (attempts >= 3) {
      store.transition(
        taskId,
        progress.version,
        'BLOCKED',
        context,
        `CI 持续失败，需要人工处理：${result.reason ?? 'unknown'}`,
      );
      return;
    }
    if (!result.jobId || !github.downloadJobLogs || !saveLog) {
      store.transition(
        taskId,
        progress.version,
        'BLOCKED',
        context,
        'CI 失败，但无法获取完整 job 日志，需要人工处理',
      );
      return;
    }
    try {
      const log = await github.downloadJobLogs(result.jobId);
      const ciLogPath = saveLog(taskId, result.jobId, log);
      store.transition(taskId, progress.version, 'DEVELOPING', {
        ...context,
        phase: 'repair-ready',
        ciFailures: attempts + 1,
        ciLogPath,
        failedChecks: `${result.reason ?? 'CI 失败'}\n完整日志本地路径：${ciLogPath}`,
      });
    } catch {
      store.transition(
        taskId,
        progress.version,
        'BLOCKED',
        context,
        'CI 失败，但完整 job 日志下载或保存失败，需要人工处理',
      );
    }
  }
}
export async function recheckReady(
  store: IssueStore,
  taskId: string,
  github: { checkCi(prNumber: number, required: string[]): Promise<CiResult> },
  now = Date.now(),
): Promise<void> {
  const p = store.getProgress(taskId);
  if (!p || p.stage !== 'PR_READY') return;
  const c = p.context;
  if (
    !Number.isSafeInteger(c.prNumber) ||
    !Array.isArray(c.required) ||
    typeof c.ciHeadSha !== 'string'
  )
    throw new Error('invalid ready PR state');
  const result = await github.checkCi(c.prNumber as number, c.required as string[]);
  if (result.status === 'blocked' && result.reason === 'pr_closed') {
    store.transition(taskId, p.version, 'PAUSED', { ...c, reason: 'pr_closed' });
    return;
  }
  if (result.status !== 'passed' || result.headSha !== c.ciHeadSha)
    store.transition(
      taskId,
      p.version,
      'CI_CHECKING',
      { ...c, ciStartedAt: now, ciReason: 'changed_after_notice' },
      `PR 状态已变化，正在重新检查：https://github.com/blackpill/usmapgames.com/pull/${c.prNumber}`,
    );
}
