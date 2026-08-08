import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionProcessor } from './action-processor.js';
import { EvaluationStore } from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexreach-action-processor-'));
  dirs.push(dir);
  const store = new EvaluationStore(path.join(dir, 'state.sqlite'));
  const readThread = vi.fn(async () => ({
    id: 'session-1', sessionId: 'session-1', cwd: '/projects/site', preview: '', name: 'SEO',
    createdAt: 0, updatedAt: 0, status: { type: 'idle' },
    turns: [{
      id: 'turn-1', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'inputText', text: '修改 title 并部署' }] },
        { type: 'agentMessage', text: '已部署到 production，title 已生效。' },
      ],
    }],
  }));
  const processor = new ActionProcessor({ readThread } as any, store, {
    enabled,
    now: () => '2026-08-08T00:00:00.000Z',
    collectGit: async () => ({
      root: '/projects/site', baseCommit: 'aaa', headCommit: 'bbb', changedFiles: ['src/page.tsx'],
    }),
  });
  return { processor, readThread, store };
}

const notification = {
  method: 'turn/completed',
  params: { threadId: 'session-1', turn: { id: 'turn-1', status: 'completed' } },
};

describe('ActionProcessor', () => {
  it('collects, classifies and persists a completed turn exactly once', async () => {
    const { processor, readThread, store } = setup();
    await processor.handleNotification(notification);
    await processor.handleNotification(notification);

    const projectId = Buffer.from('/projects/site').toString('base64url');
    const candidates = store.listActiveCandidates(projectId);
    expect(candidates).toHaveLength(1);
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(candidates[0]).toMatchObject({
      suggestedTemplate: 'seo',
      sourceSessionIds: ['session-1'],
      changedFiles: ['src/page.tsx'],
      currentCommit: 'bbb',
    });
    store.close();
  });

  it('does nothing while the feature flag is disabled', async () => {
    const { processor, readThread, store } = setup(false);
    await processor.handleNotification(notification);
    expect(readThread).not.toHaveBeenCalled();
    store.close();
  });
});
