import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Stage } from './supervisor.js';
export type IssueTask = {
  taskId: string;
  repositoryId: number;
  issueNumber: number;
  actorId: number;
  action: 'opened' | 'labeled';
};
export class IssueStore {
  private db: Database.Database;
  private progressObserver?: (
    taskId: string,
    stage: Stage,
    context: Record<string, unknown>,
  ) => void;
  constructor(filename: string) {
    if (filename !== ':memory:')
      fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS issue_auto_tasks (
      task_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL, issue_number INTEGER NOT NULL, actor_id INTEGER NOT NULL,
      action TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'RECEIVED', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(repository_id, issue_number)
    );
    CREATE TABLE IF NOT EXISTS issue_auto_progress (task_id TEXT PRIMARY KEY, stage TEXT NOT NULL, version INTEGER NOT NULL, context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_auto_notices (task_id TEXT NOT NULL, version INTEGER NOT NULL, message TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id, version));
    CREATE TABLE IF NOT EXISTS issue_auto_instance (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_auto_execution (singleton INTEGER PRIMARY KEY CHECK(singleton=1), task_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_auto_sessions (session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_auto_webhook_retry (hook_id INTEGER NOT NULL, guid TEXT NOT NULL, attempts INTEGER NOT NULL, last_attempt INTEGER NOT NULL, PRIMARY KEY(hook_id,guid));
    CREATE TABLE IF NOT EXISTS issue_auto_webhook_monitor (hook_id INTEGER PRIMARY KEY, last_scan INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_auto_system_notices (notice_key TEXT PRIMARY KEY, message TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS issue_auto_webhook_failures (hook_id INTEGER PRIMARY KEY, count INTEGER NOT NULL);`);
    if (
      !(
        this.db.pragma('table_info(issue_auto_system_notices)') as Array<{ name: string }>
      ).some((c) => c.name === 'repository_id')
    )
      this.db.exec('ALTER TABLE issue_auto_system_notices ADD COLUMN repository_id INTEGER');
  }
  importTask(t: IssueTask): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO issue_auto_tasks(task_id,repository_id,issue_number,actor_id,action,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING`,
        )
        .run(
          t.taskId,
          t.repositoryId,
          t.issueNumber,
          t.actorId,
          t.action,
          Date.now(),
          Date.now(),
        );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO issue_auto_progress(task_id,stage,version,context) VALUES (?, 'RECEIVED', 0, '{}')",
        )
        .run(t.taskId);
      const saved = this.get(t.taskId);
      if (
        !saved ||
        saved.repositoryId !== t.repositoryId ||
        saved.issueNumber !== t.issueNumber ||
        saved.actorId !== t.actorId ||
        saved.action !== t.action
      )
        throw new Error('conflicting task identity');
    })();
  }
  get(taskId: string): IssueTask | undefined {
    return this.db
      .prepare(
        `SELECT task_id AS taskId, repository_id AS repositoryId, issue_number AS issueNumber, actor_id AS actorId, action FROM issue_auto_tasks WHERE task_id=?`,
      )
      .get(taskId) as IssueTask | undefined;
  }
  getProgress(
    taskId: string,
  ): { stage: Stage; version: number; context: Record<string, unknown> } | undefined {
    const row = this.db
      .prepare('SELECT stage, version, context FROM issue_auto_progress WHERE task_id=?')
      .get(taskId) as { stage: Stage; version: number; context: string } | undefined;
    return row
      ? { stage: row.stage, version: row.version, context: JSON.parse(row.context) }
      : undefined;
  }
  setProgressObserver(
    observer?: (taskId: string, stage: Stage, context: Record<string, unknown>) => void,
  ): void {
    this.progressObserver = observer;
  }
  transition(
    taskId: string,
    version: number,
    stage: Stage,
    context: Record<string, unknown>,
    notice?: string,
  ): boolean {
    const changed = this.db.transaction(() => {
      const result = this.db
        .prepare(
          'UPDATE issue_auto_progress SET stage=?, version=version+1, context=? WHERE task_id=? AND version=?',
        )
        .run(stage, JSON.stringify(context), taskId, version);
      if (!result.changes) return false;
      if (notice)
        this.db
          .prepare('INSERT INTO issue_auto_notices(task_id,version,message) VALUES (?,?,?)')
          .run(taskId, version + 1, notice);
      return true;
    })();
    if (changed)
      try {
        this.progressObserver?.(taskId, stage, context);
      } catch {
        /* UI observers cannot affect committed task state */
      }
    return changed;
  }
  pendingNotices(): Array<{ taskId: string; version: number; message: string }> {
    return this.db
      .prepare(
        'SELECT task_id AS taskId, version, message FROM issue_auto_notices WHERE delivered=0 ORDER BY rowid',
      )
      .all() as Array<{ taskId: string; version: number; message: string }>;
  }
  markNoticeDelivered(taskId: string, version: number): void {
    this.db
      .prepare('UPDATE issue_auto_notices SET delivered=1 WHERE task_id=? AND version=?')
      .run(taskId, version);
  }
  recordWebhookFailure(hookId: number): number {
    this.db
      .prepare(
        'INSERT INTO issue_auto_webhook_failures(hook_id,count) VALUES(?,1) ON CONFLICT(hook_id) DO UPDATE SET count=count+1',
      )
      .run(hookId);
    return (
      this.db
        .prepare('SELECT count FROM issue_auto_webhook_failures WHERE hook_id=?')
        .get(hookId) as { count: number }
    ).count;
  }
  clearWebhookFailure(hookId: number): void {
    this.db.prepare('DELETE FROM issue_auto_webhook_failures WHERE hook_id=?').run(hookId);
  }
  webhookRetry(
    hookId: number,
    guid: string,
  ): { attempts: number; lastAttempt: number } | undefined {
    return this.db
      .prepare(
        'SELECT attempts,last_attempt AS lastAttempt FROM issue_auto_webhook_retry WHERE hook_id=? AND guid=?',
      )
      .get(hookId, guid) as { attempts: number; lastAttempt: number } | undefined;
  }
  reserveWebhookRetry(hookId: number, guid: string, now: number): void {
    this.db
      .prepare(
        'INSERT INTO issue_auto_webhook_retry(hook_id,guid,attempts,last_attempt) VALUES(?,?,1,?) ON CONFLICT(hook_id,guid) DO UPDATE SET attempts=attempts+1,last_attempt=excluded.last_attempt',
      )
      .run(hookId, guid, now);
  }
  lastWebhookScan(hookId: number): number | undefined {
    return (
      this.db
        .prepare('SELECT last_scan FROM issue_auto_webhook_monitor WHERE hook_id=?')
        .get(hookId) as { last_scan: number } | undefined
    )?.last_scan;
  }
  saveWebhookScan(hookId: number, now: number): void {
    this.db
      .prepare(
        'INSERT INTO issue_auto_webhook_monitor(hook_id,last_scan) VALUES(?,?) ON CONFLICT(hook_id) DO UPDATE SET last_scan=excluded.last_scan',
      )
      .run(hookId, now);
  }
  addSystemNotice(key: string, message: string, repositoryId?: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO issue_auto_system_notices(notice_key,message,repository_id) VALUES (?,?,?)',
      )
      .run(key, message, repositoryId ?? null);
  }
  pendingSystemNotices(): Array<{ key: string; message: string; repositoryId?: number }> {
    return this.db
      .prepare(
        'SELECT notice_key AS key,message,repository_id AS repositoryId FROM issue_auto_system_notices WHERE delivered=0 ORDER BY rowid',
      )
      .all() as Array<{ key: string; message: string; repositoryId?: number }>;
  }
  markSystemNoticeDelivered(key: string): void {
    this.db
      .prepare('UPDATE issue_auto_system_notices SET delivered=1 WHERE notice_key=?')
      .run(key);
  }
  reserveSession(sessionId: string, taskId: string): void {
    if (!sessionId || !this.get(taskId)) throw new Error('invalid session owner');
    this.db
      .prepare('INSERT OR IGNORE INTO issue_auto_sessions(session_id,task_id) VALUES (?,?)')
      .run(sessionId, taskId);
    const row = this.db
      .prepare('SELECT task_id FROM issue_auto_sessions WHERE session_id=?')
      .get(sessionId) as { task_id: string };
    if (row.task_id !== taskId) throw new Error('session already owned');
  }
  isManagedSession(sessionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM issue_auto_sessions WHERE session_id=?')
      .get(sessionId);
  }
  acquireInstance(
    pid: number,
    token: string,
    alive: (pid: number) => boolean = (other) => {
      try {
        process.kill(other, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    },
  ): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !token)
      throw new Error('invalid instance identity');
    return this.db
      .transaction(() => {
        const current = this.db
          .prepare('SELECT pid, token FROM issue_auto_instance WHERE singleton=1')
          .get() as { pid: number; token: string } | undefined;
        if (current && current.token !== token && alive(current.pid)) return false;
        this.db
          .prepare(
            'INSERT INTO issue_auto_instance(singleton,pid,token) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid, token=excluded.token',
          )
          .run(pid, token);
        return true;
      })
      .immediate();
  }
  releaseInstance(token: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM issue_auto_instance WHERE singleton=1 AND token=?')
        .run(token).changes === 1
    );
  }
  executionOwner(): string | undefined {
    return (
      this.db.prepare('SELECT task_id FROM issue_auto_execution WHERE singleton=1').get() as
        { task_id: string } | undefined
    )?.task_id;
  }
  acquireExecution(taskId: string): boolean {
    if (!this.get(taskId)) throw Error('invalid execution owner');
    return this.db
      .transaction(() => {
        const owner = this.executionOwner();
        if (owner && owner !== taskId) return false;
        // Also protect upgrades from a legacy DB which already contains running/uncertain Turns.
        for (const row of this.db
          .prepare('SELECT task_id,context FROM issue_auto_progress')
          .all() as Array<{ task_id: string; context: string }>) {
          const c = JSON.parse(row.context);
          if (row.task_id !== taskId && ['running', 'launching'].includes(c.phase))
            return false;
        }
        this.db
          .prepare('INSERT OR IGNORE INTO issue_auto_execution(singleton,task_id) VALUES(1,?)')
          .run(taskId);
        return true;
      })
      .immediate();
  }
  releaseExecution(taskId: string): void {
    this.db
      .prepare('DELETE FROM issue_auto_execution WHERE singleton=1 AND task_id=?')
      .run(taskId);
  }
  /** Recover legacy execution ownership before selecting an older PR regression. */
  recoverExecution(): void {
    const rows = (
      this.db.prepare('SELECT task_id,context FROM issue_auto_progress').all() as Array<{
        task_id: string;
        context: string;
      }>
    ).filter((row) => ['running', 'launching'].includes(JSON.parse(row.context).phase));
    if (rows.length > 1) {
      for (const row of rows)
        this.addSystemNotice(
          `execution-reconcile:${row.task_id}`,
          'Issue Runner 检测到多个运行结果未确定的 Turn，已停止新开发任务；请人工核实并停止旧 Turn 后协调执行槽与任务状态。',
          this.get(row.task_id)?.repositoryId,
        );
      throw Error('multiple uncertain Issue Turns require manual reconciliation');
    }
    if (rows.length === 1 && !this.executionOwner()) this.acquireExecution(rows[0].task_id);
  }
  listReady(): string[] {
    return (
      this.db
        .prepare(
          "SELECT task_id FROM issue_auto_progress WHERE stage='PR_READY' ORDER BY rowid",
        )
        .all() as Array<{ task_id: string }>
    ).map((x) => x.task_id);
  }
  listActive(): string[] {
    return (
      this.db
        .prepare(
          "SELECT task_id FROM issue_auto_progress WHERE stage NOT IN ('BLOCKED','WAITING_QUOTA','PAUSED','PR_READY') ORDER BY rowid",
        )
        .all() as Array<{ task_id: string }>
    ).map((x) => x.task_id);
  }
  count(): number {
    return (
      this.db.prepare('SELECT count(*) AS n FROM issue_auto_tasks').get() as { n: number }
    ).n;
  }
  close(): void {
    this.db.close();
  }
}
