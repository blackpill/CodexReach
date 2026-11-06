import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MonitorError, type Comment } from './client.js';

export const DAY_MS = 86_400_000;
const RETENTION_MS = 29 * DAY_MS;
export type Watch = { videoId: string; chatId: string; baselineAt: number | null; lastScanAt: number | null; nextCheckAt: number; lastError: string | null };
export type ChannelState = { channelId: string; lastScanAt: number | null; nextCheckAt: number; lastError: string | null };
export type Delivery = { id: string; videoId: string; chatId: string; comment: Comment; createdAt: number };
export function deliveryId(videoId: string, chatId: string, commentId: string): string {
  return createHash('sha256').update(JSON.stringify([videoId, chatId, commentId])).digest('hex').slice(0, 48);
}

export class YouTubeStore {
  private readonly db: Database.Database;
  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_watches (
        video_id TEXT NOT NULL, chat_id TEXT NOT NULL, baseline_at INTEGER, last_scan_at INTEGER,
        next_check_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY(video_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS youtube_seen (
        id TEXT PRIMARY KEY, video_id TEXT NOT NULL, chat_id TEXT NOT NULL, published_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS youtube_seen_retention ON youtube_seen(created_at);
      CREATE TABLE IF NOT EXISTS youtube_outbox (
        id TEXT PRIMARY KEY, video_id TEXT NOT NULL, chat_id TEXT NOT NULL, payload TEXT NOT NULL,
        published_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS youtube_outbox_target ON youtube_outbox(video_id, chat_id, published_at);
      CREATE TABLE IF NOT EXISTS youtube_monitor_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS youtube_channels (
        channel_id TEXT PRIMARY KEY, last_scan_at INTEGER, next_check_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS youtube_channel_videos (
        channel_id TEXT NOT NULL, video_id TEXT NOT NULL, PRIMARY KEY(channel_id,video_id)
      );
    `);
    const columns = this.db.pragma('table_info(youtube_outbox)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'retry_count')) this.db.exec('ALTER TABLE youtube_outbox ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(column => column.name === 'next_attempt_at')) this.db.exec('ALTER TABLE youtube_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
  }
  close() { if (this.db.open) this.db.close(); }

  ensureChannel(channelId: string): ChannelState {
    this.db.prepare('INSERT OR IGNORE INTO youtube_channels(channel_id) VALUES (?)').run(channelId);
    return this.getChannel(channelId)!;
  }
  getChannel(channelId: string): ChannelState | undefined {
    return this.db.prepare(`SELECT channel_id AS channelId, last_scan_at AS lastScanAt, next_check_at AS nextCheckAt,
      last_error AS lastError FROM youtube_channels WHERE channel_id=?`).get(channelId) as ChannelState | undefined;
  }
  channelVideoIds(channelId: string): string[] {
    return (this.db.prepare('SELECT video_id AS id FROM youtube_channel_videos WHERE channel_id=? ORDER BY video_id').all(channelId) as Array<{ id: string }>).map(row => row.id);
  }
  completeChannelScan(channelId: string, videoIds: string[], at: number, nextAt: number) {
    this.db.transaction(() => {
      this.ensureChannel(channelId);
      this.db.prepare('DELETE FROM youtube_channel_videos WHERE channel_id=?').run(channelId);
      const insert = this.db.prepare('INSERT OR IGNORE INTO youtube_channel_videos(channel_id,video_id) VALUES (?,?)');
      for (const videoId of videoIds) insert.run(channelId, videoId);
      this.db.prepare('UPDATE youtube_channels SET last_scan_at=?,next_check_at=?,last_error=NULL WHERE channel_id=?').run(at, nextAt, channelId);
    })();
  }
  scheduleChannel(channelId: string, nextAt: number, error: string | null) {
    this.db.prepare('UPDATE youtube_channels SET next_check_at=?,last_error=? WHERE channel_id=?').run(nextAt, error, channelId);
  }

  ensureWatch(videoId: string, chatId: string) {
    this.db.prepare('INSERT OR IGNORE INTO youtube_watches(video_id,chat_id) VALUES (?,?)').run(videoId, chatId);
    return this.getWatch(videoId, chatId)!;
  }
  getWatch(videoId: string, chatId: string): Watch | undefined {
    return this.db.prepare(`SELECT video_id AS videoId, chat_id AS chatId, baseline_at AS baselineAt,
      last_scan_at AS lastScanAt, next_check_at AS nextCheckAt, last_error AS lastError FROM youtube_watches WHERE video_id=? AND chat_id=?`).get(videoId, chatId) as Watch | undefined;
  }
  baseline(watch: Watch, comments: Comment[], at: number) {
    this.db.transaction(() => {
      this.remember(watch, comments, at, false);
      this.db.prepare('UPDATE youtube_watches SET baseline_at=?,last_scan_at=? WHERE video_id=? AND chat_id=? AND baseline_at IS NULL')
        .run(at, at, watch.videoId, watch.chatId);
    })();
  }
  scanned(watch: Watch, comments: Comment[], at: number) {
    this.db.transaction(() => {
      this.remember(watch, comments, at, true);
      this.db.prepare('UPDATE youtube_watches SET last_scan_at=MAX(last_scan_at,?) WHERE video_id=? AND chat_id=?').run(at, watch.videoId, watch.chatId);
    })();
  }
  private remember(watch: Watch, comments: Comment[], at: number, enqueue: boolean) {
    const seen = this.db.prepare('INSERT OR IGNORE INTO youtube_seen(id,video_id,chat_id,published_at,created_at) VALUES (?,?,?,?,?)');
    const outbox = this.db.prepare('INSERT OR IGNORE INTO youtube_outbox(id,video_id,chat_id,payload,published_at,created_at) VALUES (?,?,?,?,?,?)');
    for (const comment of comments) {
      const id = deliveryId(watch.videoId, watch.chatId, comment.id);
      if (seen.run(id, watch.videoId, watch.chatId, comment.publishedAt, at).changes && enqueue) {
        outbox.run(id, watch.videoId, watch.chatId, JSON.stringify(comment), comment.publishedAt, at);
      }
    }
  }
  schedule(watch: Watch, nextAt: number, error: string | null) {
    this.db.prepare('UPDATE youtube_watches SET next_check_at=?,last_error=? WHERE video_id=? AND chat_id=?').run(nextAt, error, watch.videoId, watch.chatId);
  }
  setError(watch: Watch, error: string) {
    this.db.prepare('UPDATE youtube_watches SET last_error=? WHERE video_id=? AND chat_id=?').run(error, watch.videoId, watch.chatId);
  }
  pending(videoId: string, chatId: string, limit = 100, dueAt = Number.MAX_SAFE_INTEGER): Delivery[] {
    const rows = this.db.prepare(`SELECT id, video_id AS videoId, chat_id AS chatId, payload, created_at AS createdAt
      FROM youtube_outbox WHERE video_id=? AND chat_id=? AND next_attempt_at<=? ORDER BY retry_count,published_at,id LIMIT ?`).all(videoId, chatId, dueAt, limit) as Array<Omit<Delivery, 'comment'> & { payload: string }>;
    return rows.map(({ payload, ...row }) => ({ ...row, comment: JSON.parse(payload) as Comment }));
  }
  delivered(id: string) { this.db.prepare('DELETE FROM youtube_outbox WHERE id=?').run(id); }
  cancelPendingOutside(chatId: string, activeVideoIds: string[]): number {
    const active = new Set(activeVideoIds);
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT DISTINCT video_id AS id FROM youtube_outbox WHERE chat_id=?').all(chatId) as Array<{ id: string }>;
      const remove = this.db.prepare('DELETE FROM youtube_outbox WHERE chat_id=? AND video_id=?');
      let count = 0;
      for (const row of rows) if (!active.has(row.id)) count += remove.run(chatId, row.id).changes;
      return count;
    })();
  }
  failed(id: string, now: number) {
    const row = this.db.prepare('SELECT retry_count AS count FROM youtube_outbox WHERE id=?').get(id) as { count: number } | undefined;
    if (!row) return;
    const delay = Math.min(DAY_MS, 1_800_000 * 2 ** Math.min(row.count, 6));
    this.db.prepare('UPDATE youtube_outbox SET retry_count=retry_count+1,next_attempt_at=? WHERE id=?').run(now + delay, id);
  }
  cleanup(now: number): number {
    return this.db.transaction(() => {
      const expired = this.db.prepare('DELETE FROM youtube_outbox WHERE created_at<?').run(now - RETENTION_MS).changes;
      this.db.prepare(`DELETE FROM youtube_seen WHERE created_at<? AND published_at < COALESCE(
        (SELECT last_scan_at-? FROM youtube_watches WHERE youtube_watches.video_id=youtube_seen.video_id AND youtube_watches.chat_id=youtube_seen.chat_id),0)
        AND NOT EXISTS (SELECT 1 FROM youtube_outbox WHERE youtube_outbox.id=youtube_seen.id)`).run(now - RETENTION_MS, DAY_MS);
      return expired;
    })();
  }
  acquireLease(owner: string, now: number): boolean {
    return this.db.prepare(`INSERT INTO youtube_monitor_lease(id,owner,expires_at) VALUES (1,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE youtube_monitor_lease.expires_at<=?`)
      .run(owner, now + 90_000, now).changes === 1;
  }
  renewLease(owner: string, now: number) {
    if (!this.db.prepare('UPDATE youtube_monitor_lease SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?').run(now + 90_000, owner, now).changes) {
      throw new MonitorError('youtube_lease_lost');
    }
  }
  releaseLease(owner: string) { this.db.prepare('DELETE FROM youtube_monitor_lease WHERE id=1 AND owner=?').run(owner); }
}
