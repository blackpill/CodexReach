import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvaluationScheduler } from './scheduler.js';
import { EvaluationStore } from './store.js';
import type { ActionBatch, EvaluationNode, EvaluationPlan } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('EvaluationScheduler', () => {
  it('delivers due cards once and reminds on day 1, 3 and 7', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-scheduler-'));
    dirs.push(dir);
    const store = new EvaluationStore(path.join(dir, 'state.sqlite'));
    const batch: ActionBatch = {
      id: 'batch-1', projectId: 'project-1', projectPath: '/projects/site', candidateIds: [], summary: 'SEO',
      effectiveAt: '2026-08-01T00:00:00.000Z', draftStatus: 'confirmed', sourceSessionId: 'session-1',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const plan: EvaluationPlan = { id: 'plan-1', batchId: batch.id, template: 'seo', confirmedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' };
    const node: EvaluationNode = {
      id: 'node-1', planId: plan.id, purpose: '检查索引', dueAt: '2026-08-08T00:00:00.000Z',
      status: 'scheduled', reminderStage: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    };
    store.saveBatch(batch); store.savePlan(plan); store.saveNode(node);
    let now = '2026-08-08T00:00:00.000Z';
    const onDue = vi.fn(async (_context: unknown) => true);
    const onReminder = vi.fn(async (_context: unknown, _stage: 1 | 3 | 7) => true);
    const scheduler = new EvaluationScheduler(store, { enabled: true, now: () => now, onDue, onReminder });

    await scheduler.tick();
    await scheduler.tick();
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(store.getNode(node.id)).toMatchObject({ status: 'waiting_confirmation', reminderStage: 0 });

    now = '2026-08-09T00:00:00.000Z'; await scheduler.tick();
    now = '2026-08-11T00:00:00.000Z'; await scheduler.tick();
    now = '2026-08-15T00:00:00.000Z'; await scheduler.tick();
    now = '2026-08-20T00:00:00.000Z'; await scheduler.tick();
    expect(onReminder.mock.calls.map((call) => call[1])).toEqual([1, 3, 7]);
    expect(store.getNode(node.id)?.reminderStage).toBe(7);
    store.close();
  });

  it('keeps a node scheduled when delivery is unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-scheduler-'));
    dirs.push(dir);
    const store = new EvaluationStore(path.join(dir, 'state.sqlite'));
    store.saveBatch({ id: 'batch-1', projectId: 'project-1', candidateIds: [], summary: 'Release', effectiveAt: '2026-08-01T00:00:00.000Z', draftStatus: 'confirmed', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' });
    store.savePlan({ id: 'plan-1', batchId: 'batch-1', template: 'release', confirmedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' });
    store.saveNode({ id: 'node-1', planId: 'plan-1', purpose: '稳定性', dueAt: '2026-08-02T00:00:00.000Z', status: 'scheduled', reminderStage: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' });
    const scheduler = new EvaluationScheduler(store, { enabled: true, now: () => '2026-08-02T00:00:00.000Z', onDue: async () => false, onReminder: async () => false });
    await scheduler.tick();
    expect(store.getNode('node-1')?.status).toBe('scheduled');
    store.close();
  });
});
