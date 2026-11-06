import { it, expect, vi } from 'vitest';
import { IssueStore } from './store.js';
import { WebhookRedelivery } from './redelivery.js';
const day = 24 * 60 * 60_000,
  now = Date.parse('2026-11-05T12:00:00Z');
function delivery(id: number, guid: string, status: string) {
  return {
    id: String(id),
    guid,
    status,
    event: 'issues',
    delivered_at: new Date(now - 120000).toISOString(),
  };
}
it('groups by GUID, skips any successful delivery and rate-limits failed retries', async () => {
  const store = new IssueStore(':memory:');
  const gh = {
    listWebhookDeliveries: vi
      .fn()
      .mockResolvedValue({
        items: [
          delivery(1, 'failed', 'Server Error'),
          delivery(2, 'ok', 'Server Error'),
          delivery(3, 'ok', 'OK'),
        ],
      }),
    redeliverWebhook: vi.fn().mockResolvedValue(undefined),
  };
  const monitor = new WebhookRedelivery(store, gh, 10);
  await monitor.scan(now);
  await monitor.scan(now + 1000);
  expect(gh.redeliverWebhook).toHaveBeenCalledTimes(1);
  expect(gh.redeliverWebhook).toHaveBeenCalledWith(10, '1');
  store.close();
});
it('preserves pagination correctness and alerts after retries are exhausted', async () => {
  const store = new IssueStore(':memory:');
  const all = Array.from({ length: 100 }, (_, i) => delivery(i + 1, `ok-${i}`, 'OK'));
  const gh = {
    listWebhookDeliveries: vi
      .fn()
      .mockImplementation(async (_h: number, cursor?: string) =>
        cursor
          ? { items: [delivery(200, 'failed', 'Server Error')] }
          : { items: all, nextCursor: 'next' },
      ),
    redeliverWebhook: vi.fn().mockResolvedValue(undefined),
  };
  const monitor = new WebhookRedelivery(store, gh, 10);
  for (let i = 0; i < 4; i++) await monitor.scan(now + i * 6 * 60_000);
  expect(gh.listWebhookDeliveries).toHaveBeenCalledWith(10, 'next');
  expect(gh.redeliverWebhook).toHaveBeenCalledTimes(3);
  expect(store.pendingSystemNotices()).toHaveLength(1);
  store.close();
});
it('records a monitoring gap after more than three days offline', async () => {
  const store = new IssueStore(':memory:');
  const gh = {
    listWebhookDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    redeliverWebhook: vi.fn(),
  };
  const monitor = new WebhookRedelivery(store, gh, 10);
  await monitor.scan(now);
  await monitor.scan(now + 4 * day);
  expect(store.pendingSystemNotices()[0].message).toContain('3 天');
  store.close();
});
it('waits for fresh or in-flight deliveries and does not retry before a result', async () => {
  const store = new IssueStore(':memory:');
  const gh = {
    listWebhookDeliveries: vi
      .fn()
      .mockResolvedValue({
        items: [
          {
            ...delivery(1, 'fresh', 'Server Error'),
            delivered_at: new Date(now - 1000).toISOString(),
          },
          delivery(2, 'pending', 'Waiting for response'),
        ],
      }),
    redeliverWebhook: vi.fn(),
  };
  await new WebhookRedelivery(store, gh, 10).scan(now);
  expect(gh.redeliverWebhook).not.toHaveBeenCalled();
  store.close();
});
it('persists and alerts after repeated inability to inspect webhook deliveries', async () => {
  const store = new IssueStore(':memory:');
  const gh = {
    listWebhookDeliveries: vi.fn().mockRejectedValue(Error('permission denied')),
    redeliverWebhook: vi.fn(),
  };
  const monitor = new WebhookRedelivery(store, gh, 10);
  for (let i = 0; i < 3; i++) await expect(monitor.scan(now + i * 300000)).rejects.toThrow();
  expect(store.pendingSystemNotices()[0].message).toContain('检查失败');
  store.close();
});
it('does not replay when a success for the same GUID is on a later page', async () => {
  const store = new IssueStore(':memory:');
  const gh = {
    listWebhookDeliveries: vi
      .fn()
      .mockImplementation(async (_h: number, cursor?: string) =>
        cursor
          ? { items: [delivery(2, 'same', 'OK')] }
          : { items: [delivery(1, 'same', 'Server Error')], nextCursor: 'next' },
      ),
    redeliverWebhook: vi.fn(),
  };
  await new WebhookRedelivery(store, gh, 10).scan(now);
  expect(gh.redeliverWebhook).not.toHaveBeenCalled();
  store.close();
});
it('does not submit any redelivery when pagination is incomplete', async () => {
  const store = new IssueStore(':memory:');
  const gh = {
    listWebhookDeliveries: vi
      .fn()
      .mockResolvedValue({ items: [delivery(1, 'failed', 'Server Error')], nextCursor: 'repeat' }),
    redeliverWebhook: vi.fn(),
  };
  await expect(new WebhookRedelivery(store, gh, 10).scan(now)).rejects.toThrow('cursor');
  expect(gh.redeliverWebhook).not.toHaveBeenCalled();
  store.close();
});
it('attempts independent failed GUIDs even when one redelivery request fails', async () => {
  const store = new IssueStore(':memory:');
  const gh = {
    listWebhookDeliveries: vi
      .fn()
      .mockResolvedValue({
        items: [delivery(1, 'first', 'Server Error'), delivery(2, 'second', 'Server Error')],
      }),
    redeliverWebhook: vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValue(undefined),
  };
  await expect(new WebhookRedelivery(store, gh, 10).scan(now)).rejects.toThrow();
  expect(gh.redeliverWebhook).toHaveBeenCalledTimes(2);
  store.close();
});
