import { it, expect, vi } from 'vitest';
import { NotificationReceipts } from './notification-receipts.js';
import { DualNotice } from './dual-notice.js';
const link =
  'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_test&open_thread_id=omt_test&thread_position=6';
it('retains topic record and only retries a failed direct message', async () => {
  const receipts = new NotificationReceipts(':memory:');
  const topic = vi
      .fn()
      .mockResolvedValue({
        messageId: 'om_topic',
        chatId: 'oc_test',
        threadId: 'omt_test',
        position: '6',
      }),
    resolve = vi.fn().mockResolvedValue(link),
    direct = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue('om_dm');
  const notice = new DualNotice(receipts, { topic, resolve, direct }, 'ou_recipient');
  const input = { key: 'task:v1', projectPath: '/p', message: 'PR ready', sessionId: 's' };
  await expect(notice.send(input)).rejects.toThrow('offline');
  await notice.send(input);
  await notice.send(input);
  expect(topic).toHaveBeenCalledTimes(1);
  expect(direct).toHaveBeenCalledTimes(2);
  expect(direct.mock.calls[1][0]).toMatchObject({
    recipient: 'ou_recipient',
    link,
    message: 'PR ready',
  });
  receipts.close();
});
it('does not send a direct message if message positioning or state validation fails', async () => {
  const receipts = new NotificationReceipts(':memory:');
  const io = {
    topic: vi.fn().mockResolvedValue({ messageId: 'om_t', chatId: 'oc_test' }),
    resolve: vi.fn().mockRejectedValue(Error('position unavailable')),
    direct: vi.fn(),
  };
  const notice = new DualNotice(receipts, io, 'ou_recipient');
  await expect(notice.send({ key: 'one', projectPath: '/p', message: 'ready' })).rejects.toThrow();
  expect(io.direct).not.toHaveBeenCalled();
  io.resolve.mockResolvedValue(link);
  await expect(
    notice.send({ key: 'one', projectPath: '/p', message: 'ready', isCurrent: () => false }),
  ).rejects.toThrow();
  expect(io.direct).not.toHaveBeenCalled();
  receipts.close();
});
it('separates payload revisions and generates stable per-channel dedupe IDs', async () => {
  const receipts = new NotificationReceipts(':memory:');
  const io = {
    topic: vi.fn().mockResolvedValue({ messageId: 'om_t', chatId: 'oc_test' }),
    resolve: vi.fn().mockResolvedValue(link),
    direct: vi.fn().mockResolvedValue('om_dm'),
  };
  const notice = new DualNotice(receipts, io, 'ou_recipient');
  await notice.send({ key: 'one', projectPath: '/p', message: 'first' });
  await notice.send({ key: 'one', projectPath: '/p', message: 'changed' });
  expect(io.topic).toHaveBeenCalledTimes(2);
  expect(io.topic.mock.calls[0][0].uuid).not.toBe(io.direct.mock.calls[0][0].uuid);
  expect(io.topic.mock.calls[0][0].uuid.length).toBeLessThanOrEqual(50);
  receipts.close();
});
it('refuses a link that points to a different chat or thread', async () => {
  const receipts = new NotificationReceipts(':memory:');
  const io = {
    topic: vi
      .fn()
      .mockResolvedValue({
        messageId: 'om_t',
        chatId: 'oc_expected',
        threadId: 'omt_expected',
        position: '2',
      }),
    resolve: vi.fn().mockResolvedValue(link),
    direct: vi.fn(),
  };
  await expect(
    new DualNotice(receipts, io, 'ou_recipient').send({
      key: 'x',
      projectPath: '/p',
      message: 'm',
      sessionId: 's',
    }),
  ).rejects.toThrow();
  expect(io.direct).not.toHaveBeenCalled();
  receipts.close();
});
it('restores channel receipts after process restart without reposting the topic', async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'notice-receipts-')),
    'state.sqlite',
  );
  let receipts = new NotificationReceipts(file);
  const io = {
    topic: vi
      .fn()
      .mockResolvedValue({
        messageId: 'om_topic',
        chatId: 'oc_test',
        threadId: 'omt_test',
        position: '6',
      }),
    resolve: vi.fn().mockResolvedValue(link),
    direct: vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue('om_dm'),
  };
  const input = { key: 'test', projectPath: '/p', message: 'm', sessionId: 's' };
  await expect(new DualNotice(receipts, io, 'ou_recipient').send(input)).rejects.toThrow();
  const firstUuid = io.direct.mock.calls[0][0].uuid;
  receipts.close();
  receipts = new NotificationReceipts(file);
  await new DualNotice(receipts, io, 'ou_recipient').send(input);
  expect(io.topic).toHaveBeenCalledTimes(1);
  expect(io.direct.mock.calls[1][0].uuid).toBe(firstUuid);
  receipts.close();
});
it('allows a newly created system-alert topic root but never substitutes a root for a session reply', async () => {
  const receipts = new NotificationReceipts(':memory:');
  const root =
    'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_test&open_thread_id=omt_test&thread_position=-1';
  const io = {
    topic: vi
      .fn()
      .mockResolvedValue({
        messageId: 'om_root',
        chatId: 'oc_test',
        threadId: 'omt_test',
        position: '-1',
      }),
    resolve: vi.fn().mockResolvedValue(root),
    direct: vi.fn().mockResolvedValue('om_dm'),
  };
  const dual = new DualNotice(receipts, io, 'ou_recipient');
  await dual.send({ key: 'system', projectPath: '/p', message: 'system alert' });
  expect(io.direct).toHaveBeenCalledTimes(1);
  await expect(
    dual.send({ key: 'task', projectPath: '/p', message: 'task alert', sessionId: 's' }),
  ).rejects.toThrow();
  expect(io.direct).toHaveBeenCalledTimes(1);
  receipts.close();
});
