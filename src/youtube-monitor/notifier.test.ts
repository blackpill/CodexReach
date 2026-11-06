import { describe, expect, it } from 'vitest';
import { FeishuCommentNotifier, commentPost, quotaPost } from './notifier.js';
import { deliveryId, type Delivery } from './store.js';
import type { Fetcher } from './client.js';
import type { QuotaAlert } from './quota.js';
const delivery: Delivery = { id: deliveryId('7sVn00ECFBw', 'oc_chat', 'c'), videoId: '7sVn00ECFBw', chatId: 'oc_chat', createdAt: 1, comment: { videoId: '7sVn00ECFBw', id: 'c', author: 'Alice', text: '<at user_id="all">所有人</at> **execute**', publishedAt: 1 } };
describe('Feishu comment notifications', () => {
  it('renders comments as literal text, with a trusted comment permalink and bounded size', () => {
    const post = commentPost(delivery).zh_cn;
    expect(post.content.flat().some(t => t.tag === 'text' && t.text === delivery.comment.text)).toBe(true);
    expect(post.content.flat().filter(t => t.tag === 'a')).toEqual([{ tag: 'a', text: '查看原评论', href: 'https://www.youtube.com/watch?v=7sVn00ECFBw&lc=c' }]);
    const huge = commentPost({ ...delivery, comment: { ...delivery.comment, text: '🙂'.repeat(50_000) } });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(20_000);
  });
  it('caches token and uses the durable id as uuid on retries', async () => {
    const requests: Array<{ url: string; body: any; headers: Headers }> = [];
    const fetcher: Fetcher = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init!.body as string), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(String(url).includes('/auth/') ? { code: 0, tenant_access_token: 'token-secret', expire: 7200 } : { code: 0, data: { message_id: 'om_sent' } }));
    };
    const notifier = new FeishuCommentNotifier('app', 'app-secret', fetcher);
    await notifier.send(delivery); await notifier.send(delivery);
    expect(requests.filter(r => r.url.includes('/auth/'))).toHaveLength(1);
    const messages = requests.filter(r => r.url.includes('/im/'));
    expect(messages.map(r => r.body.uuid)).toEqual([delivery.id, delivery.id]);
    expect(messages[0].body).toMatchObject({ receive_id: 'oc_chat', msg_type: 'post' });
    expect(messages[0].headers.get('Authorization')).toBe('Bearer token-secret');
    expect(messages[0].url).not.toContain('token-secret');
    expect(delivery.id.length).toBeLessThanOrEqual(50);
  });
  it('does not acknowledge business errors or responses missing message ids', async () => {
    for (const result of [{ code: 230002, msg: 'SECRET' }, { code: 0, data: {} }]) {
      const fetcher: Fetcher = async url => new Response(JSON.stringify(String(url).includes('/auth/') ? { code: 0, tenant_access_token: 'token', expire: 7200 } : result));
      await expect(new FeishuCommentNotifier('app', 'SECRET', fetcher).send(delivery)).rejects.toThrow('feishu_');
      await expect(new FeishuCommentNotifier('app', 'SECRET', fetcher).send(delivery)).rejects.not.toThrow('SECRET');
    }
  });
  it('redacts transport failures', async () => { await expect(new FeishuCommentNotifier('app', 'SECRET', async () => { throw Error('SECRET'); }).send(delivery)).rejects.toThrow('feishu_network_error'); });
});

describe('Feishu quota alerts', () => {
  const alert: QuotaAlert = { id:'fixed-quota-uuid',projectId:'tlplayer-android',chatId:'oc_chat',day:'2026-11-06',threshold:70,units:7000,dailyLimit:10000,trackedSince:Date.parse('2026-11-07T07:00:00+08:00'),createdAt:Date.parse('2026-11-07T09:00:00+08:00'),status:'pending',attempts:0,nextAttemptAt:0,lastError:null };
  it('clearly labels the estimate, threshold, Pacific date and Beijing reset time', () => {
    const text=JSON.stringify(quotaPost(alert));
    for(const expected of ['70%','7000','10000','2026-11-06','America/Los_Angeles','2026-11-07 16:00:00','本监控','估算','其他程序','启用前'])expect(text).toContain(expected);
  });
  it('sends quota posts to the dedicated group using their persistent uuid', async () => {
    const bodies:any[]=[];
    const notifier=new FeishuCommentNotifier('app','SECRET',async(url,init)=>{
      if(String(url).includes('/auth/'))return new Response('{"code":0,"tenant_access_token":"token","expire":7200}');
      bodies.push(JSON.parse(init!.body as string));return new Response('{"code":0,"data":{"message_id":"om_alert"}}');
    });
    await notifier.sendQuota(alert);
    expect(bodies).toHaveLength(1);expect(bodies[0]).toMatchObject({receive_id:'oc_chat',uuid:alert.id,msg_type:'post'});
    expect(JSON.parse(bodies[0].content)).toEqual(quotaPost(alert));
  });
});
