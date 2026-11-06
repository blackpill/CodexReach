import { MonitorError, type Fetcher } from './client.js';
import type { Delivery } from './store.js';
import { nextQuotaReset, type QuotaAlert } from './quota.js';

type PostElement = { tag: 'text'; text: string } | { tag: 'a'; text: string; href: string };
const clip = (text: string, length: number) => {
  const chars = Array.from(text);
  return chars.length > length ? `${chars.slice(0, length).join('')}\n…（内容较长，请查看原评论）` : text;
};
export function commentPost(delivery: Delivery): { zh_cn: { title: string; content: PostElement[][] } } {
  const url = new URL('https://www.youtube.com/watch');
  url.search = new URLSearchParams({ v: delivery.videoId, lc: delivery.comment.id }).toString();
  return { zh_cn: { title: `YouTube 新评论 · ${delivery.videoId}`, content: [
    [{ tag: 'text', text: `作者：${clip(delivery.comment.author, 100)}` }],
    [{ tag: 'text', text: `发布时间：${new Date(delivery.comment.publishedAt).toISOString()}` }],
    [{ tag: 'text', text: clip(delivery.comment.text, 3000) }],
    [{ tag: 'a', text: '查看原评论', href: url.toString() }],
  ] } };
}

export function quotaPost(alert: QuotaAlert): { zh_cn: { title: string; content: PostElement[][] } } {
  const beijing = (at: number) => new Date(at).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const lines = [
    `项目：${alert.projectId}`,
    `本监控触发时估算用量：${alert.units} / ${alert.dailyLimit} 单位（${(alert.units / alert.dailyLimit * 100).toFixed(1)}%）`,
    `配额日：${alert.day}（America/Los_Angeles）`,
    `下次配额重置：${beijing(nextQuotaReset(alert.createdAt))}（北京时间）`,
    `触发时间：${beijing(alert.createdAt)}（北京时间）`,
    `统计启用时间：${beijing(alert.trackedSince)}（北京时间）；启用前调用未回填。`,
    '仅统计本监控的 YouTube 请求尝试，含分页及失败请求；网络失败可能保守多计。不包含其他程序的调用，也不是 Google Cloud 的实际项目总用量。',
    '请核对 Google Cloud 实际配额；本提醒不会自动停止监控。',
  ];
  return { zh_cn: { title: `YouTube API 额度提醒 · ${alert.threshold}%`, content: lines.map(text => [{ tag: 'text', text }]) } };
}

// Separate HTTP boundary avoids SDK transport logs accidentally exposing credentials/comment text.
export class FeishuCommentNotifier {
  private token?: { value: string; expiresAt: number };
  constructor(private readonly appId: string, private readonly appSecret: string, private readonly fetcher: Fetcher = fetch) {}

  private async request(url: string, body: unknown, token?: string): Promise<any> {
    let response: Response;
    let data: any;
    try {
      response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      data = await response.json();
    } catch { throw new MonitorError('feishu_network_error'); }
    if (!response.ok) throw new MonitorError(`feishu_http_${response.status}`);
    if (data?.code !== 0) throw new MonitorError(`feishu_api_${typeof data?.code === 'number' ? data.code : 'invalid_response'}`);
    return data;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const data = await this.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: this.appId, app_secret: this.appSecret });
    if (typeof data.tenant_access_token !== 'string' || !data.tenant_access_token || typeof data.expire !== 'number' || !Number.isFinite(data.expire) || data.expire <= 0) {
      throw new MonitorError('feishu_invalid_token_response');
    }
    this.token = { value: data.tenant_access_token, expiresAt: Date.now() + Math.max(0, data.expire - 60) * 1000 };
    return this.token.value;
  }
  async send(delivery: Delivery): Promise<void> {
    await this.sendPost(delivery.chatId, delivery.id, commentPost(delivery));
  }
  async sendQuota(alert: QuotaAlert): Promise<void> {
    await this.sendPost(alert.chatId, alert.id, quotaPost(alert));
  }
  private async sendPost(chatId: string, uuid: string, content: unknown): Promise<void> {
    try {
      const token = await this.accessToken();
      const data = await this.request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        receive_id: chatId, msg_type: 'post', content: JSON.stringify(content), uuid,
      }, token);
      if (typeof data.data?.message_id !== 'string' || !data.data.message_id) throw new MonitorError('feishu_invalid_message_response');
    } catch (error) {
      this.token = undefined;
      throw error;
    }
  }
}
