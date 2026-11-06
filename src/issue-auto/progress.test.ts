import { it, expect } from 'vitest';
import { IssueStore } from './store.js';
const task = {
  taskId: 't',
  repositoryId: 1444221313,
  issueNumber: 1,
  actorId: 1231245,
  action: 'opened' as const,
};
it('persists state with compare-and-swap and atomically inserts notifications', () => {
  const db = new IssueStore(':memory:');
  db.importTask(task);
  expect(db.getProgress('t')).toMatchObject({ stage: 'RECEIVED', version: 0 });
  expect(db.transition('t', 0, 'PREPARING', { threadId: 'thread' })).toBe(true);
  expect(db.transition('t', 0, 'DEVELOPING', {})).toBe(false);
  expect(db.getProgress('t')).toMatchObject({
    stage: 'PREPARING',
    version: 1,
    context: { threadId: 'thread' },
  });
  expect(db.transition('t', 1, 'BLOCKED', { reason: 'failed' }, 'need help')).toBe(true);
  expect(db.pendingNotices()).toHaveLength(1);
  expect(db.transition('t', 1, 'BLOCKED', {}, 'duplicate')).toBe(false);
  expect(db.pendingNotices()).toHaveLength(1);
  db.close();
});
it('lists only active tasks without losing received tasks after reopen', () => {
  const db = new IssueStore(':memory:');
  db.importTask(task);
  expect(db.listActive()).toEqual(['t']);
  db.transition('t', 0, 'BLOCKED', {}, 'blocked');
  expect(db.listActive()).toEqual([]);
  db.close();
});
it('excludes another live runner and permits recovery only after its process exits', () => {
  const db = new IssueStore(':memory:');
  expect(db.acquireInstance(100, 'one', () => false)).toBe(true);
  expect(db.acquireInstance(101, 'two', () => true)).toBe(false);
  expect(db.acquireInstance(101, 'two', () => false)).toBe(true);
  expect(db.releaseInstance('one')).toBe(false);
  expect(db.releaseInstance('two')).toBe(true);
  db.close();
});
it('persists managed session ownership and rejects competing task owners', () => {
  const db = new IssueStore(':memory:');
  db.importTask(task);
  db.reserveSession('thread', 't');
  expect(db.isManagedSession('thread')).toBe(true);
  expect(() => db.reserveSession('thread', 'other')).toThrow();
  expect(db.isManagedSession('other')).toBe(false);
  db.close();
});
it('reports only committed progress transitions and never lets a UI observer break state', () => {
  const db = new IssueStore(':memory:');
  db.importTask(task);
  const seen: string[] = [];
  db.setProgressObserver((id, stage) => {
    seen.push(`${id}:${stage}`);
    throw Error('ui offline');
  });
  expect(db.transition('t', 0, 'VALIDATING', { threadId: 'session' })).toBe(true);
  expect(db.transition('t', 0, 'DEVELOPING', {})).toBe(false);
  expect(db.getProgress('t')?.stage).toBe('VALIDATING');
  expect(seen).toEqual(['t:VALIDATING']);
  db.close();
});
