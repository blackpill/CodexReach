import { parseIssueEvent, verifyWebhook } from './webhook.js';

type Statement = {
  bind(...args: unknown[]): Statement;
  first<T = any>(): Promise<T | null>;
  run(): Promise<unknown>;
};
type Env = {
  DB: { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> };
  WEBHOOK_SECRET: string;
  RUNNER_SECRET: string;
  REPOSITORY_ID?: string;
  REPOSITORY_IDS?: string;
  ACTOR_ID: string;
};
function repositoryIds(env: Env): number[] {
  const raw = (env.REPOSITORY_IDS ?? env.REPOSITORY_ID ?? '').split(',');
  const ids = raw.map((x) => Number(x.trim()));
  if (
    !ids.length ||
    ids.length > 10 ||
    ids.some((x) => !Number.isSafeInteger(x) || x < 1) ||
    new Set(ids).size !== ids.length
  )
    throw Error('invalid repository allowlist');
  return ids;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const MAX_BODY = 256 * 1024;
async function constantEqual(left: string, right: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(left)),
    crypto.subtle.digest('SHA-256', enc.encode(right)),
  ]);
  const aa = new Uint8Array(a),
    bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
async function readBytes(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export async function handle(request: Request, env: Env): Promise<Response> {
  let allowed: number[];
  try {
    allowed = repositoryIds(env);
  } catch {
    return json({ error: 'invalid repository configuration' }, 503);
  }
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const route = new URL(request.url).pathname;
  if (route === '/webhook') {
    const body = await readBytes(request);
    if (!body) return json({ error: 'too large' }, 413);
    if (
      !(await verifyWebhook(
        body,
        request.headers.get('x-hub-signature-256'),
        env.WEBHOOK_SECRET,
      ))
    )
      return json({ error: 'unauthorized' }, 401);
    const event = request.headers.get('x-github-event');
    if (event === 'ping') return json({ ok: true });
    const delivery = request.headers.get('x-github-delivery');
    if (!delivery || delivery.length > 128 || !/^[a-zA-Z0-9-]+$/.test(delivery))
      return json({ error: 'invalid delivery' }, 400);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    const trigger = parseIssueEvent(event ?? '', payload, allowed, Number(env.ACTOR_ID));
    if (!trigger) return json({ ignored: true });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO tasks(id, repository_id, issue_number, actor_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        crypto.randomUUID(),
        trigger.repositoryId,
        trigger.issueNumber,
        trigger.actorId,
        trigger.action,
        now,
      ),
      env.DB.prepare(
        'INSERT OR IGNORE INTO deliveries(delivery_id, repository_id, issue_number, received_at) VALUES (?, ?, ?, ?)',
      ).bind(delivery, trigger.repositoryId, trigger.issueNumber, now),
    ]);
    return json({ accepted: true }, 202);
  }
  if (route !== '/claim' && route !== '/ack') return json({ error: 'not found' }, 404);
  const auth = request.headers.get('authorization') ?? '';
  if (!env.RUNNER_SECRET || !(await constantEqual(auth, `Bearer ${env.RUNNER_SECRET}`)))
    return json({ error: 'unauthorized' }, 401);
  const body = await readBytes(request);
  if (!body) return json({ error: 'too large' }, 413);
  let data: any;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const now = Date.now();
  if (route === '/claim') {
    if (typeof data?.runnerId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.runnerId))
      return json({ error: 'invalid runner' }, 400);
    // Legacy callers are restricted to the original single repository, not the full new list.
    const requested = data.repositoryIds ?? [Number(env.REPOSITORY_ID)];
    if (
      !Array.isArray(requested) ||
      !requested.length ||
      requested.length > 10 ||
      requested.some(
        (id: unknown) => !Number.isSafeInteger(id) || !allowed.includes(id as number),
      ) ||
      new Set(requested).size !== requested.length
    )
      return json({ error: 'invalid repositories' }, 400);
    const token = crypto.randomUUID();
    const row = await env.DB.prepare(
      `UPDATE tasks SET status='leased', lease_token=?, lease_version=lease_version+1, lease_until=?, runner_id=? WHERE id=(SELECT id FROM tasks WHERE repository_id IN (${requested.map(() => '?').join(',')}) AND (status='pending' OR (status='leased' AND lease_until < ?)) ORDER BY created_at, id LIMIT 1) RETURNING id,repository_id,issue_number,actor_id,action,lease_version`,
    )
      .bind(token, now + 120_000, data.runnerId, ...requested, now)
      .first<any>();
    if (!row) return new Response(null, { status: 204 });
    return json({
      task: {
        taskId: row.id,
        repositoryId: row.repository_id,
        issueNumber: row.issue_number,
        actorId: row.actor_id,
        action: row.action,
      },
      leaseToken: token,
      leaseVersion: row.lease_version,
    });
  }
  if (
    typeof data?.taskId !== 'string' ||
    typeof data?.leaseToken !== 'string' ||
    !Number.isSafeInteger(data?.leaseVersion)
  )
    return json({ error: 'invalid ack' }, 400);
  const row = await env.DB.prepare(
    `UPDATE tasks SET status='delivered' WHERE id=? AND lease_token=? AND lease_version=? AND (? IS NULL OR runner_id=?) AND ((status='leased' AND lease_until>=?) OR status='delivered') RETURNING id`,
  )
    .bind(
      data.taskId,
      data.leaseToken,
      data.leaseVersion,
      data.runnerId ?? null,
      data.runnerId ?? null,
      now,
    )
    .first();
  return row ? json({ delivered: true }) : json({ error: 'stale lease' }, 409);
}
export default { fetch: handle };
