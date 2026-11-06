import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { deliverNotices } from './notifier.js';
it('keeps failed notifications in the outbox and marks only successful sends', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'BLOCKED', {}, '需要人工处理');
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  await expect(deliverNotices(db, send)).rejects.toThrow('offline');
  expect(db.pendingNotices()).toHaveLength(1);
  await deliverNotices(db, send);
  expect(db.pendingNotices()).toHaveLength(0);
  db.close();
});
it('rechecks CI head before sending ready notices and drops stale notices', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition(
    't',
    0,
    'PR_READY',
    { prNumber: 7, required: ['verify'], ciHeadSha: 'a'.repeat(40) },
    '审核',
  );
  const send = vi.fn();
  const check = vi.fn().mockResolvedValue({ status: 'passed', headSha: 'b'.repeat(40) });
  await deliverNotices(db, send, { checkCi: check });
  expect(send).not.toHaveBeenCalled();
  expect(db.getProgress('t')?.stage).toBe('CI_CHECKING');
  expect(db.pendingNotices()).toHaveLength(0);
  db.close();
});
it('retries webhook system alerts until Feishu accepts them', async () => {
  const db = new IssueStore(':memory:');
  db.addSystemNotice('key', 'Webhook 检查失败');
  const send = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined);
  const { deliverSystemNotices } = await import('./notifier.js');
  await expect(deliverSystemNotices(db, send)).rejects.toThrow();
  expect(db.pendingSystemNotices()).toHaveLength(1);
  await deliverSystemNotices(db, send);
  expect(db.pendingSystemNotices()).toHaveLength(0);
  db.close();
});
it('starts a new CI wait budget when a ready notice becomes stale', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition(
    't',
    0,
    'PR_READY',
    { prNumber: 7, required: ['verify'], ciHeadSha: 'old', ciStartedAt: 1, ciTimeoutMs: 10000 },
    'ready',
  );
  const before = Date.now();
  await deliverNotices(db, vi.fn(), {
    checkCi: vi.fn().mockResolvedValue({ status: 'pending', reason: 'head_changed' }),
  });
  expect(db.getProgress('t')?.context.ciStartedAt).toBeGreaterThanOrEqual(before);
  db.close();
});
it('does not let one failed notification starve other task notices', async () => {
  const db = new IssueStore(':memory:');
  for (const [id, n] of [
    ['first', 1],
    ['second', 2],
  ] as const) {
    db.importTask({
      taskId: id,
      repositoryId: 1444221313,
      issueNumber: n,
      actorId: 1231245,
      action: 'opened',
    });
    db.transition(id, 0, 'BLOCKED', {}, id);
  }
  const send = vi
    .fn()
    .mockRejectedValueOnce(Error('preview unavailable'))
    .mockResolvedValue(undefined);
  await expect(deliverNotices(db, send)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(2);
  expect(db.pendingNotices().map((n) => n.taskId)).toEqual(['first']);
  db.close();
});
