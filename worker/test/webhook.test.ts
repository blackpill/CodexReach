import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhook, parseIssueEvent } from '../src/webhook.js';

const secret = 'test-secret';
const event = {
  action: 'labeled',
  label: { name: 'Auto' },
  repository: { id: 1444221313 },
  issue: { number: 12, state: 'open', labels: [{ name: 'Auto' }] },
  sender: { id: 1231245 },
};

describe('GitHub webhook intake', () => {
  it('accepts a matching HMAC and rejects altered body and malformed signatures', async () => {
    const body = new TextEncoder().encode(JSON.stringify(event));
    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(await verifyWebhook(body, signature, secret)).toBe(true);
    expect(await verifyWebhook(new TextEncoder().encode('{}'), signature, secret)).toBe(false);
    expect(await verifyWebhook(body, 'sha256=00', secret)).toBe(false);
  });
  it('allows only trusted Auto issue triggers', () => {
    expect(parseIssueEvent('issues', event, 1444221313, 1231245)?.issueNumber).toBe(12);
    expect(
      parseIssueEvent('issues', { ...event, sender: { id: 4 } }, 1444221313, 1231245),
    ).toBeNull();
    expect(
      parseIssueEvent('issues', { ...event, label: { name: 'other' } }, 1444221313, 1231245),
    ).toBeNull();
    expect(
      parseIssueEvent('issues', { ...event, repository: { id: 5 } }, 1444221313, 1231245),
    ).toBeNull();
    expect(
      parseIssueEvent('issues', { ...event, action: 'opened' }, 1444221313, 1231245)?.issueNumber,
    ).toBe(12);
    expect(
      parseIssueEvent(
        'issues',
        { ...event, action: 'opened', issue: { ...event.issue, labels: [] } },
        1444221313,
        1231245,
      ),
    ).toBeNull();
  });
});
