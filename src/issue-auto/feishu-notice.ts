import type { TopicReceipt } from './dual-notice.js';
export function preciseTopicLink(receipt: TopicReceipt): string {
  if (
    !/^oc_[A-Za-z0-9]+$/.test(receipt.chatId) ||
    !receipt.threadId ||
    !/^omt_[A-Za-z0-9]+$/.test(receipt.threadId) ||
    !receipt.position ||
    (!/^\d+$/.test(receipt.position) && receipt.position !== '-1')
  )
    throw Error('message position unavailable');
  const q = new URLSearchParams({
    open_chat_id: receipt.chatId,
    open_thread_id: receipt.threadId,
    openchatid: receipt.chatId,
    openthreadid: receipt.threadId,
    thread_position: receipt.position,
  });
  return `https://applink.feishu.cn/client/thread/open?${q}`;
}
function allowedLink(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (
      u.protocol === 'https:' &&
      u.hostname === 'github.com' &&
      ['/blackpill/usmapgames.com/', '/blackpill/classgames.net/', '/blackpill/colorearmundo.com/', '/blackpill/BluetoothClicker/', '/blackpill/endoscope-iOS/'].some((prefix) =>
        u.pathname.startsWith(prefix),
      )
    )
      return true;
    if (u.protocol !== 'http:') return false;
    return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  } catch {
    return false;
  }
}
export function directNoticeContent(message: string, link: string): unknown {
  const url = new URL(link);
  if (url.protocol !== 'https:' || url.hostname !== 'applink.feishu.cn')
    throw Error('invalid topic link');
  const rows: Array<Array<Record<string, string>>> = [];
  for (const line of message.slice(0, 6000).split('\n')) {
    const row: Array<Record<string, string>> = [];
    let offset = 0;
    for (const m of line.matchAll(/https?:\/\/[^\s<>]+/g)) {
      if (!allowedLink(m[0])) continue;
      row.push({ tag: 'text', text: line.slice(offset, m.index) });
      row.push({ tag: 'a', text: m[0], href: m[0] });
      offset = m.index! + m[0].length;
    }
    row.push({ tag: 'text', text: line.slice(offset) || ' ' });
    rows.push(row);
  }
  rows.push([{ tag: 'a', text: '查看话题最新消息（本次通知）', href: link }]);
  return { zh_cn: { title: '🔔 CodexReach 关键提醒', content: rows } };
}
