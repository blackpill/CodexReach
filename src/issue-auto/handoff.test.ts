import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { HandoffStore } from './handoff-store.js';
import { HandoffController } from './handoff.js';
function fixture(stage: any = 'PR_READY', phase = 'ready-to-publish') {
  const s = new IssueStore(':memory:');
  s.importTask({
    taskId: 'task',
    repositoryId: 1,
    issueNumber: 1,
    actorId: 1,
    action: 'opened',
  });
  s.reserveSession('session', 'task');
  s.transition('task', 0, stage, {
    phase,
    threadId: 'session',
    turnId: 'auto',
    worktreePath: '/tree',
    branch: 'codex/issue-1-task',
    baseSha: 'a'.repeat(40),
    prNumber: 7,
  });
  const h = new HandoffStore(s);
  const codex = {
    readThread: vi.fn().mockResolvedValue({
      cwd: '/tree',
      turns: [{ id: 'auto', status: 'completed' }],
    }),
    sendManaged: vi.fn().mockResolvedValue({ turn: { id: 'manual' } }),
  };
  const deps = {
    checkResume: vi.fn().mockResolvedValue(undefined),
    ui: vi.fn().mockResolvedValue(undefined),
    onManualTurn: vi.fn().mockResolvedValue(undefined),
  };
  const c = new HandoffController(s, h, codex, deps);
  return { s, h, c, codex, deps };
}
it('waits for an active automatic turn then safely pauses before validation', async () => {
  const x = fixture('DEVELOPING', 'running');
  x.s.acquireExecution('task');
  x.codex.readThread.mockResolvedValue({
    cwd: '/tree',
    turns: [{ id: 'auto', status: 'inProgress' }],
  });
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  expect(x.h.control('task').mode).toBe('requested');
  expect(x.s.getProgress('task')?.stage).toBe('DEVELOPING');
  x.codex.readThread.mockResolvedValue({
    cwd: '/tree',
    turns: [{ id: 'auto', status: 'completed' }],
  });
  await x.c.step();
  expect(x.h.control('task').mode).toBe('manual');
  expect(x.s.getProgress('task')?.stage).toBe('PAUSED');
  expect(x.s.executionOwner()).toBeUndefined();
  x.s.close();
});
it('serializes manual messages with the global slot and resumes automatic repair after manual completion', async () => {
  const x = fixture();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'feedback',
    text: 'fix layout',
    messageId: 'm1',
  });
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'feedback',
    text: 'fix layout',
    messageId: 'm1',
  });
  await x.c.step();
  expect(x.codex.sendManaged).toHaveBeenCalledTimes(1);
  expect(x.s.executionOwner()).toBe('task');
  await x.c.handle({ sessionId: 'session', actor: 'ou_one', action: 'resume' });
  x.codex.readThread.mockResolvedValue({
    cwd: '/tree',
    turns: [
      { id: 'auto', status: 'completed' },
      { id: 'manual', status: 'completed' },
    ],
  });
  await x.c.step();
  expect(x.s.getProgress('task')).toMatchObject({
    stage: 'DEVELOPING',
    context: { phase: 'repair-ready', turnCount: 0 },
  });
  expect(x.s.getProgress('task')?.context.failedChecks).toContain('fix layout');
  expect(x.h.control('task').mode).toBe('auto');
  x.s.close();
});
it('preserves locks on an uncertain manual launch and never repeats it', async () => {
  const x = fixture();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'feedback',
    text: 'fix',
    messageId: 'm1',
  });
  x.codex.sendManaged.mockRejectedValue(Error('request timeout'));
  await x.c.step();
  await x.c.step();
  expect(x.h.control('task').mode).toBe('blocked');
  expect(x.codex.sendManaged).toHaveBeenCalledTimes(1);
  expect(x.s.executionOwner()).toBe('task');
  x.s.close();
});
it('rejects unsafe validation outcomes and refuses automatic updates to closed PRs', async () => {
  const x = fixture('BLOCKED', 'validation-active');
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  expect(x.h.control('task').mode).toBe('requested');
  expect(x.codex.sendManaged).not.toHaveBeenCalled();
  x.s.transition('task', 1, 'PR_READY', {
    ...x.s.getProgress('task')!.context,
    phase: 'ready-to-publish',
  });
  await x.c.step();
  x.deps.checkResume.mockRejectedValue(Error('PR 已关闭，请新建后续 Issue'));
  await x.c.handle({ sessionId: 'session', actor: 'ou_one', action: 'resume' });
  await x.c.step();
  expect(x.h.control('task').mode).toBe('manual');
  expect(x.s.getProgress('task')?.stage).toBe('PAUSED');
  x.s.close();
});

it('recovers a recorded manual Turn after restart, waits for its terminal status, then runs the next message', async () => {
  const x = fixture();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  for (const id of ['m1', 'm2'])
    await x.c.handle({
      sessionId: 'session',
      actor: 'ou_one',
      action: 'feedback',
      text: id,
      messageId: id,
    });
  await x.c.step();
  const restarted = new HandoffController(x.s, new HandoffStore(x.s), x.codex, x.deps);
  x.codex.readThread.mockResolvedValue({
    cwd: '/tree',
    turns: [{ id: 'manual', status: 'inProgress' }],
  });
  await restarted.step();
  expect(x.codex.sendManaged).toHaveBeenCalledTimes(1);
  x.codex.readThread.mockResolvedValue({
    cwd: '/tree',
    turns: [{ id: 'manual', status: 'completed' }],
  });
  await restarted.step();
  expect(x.codex.sendManaged).toHaveBeenCalledTimes(2);
  expect(x.h.notes('task')[0].state).toBe('done');
  x.s.close();
});
it('preserves a crashed launch intent and blocks rather than replaying it after restart', async () => {
  const x = fixture();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  x.h.saveFeedback('session', 'ou_one', 'm', 'fix');
  x.s.acquireExecution('task');
  x.h.markManual('m', 'launching');
  await new HandoffController(x.s, new HandoffStore(x.s), x.codex, x.deps).step();
  expect(x.h.control('task').mode).toBe('blocked');
  expect(x.s.executionOwner()).toBe('task');
  expect(x.codex.sendManaged).not.toHaveBeenCalled();
  x.s.close();
});
it('does not launch manual work while another task owns the global execution slot', async () => {
  const x = fixture();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  x.h.saveFeedback('session', 'ou_one', 'm', 'fix');
  x.s.importTask({
    taskId: 'other',
    repositoryId: 1,
    issueNumber: 2,
    actorId: 1,
    action: 'opened',
  });
  x.s.acquireExecution('other');
  await x.c.step();
  expect(x.codex.sendManaged).not.toHaveBeenCalled();
  expect(x.h.nextManual('task')?.id).toBe('m');
  x.s.close();
});
it('waits to resume while manual work runs, includes feedback received while waiting, and tolerates UI failure', async () => {
  const x = fixture();
  x.deps.ui.mockRejectedValue(Error('offline'));
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'takeover',
  });
  await x.c.step();
  x.h.saveFeedback('session', 'ou_one', 'm', 'first');
  await x.c.step();
  await x.c.handle({ sessionId: 'session', actor: 'ou_one', action: 'resume' });
  x.codex.readThread.mockResolvedValue({
    cwd: '/tree',
    turns: [{ id: 'manual', status: 'inProgress' }],
  });
  await x.c.step();
  expect(x.h.control('task').mode).toBe('resume_requested');
  expect(x.deps.checkResume).not.toHaveBeenCalled();
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'feedback',
    text: 'second',
    messageId: 'm2',
  });
  x.codex.readThread.mockResolvedValue({
    cwd: '/tree',
    turns: [{ id: 'manual', status: 'completed' }],
  });
  await x.c.step();
  expect(x.h.control('task').mode).toBe('auto');
  expect(x.s.getProgress('task')?.context.failedChecks).toContain('second');
  expect(x.codex.sendManaged).toHaveBeenCalledTimes(1);
  x.s.close();
});
it('does not start durable manual queues for disabled repositories', async () => {
  const x = fixture();
  await x.c.handle({ sessionId: 'session', actor: 'ou_one', action: 'takeover' });
  await x.c.step();
  x.h.saveFeedback('session', 'ou_one', 'm', 'fix');
  const disabled = new HandoffController(x.s, x.h, x.codex, {
    ...x.deps,
    isEnabled: () => false,
  } as any);
  await disabled.step();
  expect(x.codex.sendManaged).not.toHaveBeenCalled();
  expect(x.h.nextManual('task')?.id).toBe('m');
  x.s.close();
});
it('preserves oversized feedback in a private evidence file and resumes without a capacity deadlock', async () => {
  const x = fixture();
  await x.c.handle({ sessionId: 'session', actor: 'ou_one', action: 'takeover' });
  await x.c.step();
  x.h.saveFeedback('session', 'ou_one', 'm1', 'a'.repeat(16000));
  x.h.saveFeedback('session', 'ou_one', 'm2', 'b'.repeat(16000));
  const persistEvidence = vi.fn().mockReturnValue('/private/evidence.log');
  const c = new HandoffController(x.s, x.h, x.codex, {
    ...x.deps,
    persistEvidence,
  } as any);
  await c.handle({ sessionId: 'session', actor: 'ou_one', action: 'resume' });
  await c.step();
  expect(persistEvidence).toHaveBeenCalledWith(
    'task',
    expect.stringContaining('b'.repeat(16000)),
  );
  expect(x.h.control('task').mode).toBe('auto');
  expect(x.s.getProgress('task')?.context.failedChecks).toContain(
    '/private/evidence.log',
  );
  expect(
    x.s.controlDatabase.prepare('SELECT COUNT(*) AS n FROM issue_auto_feedback').get(),
  ).toEqual({ n: 2 });
  x.s.close();
});
it('never executes resume-only instructions as a manual Turn after a rejected auto request', async () => {
  const x = fixture();
  await x.c.handle({ sessionId: 'session', actor: 'ou_one', action: 'takeover' });
  await x.c.step();
  x.deps.checkResume.mockRejectedValue(Error('workspace mismatch'));
  await x.c.handle({
    sessionId: 'session',
    actor: 'ou_one',
    action: 'resume',
    text: 'verify existing PR only',
    messageId: 'resume-message',
  });
  await x.c.step();
  await x.c.step();
  expect(x.h.control('task').mode).toBe('manual');
  expect(x.codex.sendManaged).not.toHaveBeenCalled();
  expect(x.h.notes('task')).toMatchObject([
    { kind: 'feedback', state: 'feedback', text: 'verify existing PR only' },
  ]);
  x.s.close();
});
