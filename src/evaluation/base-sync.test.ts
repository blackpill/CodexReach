import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseSyncService, type EvaluationBaseApi } from './base-sync.js';
import { EvaluationStore } from './store.js';
import type { ActionBatch, ActionCandidate, EvaluationNode, EvaluationPlan, EvaluationRun } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('BaseSyncService', () => {
  it('creates linked action/plan/result records and updates them idempotently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-base-sync-'));
    dirs.push(dir);
    const store = new EvaluationStore(path.join(dir, 'state.sqlite'));
    let sequence = 0;
    const createRecord = vi.fn(async () => `record-${++sequence}`);
    const updateRecord = vi.fn(async () => undefined);
    const api: EvaluationBaseApi = {
      findProjectRecord: vi.fn(async () => 'project-record-1'), createRecord, updateRecord,
    };
    const service = new BaseSyncService(store, api, {
      baseToken: 'base', projectTableId: 'project-table', actionTableId: 'action-table', planTableId: 'plan-table', resultTableId: 'result-table',
    });
    const batch: ActionBatch = { id: 'batch-1', projectId: 'project-1', projectPath: '/projects/site', projectName: 'site', candidateIds: ['candidate-1'], summary: '修改 title', effectiveAt: '2026-08-01T00:00:00.000Z', draftStatus: 'confirmed', sourceSessionId: 'session-1', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' };
    const candidate: ActionCandidate = { id: 'candidate-1', projectId: 'project-1', sourceSessionIds: ['session-1'], firstDetectedAt: '2026-08-01T00:00:00.000Z', lastUpdatedAt: '2026-08-01T00:00:00.000Z', changedFiles: [], actionSummaries: ['修改 title'], suggestedTemplate: 'seo', affectedTargets: ['/games/*'], confidence: 0.9, status: 'deployed', staleAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z' };
    const plan: EvaluationPlan = { id: 'plan-1', batchId: batch.id, template: 'seo', confirmedAt: '2026-08-01T01:00:00.000Z', createdAt: '2026-08-01T01:00:00.000Z' };
    const node: EvaluationNode = { id: 'node-1', planId: plan.id, purpose: '检查索引', dueAt: '2026-08-08T00:00:00.000Z', status: 'scheduled', reminderStage: 0, feishuTaskGuid: 'task-1', createdAt: '2026-08-01T01:00:00.000Z', updatedAt: '2026-08-01T01:00:00.000Z' };
    await service.syncPlan({ batch, candidate, plan, nodes: [node] });
    await service.syncPlan({ batch, candidate, plan, nodes: [node] });
    expect(createRecord).toHaveBeenCalledTimes(2);
    expect(updateRecord).toHaveBeenCalledTimes(2);
    expect(store.getBaseRecordId('action', batch.id)).toBe('record-1');
    expect(store.getBaseRecordId('plan-node', node.id)).toBe('record-2');

    const run: EvaluationRun = { id: 'run-1', nodeId: node.id, sessionId: 'evaluation-session', startedAt: '2026-08-08T00:00:00.000Z', finishedAt: '2026-08-08T01:00:00.000Z', conclusion: 'effective', confidence: 0.8 };
    await service.syncResult({ batch, plan, node, run, result: { conclusion: 'effective', confidence: 0.8, summary: '点击改善', recommendation: '继续观察', evidence: { clicks: 100 } } });
    expect(store.getBaseRecordId('result', run.id)).toBe('record-3');
    expect(updateRecord).toHaveBeenCalledWith('action-table', 'record-1', { '当前结论': '倾向有效' });
    expect(updateRecord).toHaveBeenCalledWith('plan-table', 'record-2', expect.objectContaining({ '状态': '已完成' }));
    store.close();
  });
});
