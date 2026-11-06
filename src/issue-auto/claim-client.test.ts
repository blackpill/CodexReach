import { describe, it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { ClaimClient } from './claim-client.js';
const claim = {
  task: {
    taskId: 'id1',
    repositoryId: 1444221313,
    issueNumber: 12,
    actorId: 1231245,
    action: 'labeled',
  },
  leaseToken: 'token',
  leaseVersion: 1,
};
describe('local durable handoff', () => {
  it('persists before acknowledgment and tolerates redelivery', async () => {
    const store = new IssueStore(':memory:');
    let calls = 0;
    const fetcher = vi.fn(async (url: any) => {
      if (String(url).endsWith('/claim')) return Response.json(claim);
      expect(store.get('id1')?.issueNumber).toBe(12);
      calls++;
      if (calls === 1) throw Error('lost response');
      return Response.json({ delivered: true });
    });
    const client = new ClaimClient(
      'https://example.test',
      'secret',
      'mac',
      store,
      fetcher as typeof fetch,
    );
    await expect(client.poll()).rejects.toThrow('lost response');
    await client.poll();
    expect(store.count()).toBe(1);
    expect(calls).toBe(2);
    store.close();
  });
  it('does not acknowledge invalid or untrusted data', async () => {
    const store = new IssueStore(':memory:');
    const fetcher = vi.fn(async () =>
      Response.json({ ...claim, task: { ...claim.task, actorId: 1 } }),
    );
    const client = new ClaimClient(
      'https://example.test',
      'secret',
      'mac',
      store,
      fetcher as typeof fetch,
    );
    await expect(client.poll()).rejects.toThrow('untrusted');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.count()).toBe(0);
    store.close();
  });
});
