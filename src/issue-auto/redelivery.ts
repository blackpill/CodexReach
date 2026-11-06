import type { IssueStore } from './store.js';
export type WebhookDelivery = {
  id: string;
  guid: string;
  status: string;
  event: string;
  delivered_at: string;
};
type Client = {
  listWebhookDeliveries(
    hookId: number,
    cursor?: string,
  ): Promise<{ items: WebhookDelivery[]; nextCursor?: string }>;
  redeliverWebhook(hookId: number, deliveryId: string): Promise<void>;
};
const WINDOW = 72 * 60 * 60_000,
  COOLDOWN = 5 * 60_000,
  MAX_ATTEMPTS = 3;
/** Polls webhook delivery history, never Issue state. GitHub retains deliveries only for a limited window. */
export class WebhookRedelivery {
  constructor(
    private store: IssueStore,
    private client: Client,
    private hookId: number,
  ) {
    if (!Number.isSafeInteger(hookId) || hookId < 1) throw new Error('invalid webhook id');
  }
  async scan(now = Date.now()): Promise<void> {
    try {
      await this.scanHistory(now);
      this.store.clearWebhookFailure(this.hookId);
    } catch (error) {
      const count = this.store.recordWebhookFailure(this.hookId);
      if (count >= 3)
        this.store.addSystemNotice(
          `webhook-monitor:${this.hookId}:${Math.floor(now / 86400000)}`,
          'GitHub Webhook 投递检查失败，无法确认失败事件是否已重投，请检查 GitHub 权限和网络。',
        );
      throw error;
    }
  }
  private async scanHistory(now: number): Promise<void> {
    const prior = this.store.lastWebhookScan(this.hookId);
    if (prior !== undefined && now - prior > WINDOW)
      this.store.addSystemNotice(
        `webhook-gap:${this.hookId}:${prior}`,
        'Webhook 投递检查中断超过 3 天，部分历史投递可能已无法重投，请人工核对 GitHub 事件。',
      );
    const groups = new Map<string, WebhookDelivery[]>();
    let complete = false;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const result = await this.client.listWebhookDeliveries(this.hookId, cursor);
      const rows = result.items;
      if (!Array.isArray(rows) || rows.length > 100)
        throw new Error('invalid webhook delivery page');
      for (const row of rows) {
        if (
          typeof row.id !== 'string' ||
          !/^\d{1,25}$/.test(row.id) ||
          /^0+$/.test(row.id) ||
          typeof row.guid !== 'string' ||
          !row.guid ||
          row.guid.length > 128 ||
          typeof row.status !== 'string' ||
          !Number.isFinite(Date.parse(row.delivered_at))
        )
          throw new Error('invalid webhook delivery record');
        if (row.event !== 'issues' || Date.parse(row.delivered_at) < now - WINDOW) continue;
        const group = groups.get(row.guid) ?? [];
        group.push(row);
        groups.set(row.guid, group);
      }
      if (!result.nextCursor) {
        complete = true;
        break;
      }
      if (seen.has(result.nextCursor)) throw new Error('repeated webhook cursor');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    if (!complete) throw new Error('webhook history exceeds safe pagination limit');
    let failed = false;
    for (const [guid, rows] of groups) {
      if (rows.some((row) => row.status === 'OK')) continue;
      const newest = Math.max(...rows.map((row) => Date.parse(row.delivered_at)));
      if (
        now - newest < 60_000 ||
        (rows.some((row) => /waiting|pending|in.progress/i.test(row.status)) &&
          now - newest < COOLDOWN)
      )
        continue;
      const previous = this.store.webhookRetry(this.hookId, guid);
      if (previous && now - previous.lastAttempt < COOLDOWN) continue;
      if (previous && previous.attempts >= MAX_ATTEMPTS) {
        this.store.addSystemNotice(
          `webhook-failed:${this.hookId}:${guid}`,
          `GitHub Webhook 投递连续重试 ${MAX_ATTEMPTS} 次仍未成功，请人工检查投递记录。`,
        );
        continue;
      }
      this.store.reserveWebhookRetry(this.hookId, guid, now);
      try {
        await this.client.redeliverWebhook(this.hookId, rows[0].id);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('one or more webhook redelivery requests failed');
    this.store.saveWebhookScan(this.hookId, now);
  }
}
