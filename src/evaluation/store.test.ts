import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvaluationStore } from './store.js';
import type { ActionBatch, ActionCandidate, EvaluationNode, OutboxEvent } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-evaluation-'));
  dirs.push(dir);
  return new EvaluationStore(path.join(dir, 'state.sqlite'));
}

const candidate: ActionCandidate = {
  id: 'candidate-1',
  projectId: 'project-1',
  sourceSessionIds: ['session-1'],
  firstDetectedAt: '2026-08-01T00:00:00.000Z',
  lastUpdatedAt: '2026-08-01T00:00:00.000Z',
  changedFiles: ['src/page.tsx'],
  actionSummaries: ['Update metadata'],
  suggestedTemplate: 'seo',
  affectedTargets: ['/games/*'],
  confidence: 0.9,
  status: 'candidate',
  staleAt: '2026-08-31T00:00:00.000Z',
  expiresAt: '2026-10-30T00:00:00.000Z',
};

describe('EvaluationStore', () => {
  it('persists candidates and finds records that need ageing', () => {
    const store = createStore();
    store.saveCandidate(candidate);
    expect(store.getCandidate(candidate.id)).toEqual(candidate);
    expect(store.listActiveCandidates(candidate.projectId)).toEqual([candidate]);
    expect(store.findCandidatesToAge('2026-08-30T23:59:59.000Z')).toEqual([]);
    expect(store.findCandidatesToAge('2026-08-31T00:00:00.000Z')).toEqual([candidate]);

    store.saveCandidate({ ...candidate, status: 'stale', lastUpdatedAt: '2026-08-31T00:00:00.000Z' });
    expect(store.findCandidatesToAge('2026-10-30T00:00:00.000Z')).toHaveLength(1);
    store.close();
  });

  it('persists batches and enforces draft transitions', () => {
    const store = createStore();
    const batch: ActionBatch = {
      id: 'batch-1',
      projectId: 'project-1',
      candidateIds: ['candidate-1'],
      summary: 'Deploy SEO changes',
      effectiveAt: '2026-08-08T00:00:00.000Z',
      draftStatus: 'draft_pending',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    store.saveBatch(batch);
    store.saveBatch({ ...batch, draftStatus: 'confirmed', updatedAt: '2026-08-08T01:00:00.000Z' });
    expect(store.getBatch(batch.id)?.draftStatus).toBe('confirmed');
    expect(() => store.saveBatch({ ...batch, draftStatus: 'draft_pending' })).toThrow(/Invalid draft transition/);
    store.close();
  });

  it('returns only due scheduled nodes and rejects skipped transitions', () => {
    const store = createStore();
    const node: EvaluationNode = {
      id: 'node-1',
      planId: 'plan-1',
      purpose: 'Check indexing',
      dueAt: '2026-08-15T00:00:00.000Z',
      status: 'scheduled',
      reminderStage: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    store.saveNode(node);
    expect(store.findDueNodes('2026-08-14T23:59:59.000Z')).toEqual([]);
    expect(store.findDueNodes('2026-08-15T00:00:00.000Z')).toEqual([node]);
    expect(() => store.saveNode({ ...node, status: 'completed' })).toThrow(/Invalid evaluation node transition/);
    store.close();
  });

  it('deduplicates outbox events by idempotency key', () => {
    const store = createStore();
    const event: OutboxEvent = {
      id: 'event-1',
      idempotencyKey: 'create-task:node-1',
      eventType: 'feishu.task.create',
      aggregateId: 'node-1',
      payload: { nodeId: 'node-1' },
      status: 'pending',
      retryCount: 0,
      nextRetryAt: '2026-08-08T00:00:00.000Z',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    expect(store.enqueue(event)).toBe(true);
    expect(store.enqueue({ ...event, id: 'event-2' })).toBe(false);
    expect(store.findDeliverableEvents('2026-08-08T00:00:00.000Z')).toEqual([event]);
    store.close();
  });
});
