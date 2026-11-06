import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { Coordinator } from './coordinator.js';
const task = {
  taskId: 't',
  repositoryId: 1444221313,
  issueNumber: 1,
  actorId: 1231245,
  action: 'opened' as const,
};
it('advances a persisted task through development, repair, validation and PR without overlapping turns', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  let n = 0;
  const ops = {
    eligible: vi.fn().mockResolvedValue(true),
    prepare: vi.fn().mockResolvedValue({ worktreePath: '/tmp/tree', branch: 'codex/issue-1-t' }),
    launch: vi.fn().mockImplementation(async () => ({ threadId: 'thread', turnId: `turn${++n}` })),
    turn: vi.fn().mockResolvedValue('completed'),
    validate: vi
      .fn()
      .mockResolvedValueOnce({ passed: false, evidence: 'test failed' })
      .mockResolvedValueOnce({ passed: true, commit: 'a'.repeat(40) }),
    publish: vi.fn().mockResolvedValue({ prNumber: 7 }),
    required: ['verify'],
    ciTimeoutMs: 60000,
  };
  const c = new Coordinator(store, ops);
  for (let i = 0; i < 10; i++) await c.step('t');
  expect(store.getProgress('t')?.stage).toBe('CI_CHECKING');
  expect(ops.launch).toHaveBeenCalledTimes(2);
  expect(ops.publish).toHaveBeenCalledTimes(1);
  expect(ops.launch.mock.calls[1][1]).toContain('test failed');
  store.close();
});
it('blocks an uncertain launch after restart without launching again', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  store.transition('t', 0, 'PREPARING', { phase: 'launching' });
  const ops = {
    eligible: vi.fn().mockResolvedValue(true),
    prepare: vi.fn(),
    launch: vi.fn(),
    turn: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
    required: ['verify'],
    ciTimeoutMs: 60000,
  };
  await new Coordinator(store, ops).step('t');
  expect(store.getProgress('t')).toMatchObject({
    stage: 'BLOCKED',
    context: { reason: 'Codex 启动结果不确定，未重复启动' },
  });
  expect(ops.launch).not.toHaveBeenCalled();
  store.close();
});
it('stops at the turn budget before starting another repair', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  store.transition('t', 0, 'DEVELOPING', { phase: 'repair-ready', turnCount: 6 });
  const ops = {
    eligible: vi.fn().mockResolvedValue(true),
    prepare: vi.fn(),
    launch: vi.fn(),
    turn: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
    required: ['verify'],
    ciTimeoutMs: 60000,
  };
  await new Coordinator(store, ops).step('t');
  expect(store.getProgress('t')).toMatchObject({
    stage: 'BLOCKED',
    context: { reason: '任务轮次达到上限' },
  });
  expect(ops.launch).not.toHaveBeenCalled();
  store.close();
});
it('blocks after two consecutive repairs without a changed commit', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  store.transition('t', 0, 'VALIDATING', {
    phase: 'needs-validation',
    lastFailedCommit: 'a'.repeat(40),
    noProgress: 1,
  });
  const ops = {
    eligible: vi.fn().mockResolvedValue(true),
    prepare: vi.fn(),
    launch: vi.fn(),
    turn: vi.fn(),
    validate: vi
      .fn()
      .mockResolvedValue({ passed: false, commit: 'a'.repeat(40), evidence: 'failed' }),
    publish: vi.fn(),
    required: ['verify'],
    ciTimeoutMs: 60000,
  };
  await new Coordinator(store, ops).step('t');
  expect(store.getProgress('t')).toMatchObject({
    stage: 'BLOCKED',
    context: { reason: '连续两轮无可验证进展' },
  });
  store.close();
});
it('interrupts an active turn when the execution budget expires', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(task);
  store.transition('t', 0, 'DEVELOPING', {
    phase: 'running',
    threadId: 'thread',
    turnId: 'turn',
    startedAt: Date.now() - 7200001,
  });
  const ops = {
    eligible: vi.fn(),
    prepare: vi.fn(),
    launch: vi.fn(),
    turn: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    required: ['verify'],
    ciTimeoutMs: 60000,
  };
  await new Coordinator(store, ops).step('t');
  expect(ops.interrupt).toHaveBeenCalled();
  expect(store.getProgress('t')?.stage).toBe('BLOCKED');
  store.close();
});
it('never reruns a validation or install with an uncertain outcome after restart', async () => {
  for (const [stage, phase] of [
    ['VALIDATING', 'validation-active'],
    ['PREPARING', 'preparing-active'],
  ] as const) {
    const store = new IssueStore(':memory:');
    store.importTask(task);
    store.transition('t', 0, stage, { phase });
    const ops = {
      eligible: vi.fn(),
      prepare: vi.fn(),
      launch: vi.fn(),
      turn: vi.fn(),
      validate: vi.fn(),
      publish: vi.fn(),
      required: ['verify'],
      ciTimeoutMs: 60000,
    };
    await new Coordinator(store, ops).step('t');
    expect(store.getProgress('t')?.stage).toBe('BLOCKED');
    expect(ops.prepare).not.toHaveBeenCalled();
    expect(ops.validate).not.toHaveBeenCalled();
    store.close();
  }
});
