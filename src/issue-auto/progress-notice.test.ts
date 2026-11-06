import { it, expect, vi } from 'vitest';
import { sendIssueNotice } from './progress-notice.js';
it('does not mark a stale ready notice as current after PR state changes during delivery', async () => {
  const store = {
    getProgress: vi
      .fn()
      .mockReturnValueOnce({
        stage: 'PR_READY',
        version: 4,
        context: { threadId: 's', ciHeadSha: 'a' },
      })
      .mockReturnValueOnce({
        stage: 'CI_CHECKING',
        version: 5,
        context: { threadId: 's', ciHeadSha: 'b' },
      }),
  };
  const feishu = {
    sendIssueAutoNotice: vi.fn().mockResolvedValue(undefined),
    updateIssueStage: vi.fn().mockResolvedValue(undefined),
  };
  await sendIssueNotice(store, feishu, '/p', 't', 'message', () => {});
  expect(feishu.sendIssueAutoNotice).toHaveBeenCalled();
  expect(feishu.updateIssueStage).not.toHaveBeenCalled();
});
it('marks PR notified only when ready version remains unchanged', async () => {
  const state = { stage: 'PR_READY', version: 4, context: { threadId: 's', ciHeadSha: 'a' } };
  const store = { getProgress: vi.fn().mockReturnValue(state) };
  const feishu = {
    sendIssueAutoNotice: vi.fn().mockResolvedValue(undefined),
    updateIssueStage: vi.fn().mockResolvedValue(undefined),
  };
  await sendIssueNotice(store, feishu, '/p', 't', 'message', () => {});
  expect(feishu.updateIssueStage).toHaveBeenCalledWith('s', 'PR_NOTIFIED');
});
