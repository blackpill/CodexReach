import Database from 'better-sqlite3';
export class NotificationReceipts {
  private db: Database.Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode=WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS issue_auto_notification_receipts(delivery_key TEXT NOT NULL,channel TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(delivery_key,channel))',
    );
  }
  get<T>(key: string, channel: string): T | undefined {
    const row = this.db
      .prepare(
        'SELECT receipt FROM issue_auto_notification_receipts WHERE delivery_key=? AND channel=?',
      )
      .get(key, channel) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) : undefined;
  }
  save(key: string, channel: string, receipt: unknown): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO issue_auto_notification_receipts(delivery_key,channel,receipt) VALUES(?,?,?)',
      )
      .run(key, channel, JSON.stringify(receipt));
  }
  close(): void {
    this.db.close();
  }
}
