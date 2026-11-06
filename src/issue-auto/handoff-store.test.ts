import { it, expect } from 'vitest';
import { IssueStore } from './store.js';
import { HandoffStore } from './handoff-store.js';
const task = {
  taskId: 't',
  repositoryId: 1444221313,
  issueNumber: 1,
  actorId: 1231245,
  action: 'opened' as const,
};
it('persists handoff requests without changing in-flight task versions, and enforces a single owner', () => {
  const s = new IssueStore(':memory:');
  s.importTask(task);
  const h = new HandoffStore(s);
  s.reserveSession('session', 't');
  s.transition('t', 0, 'DEVELOPING', { phase: 'running' });
  h.request('session', 'ou_one');
  expect(h.control('t')).toMatchObject({ mode: 'requested', owner: 'ou_one' });
  expect(s.getProgress('t')?.version).toBe(1);
  expect(() => h.request('session', 'ou_two')).toThrow();
  h.saveFeedback('session', 'ou_one', 'message', 'please fix');
  h.saveFeedback('session', 'ou_one', 'message', 'please fix');
  expect(h.notes('t')).toHaveLength(1);
  expect(h.notes('t')[0].kind).toBe('feedback');
  s.close();
});
it('queues manual messages only in manual mode and prevents duplicate launches after uncertain outcomes', () => {
  const s = new IssueStore(':memory:');
  s.importTask(task);
  s.reserveSession('session', 't');
  const h = new HandoffStore(s);
  h.request('session', 'ou_one');
  h.enterManual('t');
  h.saveFeedback('session', 'ou_one', 'm1', 'fix');
  h.saveFeedback('session', 'ou_one', 'm2', 'second');
  expect(h.nextManual('t')?.id).toBe('m1');
  h.markManual('m1', 'launching');
  expect(h.runningManual('t')?.state).toBe('launching');
  expect(h.nextManual('t')?.id).toBe('m2');
  s.close();
});

it('never releases an execution slot for ambiguous preparation, validation or publish effects', () => {
  for (const phase of [
    'launching',
    'preparing-active',
    'validation-active',
    'publishing',
  ]) {
    const s = new IssueStore(':memory:');
    s.importTask(task);
    s.reserveSession('session', 't');
    s.transition('t', 0, 'BLOCKED', { phase });
    s.acquireExecution('t');
    const h = new HandoffStore(s);
    h.request('session', 'ou_one');
    expect(() => h.enterManual('t')).toThrow();
    expect(s.executionOwner()).toBe('t');
    s.close();
  }
});
it('recovers the global slot from durable manual launch intent even if the slot was lost', () => {
  const s = new IssueStore(':memory:');
  s.importTask(task);
  s.reserveSession('session', 't');
  const h = new HandoffStore(s);
  h.request('session', 'ou_one');
  h.enterManual('t');
  h.saveFeedback('session', 'ou_one', 'm', 'fix');
  h.markManual('m', 'launching');
  s.importTask({ ...task, taskId: 'other', issueNumber: 2 });
  expect(s.acquireExecution('other')).toBe(false);
  s.recoverExecution();
  expect(s.executionOwner()).toBe('t');
  s.close();
});
