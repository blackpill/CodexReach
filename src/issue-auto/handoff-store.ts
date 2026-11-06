import type Database from 'better-sqlite3';
import type { IssueStore } from './store.js';
export type ControlMode =
  'auto' | 'requested' | 'manual' | 'resume_requested' | 'blocked';
export type ManualNote = {
  id: string;
  taskId: string;
  actor: string;
  text: string;
  kind: 'manual' | 'feedback';
  state:
    | 'feedback'
    | 'queued'
    | 'launching'
    | 'running'
    | 'done'
    | 'failed'
    | 'uncertain'
    | 'consumed';
  turnId?: string;
};
export class HandoffStore {
  private db: Database.Database;
  constructor(private tasks: IssueStore) {
    this.db = tasks.controlDatabase;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_auto_controls(task_id TEXT PRIMARY KEY,mode TEXT NOT NULL,owner TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS issue_auto_feedback(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,actor TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,turn_id TEXT,created_at INTEGER NOT NULL);`,
    );
  }
  taskForSession(sessionId: string): string | undefined {
    return (
      this.db
        .prepare('SELECT task_id FROM issue_auto_sessions WHERE session_id=?')
        .get(sessionId) as { task_id: string } | undefined
    )?.task_id;
  }
  control(taskId: string): { mode: ControlMode; owner?: string } {
    return (
      (this.db
        .prepare('SELECT mode,owner FROM issue_auto_controls WHERE task_id=?')
        .get(taskId) as { mode: ControlMode; owner: string } | undefined) ?? {
        mode: 'auto',
      }
    );
  }
  private owned(taskId: string, actor: string) {
    const c = this.control(taskId);
    if (c.owner && c.owner !== actor) throw Error('该任务已由另一位用户接管');
    return c;
  }
  request(sessionId: string, actor: string): string {
    const id = this.taskForSession(sessionId);
    if (!id) throw Error('不是受管 Issue 会话');
    this.db
      .transaction(() => {
        const c = this.owned(id, actor);
        if (c.mode === 'auto')
          this.db
            .prepare(
              "INSERT INTO issue_auto_controls(task_id,mode,owner,updated_at) VALUES(?,'requested',?,?) ON CONFLICT(task_id) DO UPDATE SET mode='requested',owner=excluded.owner,updated_at=excluded.updated_at",
            )
            .run(id, actor, Date.now());
      })
      .immediate();
    return id;
  }
  saveFeedback(
    sessionId: string,
    actor: string,
    id: string,
    text: string,
    feedbackOnly = false,
  ): void {
    const taskId = this.taskForSession(sessionId);
    if (!taskId) throw Error('不是受管 Issue 会话');
    if (!id || !text.trim() || text.length > 20000)
      throw Error('意见不能为空且不能超过20000字符');
    this.db
      .transaction(() => {
        const c = this.owned(taskId, actor),
          manual = c.mode === 'manual' && !feedbackOnly;
        this.db
          .prepare(
            'INSERT OR IGNORE INTO issue_auto_feedback(id,task_id,actor,text,kind,state,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            id,
            taskId,
            actor,
            text,
            manual ? 'manual' : 'feedback',
            manual ? 'queued' : 'feedback',
            Date.now(),
          );
        const existing = this.db
          .prepare('SELECT task_id,actor,text FROM issue_auto_feedback WHERE id=?')
          .get(id) as { task_id: string; actor: string; text: string };
        if (
          existing.task_id !== taskId ||
          existing.actor !== actor ||
          existing.text !== text
        )
          throw Error('消息ID重复且内容不一致');
      })
      .immediate();
  }
  notes(taskId: string): ManualNote[] {
    return this.db
      .prepare(
        "SELECT id,task_id AS taskId,actor,text,kind,state,turn_id AS turnId FROM issue_auto_feedback WHERE task_id=? AND state!='consumed' ORDER BY created_at,rowid",
      )
      .all(taskId) as ManualNote[];
  }
  nextManual(taskId: string): ManualNote | undefined {
    return this.notes(taskId).find((n) => n.kind === 'manual' && n.state === 'queued');
  }
  runningManual(taskId: string): ManualNote | undefined {
    return this.notes(taskId).find((n) =>
      ['launching', 'running', 'uncertain'].includes(n.state),
    );
  }
  markManual(id: string, state: ManualNote['state'], turnId?: string): void {
    const row = this.db
      .prepare('SELECT state FROM issue_auto_feedback WHERE id=?')
      .get(id) as { state: string } | undefined;
    if (!row) throw Error('消息不存在');
    const valid: Record<string, string[]> = {
      queued: ['launching'],
      launching: ['running', 'uncertain'],
      running: ['done', 'failed', 'uncertain'],
    };
    if (!valid[row.state]?.includes(state)) throw Error('手工回合状态不可重复或跳转');
    this.db
      .prepare(
        'UPDATE issue_auto_feedback SET state=?,turn_id=COALESCE(?,turn_id) WHERE id=? AND state=?',
      )
      .run(state, turnId ?? null, id, row.state);
  }
  enterManual(taskId: string, proof?: { version: number; turnId: string }): void {
    this.db
      .transaction(() => {
        const c = this.control(taskId),
          p = this.tasks.getProgress(taskId);
        if (c.mode !== 'requested' || !p) throw Error('未请求接管');
        if (
          ['launching', 'preparing-active', 'validation-active', 'publishing'].includes(
            String(p.context.phase),
          ) ||
          (p.context.phase === 'running' &&
            (!proof || proof.version !== p.version || proof.turnId !== p.context.turnId))
        )
          throw Error('执行结果尚未核实，不能接管');
        const context = {
          ...p.context,
          phase: 'manual-idle',
          reason: 'manual_control',
          handoffFromStage: p.stage,
        };
        this.db
          .prepare(
            "UPDATE issue_auto_progress SET stage='PAUSED',version=version+1,context=? WHERE task_id=? AND version=?",
          )
          .run(JSON.stringify(context), taskId, p.version);
        this.db
          .prepare(
            "UPDATE issue_auto_controls SET mode='manual',updated_at=? WHERE task_id=?",
          )
          .run(Date.now(), taskId);
        this.tasks.releaseExecution(taskId);
        this.db
          .prepare(
            'INSERT INTO issue_auto_notices(task_id,version,message) VALUES(?,?,?)',
          )
          .run(
            taskId,
            p.version + 1,
            '已安全进入人工模式。可在原话题发送修改意见，系统不会自动提交或推送；完成后点击继续自动修改。',
          );
      })
      .immediate();
  }
  rejectResume(taskId: string, message: string): void {
    const p = this.tasks.getProgress(taskId);
    if (!p) return;
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE issue_auto_controls SET mode='manual',updated_at=? WHERE task_id=? AND mode='resume_requested'",
          )
          .run(Date.now(), taskId);
        this.tasks.transition(
          taskId,
          p.version,
          'PAUSED',
          { ...p.context, phase: 'manual-idle', reason: 'manual_control' },
          message,
        );
      })
      .immediate();
  }
  requestResume(sessionId: string, actor: string): string {
    const id = this.taskForSession(sessionId);
    if (!id) throw Error('不是受管 Issue 会话');
    this.db
      .transaction(() => {
        const c = this.owned(id, actor);
        if (c.mode !== 'manual' && c.mode !== 'resume_requested')
          throw Error('请先人工接管；自动任务仍在运行时只保存意见');
        this.db
          .prepare(
            "UPDATE issue_auto_controls SET mode='resume_requested',updated_at=? WHERE task_id=?",
          )
          .run(Date.now(), id);
      })
      .immediate();
    return id;
  }
  resumeAuto(taskId: string, evidence: string): void {
    this.db
      .transaction(() => {
        const c = this.control(taskId),
          p = this.tasks.getProgress(taskId);
        if (
          c.mode !== 'resume_requested' ||
          !p ||
          p.stage !== 'PAUSED' ||
          this.runningManual(taskId)
        )
          throw Error('尚未达到安全恢复边界');
        const owner = this.tasks.executionOwner();
        if (owner && owner !== taskId) throw Error('其他任务正在执行');
        const context = {
          ...p.context,
          phase: 'repair-ready',
          startedAt: Date.now(),
          turnCount: 0,
          validationFailures: 0,
          ciFailures: 0,
          noProgress: 0,
          lastFailedCommit: undefined,
          reason: undefined,
          failedChecks: evidence,
        };
        this.db
          .prepare(
            "UPDATE issue_auto_progress SET stage='DEVELOPING',version=version+1,context=? WHERE task_id=? AND version=?",
          )
          .run(JSON.stringify(context), taskId, p.version);
        this.db
          .prepare(
            "UPDATE issue_auto_controls SET mode='auto',updated_at=? WHERE task_id=?",
          )
          .run(Date.now(), taskId);
        this.db
          .prepare(
            "UPDATE issue_auto_feedback SET state='consumed' WHERE task_id=? AND state IN ('feedback','queued','done','failed')",
          )
          .run(taskId);
        this.tasks.releaseExecution(taskId);
      })
      .immediate();
  }
  blockManual(taskId: string): void {
    this.db
      .prepare(
        "UPDATE issue_auto_controls SET mode='blocked',updated_at=? WHERE task_id=?",
      )
      .run(Date.now(), taskId);
    this.tasks.addSystemNotice(
      `manual-uncertain:${taskId}`,
      '人工回合启动或执行结果不确定，已保留执行锁。请核查旧进程；系统不会重复发送。',
      this.tasks.get(taskId)?.repositoryId,
    );
  }
  uiStage(id: string, stage: string): string {
    const mode = this.control(id).mode;
    return (
      (
        {
          requested: 'HANDOFF_PENDING',
          manual: this.runningManual(id) ? 'MANUAL_RUNNING' : 'MANUAL',
          resume_requested: 'RESUME_PENDING',
          blocked: 'MANUAL_BLOCKED',
        } as Record<string, string>
      )[mode] ?? stage
    );
  }
  sessions(): Array<{ sessionId: string; taskId: string }> {
    return this.db
      .prepare(
        'SELECT session_id AS sessionId,task_id AS taskId FROM issue_auto_sessions',
      )
      .all() as Array<{ sessionId: string; taskId: string }>;
  }
  restoredStage(id: string, stage: string, version: number): string {
    if (
      stage === 'PR_READY' &&
      (
        this.db
          .prepare(
            'SELECT delivered FROM issue_auto_notices WHERE task_id=? AND version=?',
          )
          .get(id, version) as { delivered: number } | undefined
      )?.delivered === 1
    )
      return 'PR_NOTIFIED';
    return this.uiStage(id, stage);
  }
  controls(): Array<{ taskId: string; mode: ControlMode; owner: string }> {
    return this.db
      .prepare(
        "SELECT task_id AS taskId,mode,owner FROM issue_auto_controls WHERE mode!='auto' ORDER BY rowid",
      )
      .all() as Array<{ taskId: string; mode: ControlMode; owner: string }>;
  }
}
