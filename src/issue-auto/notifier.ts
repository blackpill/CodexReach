import type { IssueStore } from './store.js';
import type { CiResult } from './github.js';
/** Send at least once. If a response is lost after delivery, duplicates remain possible. */
export async function deliverNotices(
  store: IssueStore,
  send: (message: string, taskId: string, version: number) => Promise<void>,
  github?:
    | { checkCi(prNumber: number, required: string[]): Promise<CiResult> }
    | ((taskId: string) => {
        checkCi(prNumber: number, required: string[]): Promise<CiResult>;
      }),
): Promise<void> {
  const failures: unknown[] = [];
  for (const notice of store.pendingNotices()) {
    try {
      const progress = store.getProgress(notice.taskId);
      if (!progress || progress.version !== notice.version) {
        store.markNoticeDelivered(notice.taskId, notice.version);
        continue;
      }
      if (progress.stage === 'PR_READY') {
        const c = progress.context;
        if (
          !github ||
          !Number.isSafeInteger(c.prNumber) ||
          !Array.isArray(c.required) ||
          typeof c.ciHeadSha !== 'string'
        )
          throw new Error('cannot verify ready notice');
        const client = typeof github === 'function' ? github(notice.taskId) : github;
        const result = await client.checkCi(c.prNumber as number, c.required as string[]);
        if (result.status !== 'passed' || result.headSha !== c.ciHeadSha) {
          if (
            store.transition(notice.taskId, progress.version, 'CI_CHECKING', {
              ...c,
              ciStartedAt: Date.now(),
              ciReason: 'changed_before_notice',
            })
          )
            store.markNoticeDelivered(notice.taskId, notice.version);
          continue;
        }
      }
      await send(notice.message, notice.taskId, notice.version);
      store.markNoticeDelivered(notice.taskId, notice.version);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
export async function deliverSystemNotices(
  store: IssueStore,
  send: (message: string, key: string, repositoryId?: number) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const notice of store.pendingSystemNotices()) {
    try {
      await send(notice.message, notice.key, notice.repositoryId);
      store.markSystemNoticeDelivered(notice.key);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
