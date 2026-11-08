import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type PersistedState = Record<string, any[]>;

export type TurnCorrelation = {
  eventId: string;
  sessionId: string;
  turnId: string;
  eventType: string;
  origin: 'codexreach' | 'codex-desktop' | 'codex-hook' | 'unknown';
  notificationId?: string;
  status?: string;
};

export function codexEventId(sessionId: string, turnId: string, eventType: string) {
  return `codex:${eventType}:${sessionId}:${turnId}`;
}

export class StateStore {
  private readonly db: Database.Database;
  private baseline = new Map<string, string>();

  constructor(
    readonly databasePath = path.resolve('.data/feishu-state.sqlite'),
    private readonly legacyJsonPath = path.resolve(process.env.CODEXREACH_LEGACY_STATE_JSON ?? '.data/feishu-state.json'),
  ) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.importLegacyJsonOnce();
    this.captureBaseline();
  }

  close() { this.db.close(); }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_entries (
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, entry_key)
      );

      CREATE TABLE IF NOT EXISTS turn_correlations (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        origin TEXT NOT NULL,
        notification_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS turn_correlations_session_turn_idx
        ON turn_correlations(session_id, turn_id);

      CREATE TABLE IF NOT EXISTS quarantined_project_chats (chat_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
  }

  isProjectChatQuarantined(chatId: string): boolean {
    if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error('invalid project chat identity');
    return !!this.db.prepare('SELECT 1 FROM quarantined_project_chats WHERE chat_id=?').get(chatId);
  }

  quarantineProjectChat(chatId: string, reason: string): void {
    if (!/^oc_[A-Za-z0-9]+$/.test(chatId) || !reason.trim()) throw new Error('invalid quarantine');
    this.db.prepare('INSERT OR IGNORE INTO quarantined_project_chats(chat_id,reason,created_at) VALUES (?,?,?)').run(chatId,reason,new Date().toISOString());
  }

  private importLegacyJsonOnce() {
    const migration = 'legacy-feishu-state-json-v1';
    if (this.db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(migration)) return;
    let snapshot: PersistedState = {};
    try { snapshot = JSON.parse(fs.readFileSync(this.legacyJsonPath, 'utf8')); } catch { /* no legacy state */ }
    this.replaceSnapshot(snapshot);
    this.db.prepare('INSERT INTO migrations(name, applied_at) VALUES (?, ?)').run(migration, new Date().toISOString());
  }

  private captureBaseline() {
    this.baseline = new Map((this.db.prepare('SELECT namespace, entry_key, value_json FROM state_entries').all() as Array<{ namespace: string; entry_key: string; value_json: string }>)
      .map((row) => [`${row.namespace}\0${row.entry_key}`, row.value_json]));
  }

  private replaceSnapshot(snapshot: PersistedState) {
    const write = this.db.transaction(() => {
      const now = new Date().toISOString();
      const insert = this.db.prepare('INSERT OR REPLACE INTO state_entries(namespace, entry_key, value_json, updated_at) VALUES (?, ?, ?, ?)');
      for (const [namespace, rawEntries] of Object.entries(snapshot)) {
        const entries = Array.isArray(rawEntries) ? rawEntries : [];
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          const [key, value] = Array.isArray(entry) && entry.length === 2 ? [String(entry[0]), entry[1]] : [String(index), entry];
          insert.run(namespace, key, JSON.stringify(value), now);
        }
      }
    });
    write();
  }

  loadSnapshot(): PersistedState {
    const rows = this.db.prepare('SELECT namespace, entry_key, value_json FROM state_entries ORDER BY namespace, entry_key').all() as Array<{ namespace: string; entry_key: string; value_json: string }>;
    const result: PersistedState = {};
    for (const row of rows) {
      const entries = (result[row.namespace] ??= []) as Array<[string, unknown]>;
      entries.push([row.entry_key, JSON.parse(row.value_json)]);
    }
    return result;
  }

  saveSnapshot(snapshot: PersistedState) {
    const write = this.db.transaction(() => {
      const now = new Date().toISOString();
      const insert = this.db.prepare('INSERT OR IGNORE INTO state_entries(namespace, entry_key, value_json, updated_at) VALUES (?, ?, ?, ?)');
      const update = this.db.prepare('UPDATE state_entries SET value_json = ?, updated_at = ? WHERE namespace = ? AND entry_key = ? AND value_json = ?');
      const remove = this.db.prepare('DELETE FROM state_entries WHERE namespace = ? AND entry_key = ? AND value_json = ?');
      for (const [namespace, rawEntries] of Object.entries(snapshot)) {
        const entries = Array.isArray(rawEntries) ? rawEntries : [];
        const desired = new Map<string, string>();
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          const [key, value] = Array.isArray(entry) && entry.length === 2
            ? [String(entry[0]), entry[1]]
            : [String(index), entry];
          desired.set(key, JSON.stringify(value));
        }
        for (const [key, valueJson] of desired) {
          const baselineKey = `${namespace}\0${key}`;
          const previous = this.baseline.get(baselineKey);
          if (previous === valueJson) continue;
          const result = previous === undefined
            ? insert.run(namespace, key, valueJson, now)
            : update.run(valueJson, now, namespace, key, previous);
          if (result.changes) this.baseline.set(baselineKey, valueJson);
        }
        for (const [baselineKey, previous] of [...this.baseline]) {
          const [previousNamespace, key] = baselineKey.split('\0');
          if (previousNamespace !== namespace || desired.has(key)) continue;
          if (remove.run(namespace, key, previous).changes) this.baseline.delete(baselineKey);
        }
      }
    });
    write();
  }

  recordTurn(input: TurnCorrelation) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO turn_correlations(
        event_id, session_id, turn_id, event_type, origin,
        notification_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        origin = excluded.origin,
        notification_id = COALESCE(excluded.notification_id, turn_correlations.notification_id),
        status = COALESCE(excluded.status, turn_correlations.status),
        updated_at = excluded.updated_at
    `).run(
      input.eventId, input.sessionId, input.turnId, input.eventType, input.origin,
      input.notificationId ?? null, input.status ?? null, now, now,
    );
  }

  isCodexReachTurn(sessionId: string, turnId: string) {
    const row = this.db.prepare(`
      SELECT 1 FROM turn_correlations
      WHERE session_id = ? AND turn_id = ? AND origin = 'codexreach'
      LIMIT 1
    `).get(sessionId, turnId);
    return Boolean(row);
  }
}
