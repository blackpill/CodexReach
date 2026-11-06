import { createHash } from 'node:crypto';
import type { NotificationReceipts } from './notification-receipts.js';
export type TopicReceipt = {
  messageId: string;
  chatId: string;
  threadId?: string;
  position?: string;
  appLink?: string;
};
type IO = {
  topic(input: {
    projectPath: string;
    message: string;
    sessionId?: string;
    uuid: string;
  }): Promise<TopicReceipt>;
  resolve(receipt: TopicReceipt): Promise<string>;
  direct(input: {
    recipient: string;
    message: string;
    link: string;
    uuid: string;
  }): Promise<string>;
};
export type DualInput = {
  key: string;
  projectPath: string;
  message: string;
  sessionId?: string;
  isCurrent?: () => boolean;
};
export class DualNotice {
  private pending = new Map<string, Promise<void>>();
  constructor(
    private receipts: NotificationReceipts,
    private io: IO,
    private recipient: string,
  ) {
    if (!/^ou_[A-Za-z0-9]+$/.test(recipient)) throw Error('invalid direct notification recipient');
  }
  send(input: DualInput): Promise<void> {
    const key = createHash('sha256')
      .update(JSON.stringify([input.key, input.projectPath, input.sessionId ?? '', input.message]))
      .digest('hex');
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise = this.deliver(key, input);
    this.pending.set(key, promise);
    void promise.finally(() => this.pending.delete(key)).catch(() => {});
    return promise;
  }
  private async deliver(key: string, input: DualInput): Promise<void> {
    if (input.isCurrent && !input.isCurrent()) throw Error('notification became stale');
    const uuid = (channel: string) =>
      'issue-notice-' +
      createHash('sha256')
        .update(key + channel)
        .digest('hex')
        .slice(0, 32);
    let topic = this.receipts.get<TopicReceipt>(key, 'topic');
    if (!topic) {
      topic = await this.io.topic({
        projectPath: input.projectPath,
        message: input.message,
        sessionId: input.sessionId,
        uuid: uuid('topic'),
      });
      if (!topic.messageId || !topic.chatId) throw Error('missing topic receipt');
      this.receipts.save(key, 'topic', topic);
    }
    const channel = `dm:${this.recipient}`;
    if (this.receipts.get(key, channel)) return;
    const link = await this.io.resolve(topic),
      url = new URL(link);
    const position = url.searchParams.get('thread_position');
    const chat = url.searchParams.get('open_chat_id') ?? url.searchParams.get('openchatid'),
      thread = url.searchParams.get('open_thread_id') ?? url.searchParams.get('openthreadid');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'applink.feishu.cn' ||
      url.username ||
      url.password ||
      url.port ||
      position === null ||
      (!/^\d+$/.test(position) && position !== '-1') ||
      (input.sessionId && position === '-1') ||
      chat !== topic.chatId ||
      (topic.threadId && thread !== topic.threadId) ||
      (topic.position !== undefined && position !== topic.position) ||
      (url.searchParams.has('openchatid') && url.searchParams.get('openchatid') !== chat) ||
      (url.searchParams.has('openthreadid') && url.searchParams.get('openthreadid') !== thread)
    )
      throw Error('missing or mismatched precise topic message link');
    if (input.isCurrent && !input.isCurrent()) throw Error('notification became stale');
    const messageId = await this.io.direct({
      recipient: this.recipient,
      message: input.message,
      link,
      uuid: uuid(channel),
    });
    if (!messageId) throw Error('missing direct notification receipt');
    this.receipts.save(key, channel, { messageId });
  }
}
