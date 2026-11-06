import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import worker from '../src/index.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync('worker/migrations/0001_tasks.sql', 'utf8'));
  const wrap = (sql: string, values: unknown[] = []): any => ({
    bind: (...args: unknown[]) => wrap(sql, args),
    first: async () => db.prepare(sql).get(...values),
    run: async () => db.prepare(sql).run(...values),
    _run: () => db.prepare(sql).run(...values),
  });
  const env = {
    DB: {
      prepare: (sql: string) => wrap(sql),
      batch: async (items: any[]) => db.transaction(() => items.map((x) => x._run()))(),
    },
    WEBHOOK_SECRET: 'webhook',
    RUNNER_SECRET: 'runner',
    REPOSITORY_ID: '1444221313',
    ACTOR_ID: '1231245',
  };
  return { db, env };
}
const payload = JSON.stringify({
  action: 'labeled',
  repository: { id: 1444221313 },
  sender: { id: 1231245 },
  label: { name: 'Auto' },
  issue: { number: 12, state: 'open' },
});
function hook(id: string, signature?: string) {
  return new Request('https://example.test/webhook', {
    method: 'POST',
    headers: {
      'x-github-event': 'issues',
      'x-github-delivery': id,
      'x-hub-signature-256':
        signature ?? 'sha256=' + createHmac('sha256', 'webhook').update(payload).digest('hex'),
    },
    body: payload,
  });
}
function runner(path: string, body: unknown, auth = 'runner') {
  return new Request('https://example.test' + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('durable webhook queue', () => {
  it('verifies before writing, deduplicates delivery and issue', async () => {
    const { env, db } = setup();
    expect((await worker.fetch(hook('bad', 'sha256=' + '0'.repeat(64)), env)).status).toBe(401);
    expect((await worker.fetch(hook('one'), env)).status).toBe(202);
    expect((await worker.fetch(hook('one'), env)).status).toBe(202);
    expect((await worker.fetch(hook('two'), env)).status).toBe(202);
    expect(db.prepare('SELECT count(*) as n FROM tasks').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) as n FROM deliveries').get()).toEqual({ n: 2 });
  });
  it('leases atomically and only acknowledges current token', async () => {
    const { env } = setup();
    await worker.fetch(hook('one'), env);
    expect((await worker.fetch(runner('/claim', { runnerId: 'mac' }, 'wrong'), env)).status).toBe(
      401,
    );
    const first = await worker.fetch(runner('/claim', { runnerId: 'mac' }), env);
    const claim: any = await first.json();
    expect(claim.task.issueNumber).toBe(12);
    expect((await worker.fetch(runner('/claim', { runnerId: 'other' }), env)).status).toBe(204);
    expect(
      (
        await worker.fetch(
          runner('/ack', {
            taskId: claim.task.taskId,
            leaseToken: 'wrong',
            leaseVersion: claim.leaseVersion,
          }),
          env,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await worker.fetch(
          runner('/ack', {
            taskId: claim.task.taskId,
            leaseToken: claim.leaseToken,
            leaseVersion: claim.leaseVersion,
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect((await worker.fetch(runner('/claim', { runnerId: 'mac' }), env)).status).toBe(204);
  });
});
