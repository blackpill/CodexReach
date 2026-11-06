import { it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import worker from '../../worker/src/index.js';
import { IssueStore } from './store.js';
import { ClaimClient } from './claim-client.js';
import { recoverCodexTurn } from './recovery.js';
import { trackCi } from './ci-controller.js';
import { deliverNotices } from './notifier.js';
it('survives lost ack and restart, checks CI and retries notification', async () => {
  const remote = new Database(':memory:');
  remote.exec(fs.readFileSync('worker/migrations/0001_tasks.sql', 'utf8'));
  const wrap = (sql: string, values: unknown[] = []): any => ({
    bind: (...v: unknown[]) => wrap(sql, v),
    first: async () => remote.prepare(sql).get(...values),
    _run: () => remote.prepare(sql).run(...values),
  });
  const env = {
    DB: {
      prepare: (sql: string) => wrap(sql),
      batch: async (xs: any[]) => remote.transaction(() => xs.map((x) => x._run()))(),
    },
    WEBHOOK_SECRET: 'w',
    RUNNER_SECRET: 'r',
    REPOSITORY_ID: '1444221313',
    ACTOR_ID: '1231245',
  };
  const body = JSON.stringify({
    action: 'labeled',
    repository: { id: 1444221313 },
    sender: { id: 1231245 },
    label: { name: 'Auto' },
    issue: { number: 12, state: 'open' },
  });
  const request = new Request('https://q.test/webhook', {
    method: 'POST',
    headers: {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'w').update(body).digest('hex'),
    },
    body,
  });
  expect((await worker.fetch(request, env)).status).toBe(202);
  const store = new IssueStore(':memory:');
  let lost = true;
  const fetcher: typeof fetch = async (url, options) => {
    const request = new Request(url, options);
    if (new URL(request.url).pathname === '/ack' && lost) {
      lost = false;
      throw Error('offline');
    }
    return worker.fetch(request, env);
  };
  const client = new ClaimClient('https://q.test', 'r', 'mac', store, fetcher);
  await expect(client.poll()).rejects.toThrow('offline');
  expect(store.count()).toBe(1);
  remote.prepare('UPDATE tasks SET lease_until=0').run();
  await client.poll();
  expect(store.count()).toBe(1);
  const id = (remote.prepare('SELECT id FROM tasks').get() as any).id;
  store.transition(id, 0, 'DEVELOPING', { threadId: 'thread', turnId: 'turn' });
  await recoverCodexTurn(store, id, {
    readThread: vi.fn().mockResolvedValue({ turns: [{ id: 'turn', status: 'completed' }] }),
    resumeThread: vi.fn(),
  });
  let state = store.getProgress(id)!;
  expect(state.stage).toBe('VALIDATING');
  store.transition(id, state.version, 'CI_CHECKING', { prNumber: 7, required: ['verify'] });
  const github = {
    checkCi: vi.fn().mockResolvedValue({ status: 'passed', headSha: 'a'.repeat(40) }),
  };
  await trackCi(store, id, github);
  const send = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined);
  await expect(deliverNotices(store, send, github)).rejects.toThrow('offline');
  expect(store.pendingNotices()).toHaveLength(1);
  await deliverNotices(store, send, github);
  expect(store.pendingNotices()).toHaveLength(0);
  expect(send).toHaveBeenCalledTimes(2);
  store.close();
  remote.close();
});
it('drives the coordinator through a CI failure, repair and notification retry', async () => {
  const { Coordinator } = await import('./coordinator.js');
  const { IssueService } = await import('./service.js');
  const store = new IssueStore(':memory:');
  store.importTask({
    taskId: 'task',
    repositoryId: 1444221313,
    issueNumber: 12,
    actorId: 1231245,
    action: 'labeled',
  });
  let turn = 0,
    checks = 0;
  const ops = {
    eligible: vi.fn().mockResolvedValue(true),
    prepare: vi.fn().mockResolvedValue({ branch: 'codex/issue-12-task' }),
    launch: vi
      .fn()
      .mockImplementation(async () => ({ threadId: 'thread', turnId: `turn${++turn}` })),
    turn: vi.fn().mockResolvedValue('completed'),
    validate: vi.fn().mockResolvedValue({ passed: true, commit: 'a'.repeat(40) }),
    publish: vi.fn().mockResolvedValue({ prNumber: 7 }),
    required: ['verify'],
    ciTimeoutMs: 60000,
  };
  const github = {
    downloadJobLogs: vi.fn().mockResolvedValue('complete logs'),
    checkCi: vi
      .fn()
      .mockImplementation(async () =>
        ++checks === 1
          ? { status: 'failed', jobId: 42, reason: 'failure:verify', headSha: 'a'.repeat(40) }
          : { status: 'passed', headSha: 'a'.repeat(40) },
      ),
  };
  const send = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined);
  const service = new IssueService(
    store,
    { poll: vi.fn().mockResolvedValue(undefined) },
    new Coordinator(store, ops),
    (id) => trackCi(store, id, github, Date.now(), () => '/tmp/fake-ci-log'),
    () => deliverNotices(store, send, github),
    () => {},
  );
  for (let i = 0; i < 20; i++) await service.runOnce();
  expect(store.getProgress('task')?.stage).toBe('PR_READY');
  expect(ops.launch).toHaveBeenCalledTimes(2);
  expect(ops.launch.mock.calls[1][1]).toContain('failure:verify');
  expect(send).toHaveBeenCalledTimes(2);
  expect(store.pendingNotices()).toHaveLength(0);
  store.close();
});
