import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { HandoffStore } from './handoff-store.js';
import { Coordinator } from './coordinator.js';
it('a pending handoff prevents a new automatic Turn even if requested during an async eligibility check', async () => {
  const s = new IssueStore(':memory:');
  s.importTask({
    taskId: 't',
    repositoryId: 1,
    issueNumber: 1,
    actorId: 1,
    action: 'opened',
  });
  s.reserveSession('session', 't');
  s.transition('t', 0, 'DEVELOPING', { phase: 'repair-ready' });
  const h = new HandoffStore(s);
  const ops = {
    eligible: vi.fn().mockImplementation(async () => {
      h.request('session', 'ou_one');
      return true;
    }),
    prepare: vi.fn(),
    launch: vi.fn(),
    turn: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
    required: ['verify'],
    ciTimeoutMs: 1000,
  };
  await new Coordinator(s, ops).step('t');
  expect(ops.launch).not.toHaveBeenCalled();
  expect(s.executionOwner()).toBeUndefined();
  s.close();
});
it('a pending handoff still observes an existing Turn to its terminal boundary', async () => {
  const s = new IssueStore(':memory:');
  s.importTask({
    taskId: 't',
    repositoryId: 1,
    issueNumber: 1,
    actorId: 1,
    action: 'opened',
  });
  s.reserveSession('session', 't');
  s.transition('t', 0, 'DEVELOPING', {
    phase: 'running',
    threadId: 'session',
    turnId: 'turn',
  });
  new HandoffStore(s).request('session', 'ou_one');
  const ops = {
    eligible: vi.fn(),
    prepare: vi.fn(),
    launch: vi.fn(),
    turn: vi.fn().mockResolvedValue('completed'),
    validate: vi.fn(),
    publish: vi.fn(),
    required: ['verify'],
    ciTimeoutMs: 1000,
  };
  const c = new Coordinator(s, ops);
  await c.step('t');
  await c.step('t');
  expect(ops.turn).toHaveBeenCalledTimes(1);
  expect(ops.validate).not.toHaveBeenCalled();
  s.close();
});
