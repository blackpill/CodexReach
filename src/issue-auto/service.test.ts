import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { IssueService } from './service.js';
it('advances already imported tasks and retries notices even if queue is offline', async () => {
  const store = new IssueStore(':memory:');
  store.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  const queue = { poll: vi.fn().mockRejectedValue(Error('offline')) },
    coordinator = { step: vi.fn().mockResolvedValue(undefined) };
  const service = new IssueService(store, queue, coordinator, vi.fn(), vi.fn(), () => {});
  await service.runOnce();
  expect(coordinator.step).toHaveBeenCalledWith('t');
  store.close();
});
it('waits for an active tick before allowing shutdown', async () => {
  const store = new IssueStore(':memory:');
  let finish!: () => void;
  const queue = {
    poll: vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    ),
  };
  const service = new IssueService(store, queue, { step: vi.fn() }, vi.fn(), vi.fn(), () => {});
  service.start();
  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish();
  await stopping;
  expect(stopped).toBe(true);
  store.close();
});
it('persists repeated task errors and escalates instead of retrying forever', async () => {
  const store = new IssueStore(':memory:');
  store.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  const service = new IssueService(
    store,
    { poll: vi.fn().mockResolvedValue(undefined) },
    { step: vi.fn().mockRejectedValue(Error('failure')) },
    vi.fn(),
    vi.fn(),
    () => {},
  );
  await service.runOnce();
  await service.runOnce();
  await service.runOnce();
  expect(store.getProgress('t')?.stage).toBe('BLOCKED');
  expect(store.pendingNotices()).toHaveLength(1);
  store.close();
});
it('rechecks ready PRs without checking more than once per interval', async () => {
  vi.useFakeTimers();
  const store = new IssueStore(':memory:');
  store.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  store.transition('t', 0, 'PR_READY', {});
  const check = vi.fn().mockResolvedValue(undefined);
  const service = new IssueService(
    store,
    { poll: vi.fn().mockResolvedValue(undefined) },
    { step: vi.fn() },
    vi.fn(),
    vi.fn(),
    () => {},
    10000,
    check,
  );
  await service.runOnce();
  await service.runOnce();
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300001);
  await service.runOnce();
  expect(check).toHaveBeenCalledTimes(2);
  store.close();
  vi.useRealTimers();
});
it('advances only one issue at a time', async () => {
  const store = new IssueStore(':memory:');
  for (const [id, n] of [
    ['one', 1],
    ['two', 2],
  ] as const)
    store.importTask({
      taskId: id,
      repositoryId: 1444221313,
      issueNumber: n,
      actorId: 1231245,
      action: 'opened',
    });
  const coordinator = { step: vi.fn().mockResolvedValue(undefined) };
  const service = new IssueService(
    store,
    { poll: vi.fn().mockResolvedValue(undefined) },
    coordinator,
    vi.fn(),
    vi.fn(),
    () => {},
  );
  await service.runOnce();
  expect(coordinator.step).toHaveBeenCalledTimes(1);
  expect(coordinator.step).toHaveBeenCalledWith('one');
  store.close();
});
it('checks webhook delivery history at most every five minutes without blocking task progress', async () => {
  vi.useFakeTimers();
  const store = new IssueStore(':memory:');
  store.importTask({
    taskId: 't',
    repositoryId: 1444221313,
    issueNumber: 1,
    actorId: 1231245,
    action: 'opened',
  });
  const scan = vi.fn().mockRejectedValue(new Error('offline'));
  const step = vi.fn().mockResolvedValue(undefined);
  const service = new IssueService(
    store,
    { poll: vi.fn().mockResolvedValue(undefined) },
    { step },
    vi.fn(),
    vi.fn(),
    () => {},
    10000,
    undefined,
    scan,
  );
  await service.runOnce();
  await service.runOnce();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(step).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(300001);
  await service.runOnce();
  expect(scan).toHaveBeenCalledTimes(2);
  store.close();
  vi.useRealTimers();
});
