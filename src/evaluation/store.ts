import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { assertCandidateTransition, assertDraftTransition, assertNodeTransition } from './state-machine.js';
import type {
  ActionBatch,
  ActionCandidate,
  Deployment,
  EvaluationNode,
  EvaluationNodeStatus,
  EvaluationPlan,
  EvaluationRun,
  OutboxEvent,
} from './types.js';

type JsonRow = { value_json: string };

export class EvaluationStore {
  private readonly db: Database.Database;

  constructor(readonly databasePath = path.resolve('.data/feishu-state.sqlite')) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close() { this.db.close(); }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_action_candidates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stale_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evaluation_candidates_status_stale_idx
        ON evaluation_action_candidates(status, stale_at);
      CREATE INDEX IF NOT EXISTS evaluation_candidates_status_expiry_idx
        ON evaluation_action_candidates(status, expires_at);

      CREATE TABLE IF NOT EXISTS evaluation_action_batches (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        draft_status TEXT NOT NULL,
        effective_at TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_deployments (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        deployment_id TEXT,
        effective_at TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(provider, deployment_id)
      );

      CREATE TABLE IF NOT EXISTS evaluation_processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_nodes (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT NOT NULL,
        reminder_stage INTEGER NOT NULL DEFAULT 0,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_plans (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE,
        template TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evaluation_nodes_status_due_idx
        ON evaluation_nodes(status, due_at);

      CREATE TABLE IF NOT EXISTS evaluation_outbox (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conclusion TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evaluation_runs_node_idx ON evaluation_runs(node_id, started_at);
      CREATE UNIQUE INDEX IF NOT EXISTS evaluation_runs_session_idx ON evaluation_runs(session_id);
      CREATE INDEX IF NOT EXISTS evaluation_outbox_delivery_idx
        ON evaluation_outbox(status, next_retry_at);
    `);
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  saveCandidate(candidate: ActionCandidate) {
    const existing = this.getCandidate(candidate.id);
    if (existing) assertCandidateTransition(existing.status, candidate.status);
    this.db.prepare(`
      INSERT INTO evaluation_action_candidates(
        id, project_id, status, stale_at, expires_at, value_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        status = excluded.status,
        stale_at = excluded.stale_at,
        expires_at = excluded.expires_at,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(
      candidate.id,
      candidate.projectId,
      candidate.status,
      candidate.staleAt,
      candidate.expiresAt,
      JSON.stringify(candidate),
      candidate.firstDetectedAt,
      candidate.lastUpdatedAt,
    );
  }

  getCandidate(id: string): ActionCandidate | undefined {
    const row = this.db.prepare('SELECT value_json FROM evaluation_action_candidates WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as ActionCandidate : undefined;
  }

  listActiveCandidates(projectId: string): ActionCandidate[] {
    const rows = this.db.prepare(`
      SELECT value_json FROM evaluation_action_candidates
      WHERE project_id = ? AND status IN ('candidate', 'stale')
      ORDER BY updated_at DESC
    `).all(projectId) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value_json) as ActionCandidate);
  }

  findCandidatesToAge(now: string): ActionCandidate[] {
    const rows = this.db.prepare(`
      SELECT value_json FROM evaluation_action_candidates
      WHERE (status = 'candidate' AND stale_at <= ?)
         OR (status IN ('candidate', 'stale') AND expires_at <= ?)
      ORDER BY expires_at, stale_at
    `).all(now, now) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value_json) as ActionCandidate);
  }

  saveBatch(batch: ActionBatch) {
    const existing = this.getBatch(batch.id);
    if (existing) assertDraftTransition(existing.draftStatus, batch.draftStatus);
    this.db.prepare(`
      INSERT INTO evaluation_action_batches(
        id, project_id, draft_status, effective_at, value_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        draft_status = excluded.draft_status,
        effective_at = excluded.effective_at,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(
      batch.id,
      batch.projectId,
      batch.draftStatus,
      batch.effectiveAt,
      JSON.stringify(batch),
      batch.createdAt,
      batch.updatedAt,
    );
  }

  getBatch(id: string): ActionBatch | undefined {
    const row = this.db.prepare('SELECT value_json FROM evaluation_action_batches WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as ActionBatch : undefined;
  }

  saveDeployment(deployment: Deployment) {
    this.db.prepare(`
      INSERT INTO evaluation_deployments(
        id, batch_id, provider, deployment_id, effective_at, value_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        batch_id = excluded.batch_id,
        provider = excluded.provider,
        deployment_id = excluded.deployment_id,
        effective_at = excluded.effective_at,
        value_json = excluded.value_json
    `).run(
      deployment.id,
      deployment.batchId,
      deployment.provider,
      deployment.deploymentId ?? null,
      deployment.effectiveAt,
      JSON.stringify(deployment),
      deployment.verifiedAt,
    );
  }

  getDeployment(id: string): Deployment | undefined {
    const row = this.db.prepare('SELECT value_json FROM evaluation_deployments WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as Deployment : undefined;
  }

  hasProcessedEvent(eventId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM evaluation_processed_events WHERE event_id = ?').get(eventId));
  }

  markEventProcessed(eventId: string, processedAt: string): boolean {
    const result = this.db.prepare(`
      INSERT INTO evaluation_processed_events(event_id, processed_at)
      VALUES (?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(eventId, processedAt);
    return result.changes === 1;
  }

  saveNode(node: EvaluationNode) {
    const existing = this.getNode(node.id);
    if (existing) assertNodeTransition(existing.status, node.status);
    this.db.prepare(`
      INSERT INTO evaluation_nodes(
        id, plan_id, status, due_at, reminder_stage, value_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        plan_id = excluded.plan_id,
        status = excluded.status,
        due_at = excluded.due_at,
        reminder_stage = excluded.reminder_stage,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(
      node.id,
      node.planId,
      node.status,
      node.dueAt,
      node.reminderStage,
      JSON.stringify(node),
      node.createdAt,
      node.updatedAt,
    );
  }

  savePlan(plan: EvaluationPlan) {
    this.db.prepare(`
      INSERT INTO evaluation_plans(id, batch_id, template, value_json, created_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template = excluded.template,
        value_json = excluded.value_json,
        confirmed_at = excluded.confirmed_at
    `).run(plan.id, plan.batchId, plan.template, JSON.stringify(plan), plan.createdAt, plan.confirmedAt);
  }

  getPlan(id: string): EvaluationPlan | undefined {
    const row = this.db.prepare('SELECT value_json FROM evaluation_plans WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as EvaluationPlan : undefined;
  }

  getPlanByBatch(batchId: string): EvaluationPlan | undefined {
    const row = this.db.prepare('SELECT value_json FROM evaluation_plans WHERE batch_id = ?').get(batchId) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as EvaluationPlan : undefined;
  }

  listNodesByPlan(planId: string): EvaluationNode[] {
    const rows = this.db.prepare('SELECT value_json FROM evaluation_nodes WHERE plan_id = ? ORDER BY due_at').all(planId) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value_json) as EvaluationNode);
  }

  getNode(id: string): EvaluationNode | undefined {
    const row = this.db.prepare('SELECT value_json FROM evaluation_nodes WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as EvaluationNode : undefined;
  }

  findDueNodes(now: string): EvaluationNode[] {
    const rows = this.db.prepare(`
      SELECT value_json FROM evaluation_nodes
      WHERE status = 'scheduled' AND due_at <= ?
      ORDER BY due_at
    `).all(now) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value_json) as EvaluationNode);
  }

  listNodesByStatus(status: EvaluationNodeStatus): EvaluationNode[] {
    const rows = this.db.prepare(`
      SELECT value_json FROM evaluation_nodes WHERE status = ? ORDER BY due_at
    `).all(status) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value_json) as EvaluationNode);
  }

  isEvaluationSession(sessionId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM evaluation_nodes
      WHERE json_extract(value_json, '$.startedSessionId') = ?
      LIMIT 1
    `).get(sessionId);
    return Boolean(row);
  }

  getNodeBySession(sessionId: string): EvaluationNode | undefined {
    const row = this.db.prepare(`
      SELECT value_json FROM evaluation_nodes
      WHERE json_extract(value_json, '$.startedSessionId') = ?
      LIMIT 1
    `).get(sessionId) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as EvaluationNode : undefined;
  }

  saveRun(run: EvaluationRun) {
    const updatedAt = run.finishedAt ?? run.startedAt;
    this.db.prepare(`
      INSERT INTO evaluation_runs(id, node_id, session_id, conclusion, started_at, finished_at, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conclusion = excluded.conclusion,
        finished_at = excluded.finished_at,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(
      run.id, run.nodeId, run.sessionId, run.conclusion ?? null, run.startedAt,
      run.finishedAt ?? null, JSON.stringify(run), updatedAt,
    );
  }

  getRunBySession(sessionId: string): EvaluationRun | undefined {
    const row = this.db.prepare('SELECT value_json FROM evaluation_runs WHERE session_id = ?').get(sessionId) as JsonRow | undefined;
    return row ? JSON.parse(row.value_json) as EvaluationRun : undefined;
  }

  enqueue<T extends Record<string, unknown>>(event: OutboxEvent<T>): boolean {
    const result = this.db.prepare(`
      INSERT INTO evaluation_outbox(
        id, idempotency_key, event_type, aggregate_id, status, retry_count,
        next_retry_at, value_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      event.id,
      event.idempotencyKey,
      event.eventType,
      event.aggregateId,
      event.status,
      event.retryCount,
      event.nextRetryAt,
      JSON.stringify(event),
      event.createdAt,
      event.updatedAt,
    );
    return result.changes === 1;
  }

  findDeliverableEvents(now: string, limit = 50): OutboxEvent[] {
    const rows = this.db.prepare(`
      SELECT value_json FROM evaluation_outbox
      WHERE status IN ('pending', 'failed') AND next_retry_at <= ?
      ORDER BY next_retry_at, created_at
      LIMIT ?
    `).all(now, limit) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value_json) as OutboxEvent);
  }
}
