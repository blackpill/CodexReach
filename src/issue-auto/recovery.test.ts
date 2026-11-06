import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { recoverCodexTurn } from './recovery.js';
const t = {
  taskId: 't',
  repositoryId: 1444221313,
  issueNumber: 1,
  actorId: 1231245,
  action: 'opened' as const,
};
it('reconciles an existing turn without starting another', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(t);
  store.transition('t', 0, 'DEVELOPING', { threadId: 'thread', turnId: 'turn' });
  const codex = {
    resumeThread: vi.fn().mockResolvedValue(undefined),
    readThread: vi.fn().mockResolvedValue({ turns: [{ id: 'turn', status: 'inProgress' }] }),
  };
  expect(await recoverCodexTurn(store, 't', codex)).toBe('running');
  expect(store.getProgress('t')?.stage).toBe('DEVELOPING');
  codex.readThread.mockResolvedValue({ turns: [{ id: 'turn', status: 'completed' }] });
  expect(await recoverCodexTurn(store, 't', codex)).toBe('completed');
  expect(store.getProgress('t')?.stage).toBe('VALIDATING');
  store.close();
});
it('blocks unknown launch outcome rather than starting twice', async () => {
  const store = new IssueStore(':memory:');
  store.importTask(t);
  store.transition('t', 0, 'DEVELOPING', { threadId: 'thread', turnLaunchUncertain: true });
  const codex = { resumeThread: vi.fn(), readThread: vi.fn() };
  expect(await recoverCodexTurn(store, 't', codex)).toBe('blocked');
  expect(store.getProgress('t')?.stage).toBe('BLOCKED');
  expect(store.pendingNotices()).toHaveLength(1);
  store.close();
});
