import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MonitorError, safeError, type Fetcher } from './client.js';

const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export function quotaDay(at: number): string {
  const parts = pacific.formatToParts(at);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function nextQuotaReset(at: number): number {
  const day = quotaDay(at);
  // Los Angeles midnight falls on a UTC hour; walking hours also handles 23/25h DST days.
  let next = Math.ceil(at / 3_600_000) * 3_600_000;
  while (quotaDay(next) === day) next += 3_600_000;
  return next;
}
export type QuotaAlert = {
  id: string; projectId: string; day: string; threshold: 70 | 90; chatId: string;
  units: number; dailyLimit: number; trackedSince: number; createdAt: number;
  status: 'pending' | 'sent' | 'expired'; attempts: number; nextAttemptAt: number; lastError: string | null;
};
export type QuotaUsage = {
  projectId: string; day: string; units: number; requests: number; trackedSince: number;
  byMethod: Record<string, { units: number; requests: number }>;
};
const alertColumns = `id,project_id AS projectId,quota_day AS day,threshold,chat_id AS chatId,
  used_units AS units,daily_limit AS dailyLimit,tracked_since AS trackedSince,created_at AS createdAt,
  status,attempts,next_attempt_at AS nextAttemptAt,last_error AS lastError`;

export class QuotaStore {
  private readonly db: Database.Database;
  constructor(databasePath: string, readonly = false) {
    if (!readonly) fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { readonly, fileMustExist: readonly });
    if (readonly) return;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_quota_tracking (project_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS youtube_api_usage (
        project_id TEXT NOT NULL,quota_day TEXT NOT NULL,method TEXT NOT NULL,
        requests INTEGER NOT NULL,units INTEGER NOT NULL,PRIMARY KEY(project_id,quota_day,method)
      );
      CREATE TABLE IF NOT EXISTS youtube_quota_alerts (
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,quota_day TEXT NOT NULL,threshold INTEGER NOT NULL,
        chat_id TEXT NOT NULL,used_units INTEGER NOT NULL,daily_limit INTEGER NOT NULL,tracked_since INTEGER NOT NULL,
        created_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',sent_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,
        UNIQUE(project_id,quota_day,chat_id,threshold)
      );
      CREATE INDEX IF NOT EXISTS youtube_quota_alert_pending ON youtube_quota_alerts(project_id,quota_day,chat_id,status,next_attempt_at);
    `);
  }
  close() { if (this.db.open) this.db.close(); }
  initialize(projectId: string, at: number) {
    this.db.prepare('INSERT OR IGNORE INTO youtube_quota_tracking(project_id,started_at) VALUES (?,?)').run(projectId, at);
  }
  usage(projectId: string, day: string): QuotaUsage {
    const rows = this.db.prepare('SELECT method,requests,units FROM youtube_api_usage WHERE project_id=? AND quota_day=?').all(projectId, day) as Array<{ method: string; units: number; requests: number }>;
    const tracking = this.db.prepare('SELECT started_at AS at FROM youtube_quota_tracking WHERE project_id=?').get(projectId) as { at: number } | undefined;
    return { projectId, day, units: rows.reduce((n, r) => n + r.units, 0), requests: rows.reduce((n, r) => n + r.requests, 0),
      trackedSince: tracking?.at ?? 0, byMethod: Object.fromEntries(rows.map(({ method, ...counts }) => [method, counts])) };
  }
  record(projectId: string, day: string, method: string, at: number, dailyLimit: number, chatId: string) {
    this.db.transaction(() => {
      this.initialize(projectId, at);
      this.db.prepare(`INSERT INTO youtube_api_usage(project_id,quota_day,method,requests,units) VALUES (?,?,?,1,1)
        ON CONFLICT(project_id,quota_day,method) DO UPDATE SET requests=requests+1,units=units+1`).run(projectId, day, method);
      this.enqueue(projectId, day, chatId, dailyLimit, at);
    }).immediate();
  }
  private enqueue(projectId: string, day: string, chatId: string, dailyLimit: number, at: number) {
    const usage = this.usage(projectId, day);
    for (const threshold of [70, 90] as const) {
      if (usage.units * 100 < dailyLimit * threshold) continue;
      const id = createHash('sha256').update(JSON.stringify(['quota', projectId, day, chatId, threshold])).digest('hex').slice(0, 48);
      this.db.prepare(`INSERT OR IGNORE INTO youtube_quota_alerts(id,project_id,quota_day,threshold,chat_id,used_units,daily_limit,tracked_since,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, projectId, day, threshold, chatId, usage.units, dailyLimit, usage.trackedSince, at);
    }
  }
  prepare(projectId: string, day: string, chatId: string, dailyLimit: number, at: number): number {
    return this.db.transaction(() => {
      const expired = this.db.prepare("UPDATE youtube_quota_alerts SET status='expired' WHERE project_id=? AND quota_day<? AND status='pending'").run(projectId, day).changes;
      this.enqueue(projectId, day, chatId, dailyLimit, at);
      return expired;
    }).immediate();
  }
  alerts(projectId: string, day: string, chatId: string): QuotaAlert[] {
    return this.db.prepare(`SELECT ${alertColumns} FROM youtube_quota_alerts WHERE project_id=? AND quota_day=? AND chat_id=? ORDER BY threshold`).all(projectId, day, chatId) as QuotaAlert[];
  }
  sent(id: string, now: number) { this.db.prepare("UPDATE youtube_quota_alerts SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND status='pending'").run(now, id); }
  failed(id: string, now: number, reason: string) {
    const row = this.db.prepare('SELECT attempts FROM youtube_quota_alerts WHERE id=?').get(id) as { attempts: number } | undefined;
    if (!row) return;
    const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(row.attempts, 6));
    this.db.prepare("UPDATE youtube_quota_alerts SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE id=? AND status='pending'").run(now + delay, reason, id);
  }
}

type QuotaOptions = {
  projectId: string; chatId: string; dailyLimit: number; now?: () => number;
  send: (alert: QuotaAlert) => Promise<void>; onEvent?: (event: string, data: Record<string, unknown>) => void;
};
export class QuotaMonitor {
  private readonly now: () => number;
  constructor(private readonly store: QuotaStore, private readonly options: QuotaOptions) {
    if (!Number.isSafeInteger(options.dailyLimit) || options.dailyLimit < 1) throw new MonitorError('invalid_youtube_daily_quota');
    this.now = options.now ?? Date.now;
    this.store.initialize(options.projectId, this.now());
  }
  trackedFetch(fetcher: Fetcher = fetch): Fetcher {
    return async (input, init) => {
      const url = new URL(input);
      const resource = /^\/youtube\/v3\/(commentThreads|channels|playlistItems)$/.exec(url.pathname)?.[1];
      if (url.origin !== 'https://www.googleapis.com' || url.username || url.password || !resource || (init?.method ?? 'GET').toUpperCase() !== 'GET') {
        throw new MonitorError('youtube_unmetered_endpoint');
      }
      const now = this.now();
      // Count before dispatch, including errors/pages. A crash or pre-network failure
      // can conservatively overcount; this is deliberately not Google's actual usage.
      this.store.record(this.options.projectId, quotaDay(now), `${resource}.list`, now, this.options.dailyLimit, this.options.chatId);
      return fetcher(input, init);
    };
  }
  stats() {
    const now = this.now(), usage = this.store.usage(this.options.projectId, quotaDay(now));
    return { ...usage, dailyLimit: this.options.dailyLimit, percentage: usage.units / this.options.dailyLimit * 100,
      remainingEstimate: Math.max(0, this.options.dailyLimit - usage.units), resetAt: nextQuotaReset(now),
      partialDay: quotaDay(usage.trackedSince) === usage.day };
  }
  private emit(event: string, data: Record<string, unknown>) { try { this.options.onEvent?.(event, data); } catch { /* no raw exceptions */ } }
  async flush(checkpoint: (phase: 'before_send' | 'after_send') => void): Promise<void> {
    const day = quotaDay(this.now());
    const prepare = () => this.store.prepare(this.options.projectId, quotaDay(this.now()), this.options.chatId, this.options.dailyLimit, this.now());
    const expired = prepare();
    if (expired) this.emit('youtube_quota_alert_expired', { count: expired });
    for (const alert of this.store.alerts(this.options.projectId, day, this.options.chatId)) {
      if (alert.status !== 'pending' || alert.nextAttemptAt > this.now()) continue;
      if (quotaDay(this.now()) !== day) { prepare(); break; }
      checkpoint('before_send');
      try { await this.options.send(alert); }
      catch (error) {
        checkpoint('after_send');
        const reason = safeError(error);
        this.store.failed(alert.id, this.now(), reason);
        this.emit('youtube_quota_alert_failed', { threshold: alert.threshold, reason });
        continue;
      }
      checkpoint('after_send');
      this.store.sent(alert.id, this.now());
      this.emit('youtube_quota_alert_sent', { threshold: alert.threshold, day: alert.day, units: alert.units });
    }
  }
}
