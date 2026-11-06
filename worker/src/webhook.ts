/** Verify against the exact request bytes before parsing the payload. */
export async function verifyWebhook(
  body: Uint8Array,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (part) => parseInt(part, 16));
  return crypto.subtle.verify('HMAC', key, bytes, Uint8Array.from(body));
}

export type IssueTrigger = {
  repositoryId: number;
  issueNumber: number;
  actorId: number;
  action: 'opened' | 'labeled';
};
export function parseIssueEvent(
  eventType: string,
  payload: unknown,
  repositoryId: number,
  actorId: number,
): IssueTrigger | null {
  if (eventType !== 'issues' || !payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, any>;
  if (
    value.repository?.id !== repositoryId ||
    value.sender?.id !== actorId ||
    !Number.isSafeInteger(value.issue?.number) ||
    value.issue.number < 1 ||
    value.issue.state !== 'open'
  )
    return null;
  if (value.action === 'labeled' && value.label?.name === 'Auto')
    return { repositoryId, issueNumber: value.issue.number, actorId, action: 'labeled' };
  if (
    value.action === 'opened' &&
    Array.isArray(value.issue.labels) &&
    value.issue.labels.some((label: any) => label?.name === 'Auto')
  )
    return { repositoryId, issueNumber: value.issue.number, actorId, action: 'opened' };
  return null;
}
