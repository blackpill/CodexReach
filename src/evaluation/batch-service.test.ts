import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectTurnActionContext } from './action-collector.js';
import { BatchService } from './batch-service.js';
import { createCandidate } from './candidate-merger.js';
import { EvaluationStore } from './store.js';
import type { StructuredAction } from './action-detector.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('BatchService', () => {
  it('promotes a deployed candidate into an idempotent draft batch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-batch-'));
    dirs.push(dir);
    const store = new EvaluationStore(path.join(dir, 'state.sqlite'));
    const service = new BatchService(store);
    const context = collectTurnActionContext({
      thread: { id: 'session-1', sessionId: 'session-1', cwd: '/projects/site', preview: '', name: null, createdAt: 0, updatedAt: 0, status: { type: 'idle' }, turns: [] },
      turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: '已部署到生产环境' }] },
      completedAt: '2026-08-08T00:00:00.000Z',
      git: { headCommit: 'abc123', changedFiles: ['src/page.tsx'] },
    });
    const actions: StructuredAction[] = [{
      actionType: 'seo_change', summary: '修改 title', affectedTargets: ['/games/*'],
      requiresEvaluation: true, template: 'seo', confidence: 0.9,
      productionState: 'deployed', reason: '需要观察搜索表现',
    }];
    const candidate = createCandidate({ context, actions, id: 'candidate-1' });
    store.saveCandidate(candidate);

    const first = service.createFromVerifiedTurn({ candidate, actions, context });
    const second = service.createFromVerifiedTurn({ candidate: first.candidate, actions, context });
    expect(second.batch.id).toBe(first.batch.id);
    expect(store.getCandidate(candidate.id)?.status).toBe('deployed');
    expect(store.getDeployment(first.deployment.id)?.commitSha).toBe('abc123');

    service.updateDraftStatus(first.batch.id, 'confirmed', '2026-08-08T01:00:00.000Z');
    expect(store.getBatch(first.batch.id)?.draftStatus).toBe('confirmed');
    store.close();
  });
});
