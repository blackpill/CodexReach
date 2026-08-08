import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanService } from './plan-service.js';
import { EvaluationStore } from './store.js';
import type { ActionBatch, ActionCandidate } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('PlanService', () => {
  it('creates stable SEO 7/28-day nodes and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-plan-'));
    dirs.push(dir);
    const store = new EvaluationStore(path.join(dir, 'state.sqlite'));
    const candidate: ActionCandidate = {
      id: 'candidate-1', projectId: 'project-1', sourceSessionIds: ['session-1'],
      firstDetectedAt: '2026-08-08T00:00:00.000Z', lastUpdatedAt: '2026-08-08T00:00:00.000Z',
      changedFiles: [], actionSummaries: ['SEO'], suggestedTemplate: 'seo', affectedTargets: ['/'], confidence: 0.9,
      status: 'deployed', staleAt: '2026-09-08T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z',
    };
    const batch: ActionBatch = {
      id: 'batch-1', projectId: 'project-1', candidateIds: [candidate.id], summary: 'SEO',
      effectiveAt: '2026-08-08T00:00:00.000Z', draftStatus: 'confirmed',
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
    };
    store.saveCandidate(candidate); store.saveBatch(batch);
    const service = new PlanService(store);
    const first = service.confirmBatch(batch.id, '2026-08-08T01:00:00.000Z');
    const second = service.confirmBatch(batch.id, '2026-08-08T02:00:00.000Z');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.nodes.map((node) => node.dueAt)).toEqual(['2026-08-15T00:00:00.000Z', '2026-09-05T00:00:00.000Z']);
    expect(second.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    store.close();
  });
});
