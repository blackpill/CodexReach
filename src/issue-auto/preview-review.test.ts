import { it, expect, vi } from 'vitest';
import { PreviewReview } from './preview-review.js';
const sha = 'a'.repeat(40);
function fixture() {
  let progress: any = {
    stage: 'PR_READY',
    version: 1,
    context: { prNumber: 10, ciHeadSha: sha, required: ['verify'] },
  };
  const store = { getProgress: () => progress, pendingNotices: () => [] };
  const manager = {
    ensure: vi.fn().mockResolvedValue('http://192.168.1.2:8800/'),
    markNotified: vi.fn(),
    needsNotice: vi.fn().mockReturnValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    records: (): any[] => [],
  };
  const gh = { checkCi: vi.fn().mockResolvedValue({ status: 'passed', headSha: sha }) };
  const send = vi.fn().mockResolvedValue(undefined);
  return {
    store,
    manager,
    gh,
    send,
    change: (x: any) => {
      progress = x;
    },
  };
}
it('adds LAN URL only after preview smoke and latest CI checks', async () => {
  const x = fixture(),
    review = new PreviewReview(x.store as any, x.manager as any, x.gh, x.send);
  await review.send('task', 'ready');
  expect(x.send.mock.calls[0][0]).toContain('http://192.168.1.2:8800/');
  expect(x.manager.markNotified).toHaveBeenCalledWith('task');
});
it('never sends an old preview after the PR changes during build', async () => {
  const x = fixture();
  x.gh.checkCi.mockResolvedValue({ status: 'pending', headSha: 'b'.repeat(40) } as any);
  const review = new PreviewReview(x.store as any, x.manager as any, x.gh, x.send);
  await expect(review.send('task', 'ready')).rejects.toThrow();
  expect(x.send).not.toHaveBeenCalled();
});
it('backfills once for already-reviewed PRs and releases closed PR previews', async () => {
  const x = fixture(),
    review = new PreviewReview(x.store as any, x.manager as any, x.gh, x.send);
  await review.reconcile('task');
  expect(x.send).toHaveBeenCalledTimes(1);
  x.manager.needsNotice.mockReturnValue(false);
  await review.reconcile('task');
  expect(x.send).toHaveBeenCalledTimes(1);
  x.change({ stage: 'PAUSED', version: 2, context: { reason: 'pr_closed' } });
  await review.reconcile('task');
  expect(x.manager.release).toHaveBeenCalledWith('task');
});
it('reclaims previews for PRs closed while their task was blocked', async () => {
  const x = fixture();
  x.change({ stage: 'BLOCKED', version: 3, context: {} });
  x.manager.records = () => [{ taskId: 'task', pr: 10 } as any];
  const gh = { ...x.gh, pullState: vi.fn().mockResolvedValue('closed') };
  const review = new PreviewReview(x.store as any, x.manager as any, gh, x.send);
  await review.cleanupClosed();
  expect(x.manager.release).toHaveBeenCalledWith('task');
});
it('invalidates local readiness immediately when the remote SHA changes during preview setup', async () => {
  const x = fixture();
  const transition = vi.fn().mockReturnValue(true);
  const store = { ...x.store, transition };
  x.gh.checkCi.mockResolvedValue({ status: 'pending', reason: 'head_changed' } as any);
  await expect(
    new PreviewReview(store as any, x.manager as any, x.gh, x.send).send('task', 'ready'),
  ).rejects.toThrow();
  expect(transition).toHaveBeenCalledWith(
    'task',
    1,
    'CI_CHECKING',
    expect.objectContaining({ ciReason: 'changed_during_preview' }),
  );
});
