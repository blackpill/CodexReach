import Database from 'better-sqlite3';
export type PreviewRecord = {
  taskId: string;
  pr: number;
  sha: string;
  host: string;
  port: number;
  root?: string;
  worktree?: string;
  url?: string;
  state: 'building' | 'ready' | 'failed';
  attempts: number;
  lastAttempt: number;
  notifiedKey?: string;
  retiredWorktrees?: string[];
};
export class PreviewStore {
  private db: Database.Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode=WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS issue_auto_previews(task_id TEXT PRIMARY KEY,pr INTEGER NOT NULL,port INTEGER NOT NULL UNIQUE,data TEXT NOT NULL)',
    );
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE name='issue_auto_previews'")
      .get() as { sql: string };
    if (/pr INTEGER NOT NULL UNIQUE/i.test(schema.sql))
      this.db.transaction(() => {
        this.db.exec(
          'ALTER TABLE issue_auto_previews RENAME TO issue_auto_previews_legacy; CREATE TABLE issue_auto_previews(task_id TEXT PRIMARY KEY,pr INTEGER NOT NULL,port INTEGER NOT NULL UNIQUE,data TEXT NOT NULL); INSERT INTO issue_auto_previews SELECT * FROM issue_auto_previews_legacy; DROP TABLE issue_auto_previews_legacy;',
        );
      })();
  }
  get(taskId: string): PreviewRecord | undefined {
    const row = this.db
      .prepare('SELECT data FROM issue_auto_previews WHERE task_id=?')
      .get(taskId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  all(): PreviewRecord[] {
    return (
      this.db.prepare('SELECT data FROM issue_auto_previews ORDER BY port').all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
  }
  save(r: PreviewRecord): void {
    this.db
      .prepare(
        'INSERT INTO issue_auto_previews(task_id,pr,port,data) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET pr=excluded.pr,port=excluded.port,data=excluded.data',
      )
      .run(r.taskId, r.pr, r.port, JSON.stringify(r));
  }
  remove(taskId: string): void {
    this.db.prepare('DELETE FROM issue_auto_previews WHERE task_id=?').run(taskId);
  }
  close(): void {
    this.db.close();
  }
}
