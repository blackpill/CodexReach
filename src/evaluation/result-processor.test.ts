import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvaluationResultProcessor } from './result-processor.js';
import { EvaluationStore } from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(turnStatus = 'completed') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-result-'));
  dirs.push(dir);
  const store = new EvaluationStore(path.join(dir, 'state.sqlite'));
  store.saveBatch({ id: 'batch-1', projectId: 'project-1', projectPath: '/projects/site', candidateIds: [], summary: 'SEO', effectiveAt: '2026-08-01T00:00:00.000Z', draftStatus: 'confirmed', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' });
  store.savePlan({ id: 'plan-1', batchId: 'batch-1', template: 'seo', confirmedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' });
  store.saveNode({ id: 'node-1', planId: 'plan-1', purpose: '评估点击', dueAt: '2026-08-08T00:00:00.000Z', status: 'running', reminderStage: 0, startedSessionId: 'evaluation-session', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z' });
  const readThread = vi.fn(async () => ({
    id: 'evaluation-session', turns: [{ id: 'turn-1', status: turnStatus, items: [{ type: 'agentMessage', text: '```json\n{"conclusion":"no_material_change","confidence":0.7,"summary":"基本持平","recommendation":"继续观察","evidence":{}}\n```' }] }],
  }));
  return { store, readThread };
}

const notification = { method: 'turn/completed', params: { threadId: 'evaluation-session', turn: { id: 'turn-1', status: 'completed' } } };

describe('EvaluationResultProcessor', () => {
  it('persists a structured result, invokes completion and deduplicates events', async () => {
    const { store, readThread } = setup();
    const onCompleted = vi.fn(async () => undefined);
    const processor = new EvaluationResultProcessor({ readThread } as any, store, { enabled: true, now: () => '2026-08-08T01:00:00.000Z', onCompleted });
    await processor.handleNotification(notification);
    await processor.handleNotification(notification);
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(store.getNode('node-1')?.status).toBe('completed');
    expect(store.getRunBySession('evaluation-session')).toMatchObject({ conclusion: 'no_material_change', confidence: 0.7 });
    store.close();
  });

  it('marks a failed evaluation without completing it', async () => {
    const { store, readThread } = setup('failed');
    const onFailed = vi.fn(async () => undefined);
    const processor = new EvaluationResultProcessor({ readThread } as any, store, { enabled: true, now: () => '2026-08-08T01:00:00.000Z', onFailed });
    await processor.handleNotification(notification);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(store.getNode('node-1')?.status).toBe('failed');
    expect(store.getRunBySession('evaluation-session')?.conclusion).toBe('technical_issue');
    store.close();
  });
});
