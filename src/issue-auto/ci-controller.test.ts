import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { trackCi } from './ci-controller.js';
it('persists PR readiness only after latest-head CI passes', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'CI_CHECKING', { prNumber: 7, required: ['verify'] });
  const github = {
    checkCi: vi.fn().mockResolvedValue({ status: 'pending', reason: 'head_changed' }),
  };
  await trackCi(db, 't', github);
  expect(db.getProgress('t')?.stage).toBe('CI_CHECKING');
  expect(db.pendingNotices()).toHaveLength(0);
  github.checkCi.mockResolvedValue({ status: 'passed', headSha: 'a'.repeat(40) });
  await trackCi(db, 't', github);
  expect(db.getProgress('t')?.stage).toBe('PR_READY');
  expect(db.pendingNotices()[0].message).toContain('/pull/7');
  db.close();
});
it('blocks when CI fails repeatedly and emits notice', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'CI_CHECKING', { prNumber: 7, required: ['verify'], ciFailures: 3 });
  await trackCi(db, 't', {
    checkCi: vi
      .fn()
      .mockResolvedValue({ status: 'failed', reason: 'failure:verify', headSha: 'a'.repeat(40) }),
  });
  expect(db.getProgress('t')?.stage).toBe('BLOCKED');
  expect(db.pendingNotices()).toHaveLength(1);
  db.close();
});
it('notifies when CI remains pending past its deadline', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'CI_CHECKING', {
    prNumber: 7,
    required: ['verify'],
    ciStartedAt: 1000,
    ciTimeoutMs: 10000,
  });
  await trackCi(db, 't', { checkCi: vi.fn().mockResolvedValue({ status: 'pending' }) }, 12000);
  expect(db.getProgress('t')?.stage).toBe('BLOCKED');
  expect(db.pendingNotices()[0].message).toContain('超时');
  db.close();
});
it('returns a failed CI to an explicitly launchable repair phase', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'CI_CHECKING', {
    prNumber: 7,
    required: ['verify'],
    phase: 'ready-to-publish',
  });
  await trackCi(
    db,
    't',
    {
      checkCi: vi
        .fn()
        .mockResolvedValue({
          status: 'failed',
          jobId: 42,
          reason: 'failure:verify',
          headSha: 'a'.repeat(40),
        }),
      downloadJobLogs: vi.fn().mockResolvedValue('logs'),
    },
    Date.now(),
    () => '/tmp/log',
  );
  expect(db.getProgress('t')).toMatchObject({
    stage: 'DEVELOPING',
    context: {
      phase: 'repair-ready',
      failedChecks: expect.stringContaining('failure:verify'),
      ciFailures: 1,
    },
  });
  db.close();
});
it('invalidates ready status if PR head changes after notification', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'PR_READY', {
    prNumber: 7,
    required: ['verify'],
    ciHeadSha: 'a'.repeat(40),
    ciTimeoutMs: 60000,
  });
  const { recheckReady } = await import('./ci-controller.js');
  await recheckReady(
    db,
    't',
    { checkCi: vi.fn().mockResolvedValue({ status: 'pending', reason: 'head_changed' }) },
    12345,
  );
  expect(db.getProgress('t')).toMatchObject({
    stage: 'CI_CHECKING',
    context: { ciStartedAt: 12345 },
  });
  expect(db.pendingNotices()).toHaveLength(1);
  db.close();
});
it('persists full failed-job logs before allowing automated repair', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'CI_CHECKING', { prNumber: 7, required: ['verify'] });
  const gh = {
    checkCi: vi
      .fn()
      .mockResolvedValue({
        status: 'failed',
        jobId: 42,
        reason: 'failure:verify',
        headSha: 'a'.repeat(40),
      }),
    downloadJobLogs: vi.fn().mockResolvedValue('full logs'),
  };
  const save = vi.fn().mockReturnValue('/private/log.txt');
  await trackCi(db, 't', gh, Date.now(), save);
  expect(save).toHaveBeenCalledWith('t', 42, 'full logs');
  expect(db.getProgress('t')).toMatchObject({
    stage: 'DEVELOPING',
    context: { ciLogPath: '/private/log.txt' },
  });
  db.close();
});
it('blocks instead of guessing when complete CI logs are unavailable', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'CI_CHECKING', { prNumber: 7, required: ['verify'] });
  await trackCi(db, 't', {
    checkCi: vi.fn().mockResolvedValue({ status: 'failed', reason: 'failure:verify' }),
  });
  expect(db.getProgress('t')?.stage).toBe('BLOCKED');
  expect(db.pendingNotices()).toHaveLength(1);
  db.close();
});
it('marks a closed PR paused so its local preview can be reclaimed', async () => {
  const db = new IssueStore(':memory:');
  db.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  db.transition('t', 0, 'CI_CHECKING', { prNumber: 7, required: ['verify'] });
  await trackCi(db, 't', {
    checkCi: vi.fn().mockResolvedValue({ status: 'blocked', reason: 'pr_closed' }),
  });
  expect(db.getProgress('t')).toMatchObject({ stage: 'PAUSED', context: { reason: 'pr_closed' } });
  db.close();
});
