import { it, expect } from 'vitest';

it('recognizes only the two pinned mobile GitHub project links', async () => {
 const { directNoticeContent } = await import('./feishu-notice.js');
 for (const repo of ['BluetoothClicker','endoscope-iOS']) {
  const url = `https://github.com/blackpill/${repo}/pull/12`;
  const body = JSON.stringify(directNoticeContent(url, 'https://applink.feishu.cn/client/thread/open'));
  expect(body).toContain(`"href":"${url}"`);
 }
 const unsafe = JSON.stringify(directNoticeContent('https://github.com/blackpill/BluetoothClicker.evil/pull/1','https://applink.feishu.cn/client/thread/open'));
 expect(unsafe).not.toContain('"href":"https://github.com/blackpill/BluetoothClicker.evil/pull/1"');
});
