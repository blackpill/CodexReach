import { describe, expect, it } from 'vitest';
import { collectTurnActionContext } from './action-collector.js';
import { detectStructuredActions, parseStructuredDetection } from './action-detector.js';
import { prefilterActionContext } from './action-prefilter.js';
import { canMergeCandidate, createCandidate, mergeCandidates } from './candidate-merger.js';

function context(overrides: Record<string, unknown> = {}) {
  return collectTurnActionContext({
    thread: {
      id: 'session-1', sessionId: 'session-1', cwd: '/projects/site', preview: '', name: 'SEO',
      createdAt: 0, updatedAt: 0, status: { type: 'idle' }, turns: [],
    },
    turn: {
      id: 'turn-1', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'inputText', text: '修改页面 title 并部署' }] },
        { type: 'commandExecutionToolCall', command: 'npm run deploy', status: 'completed' },
        { type: 'agentMessage', text: '已部署到 production，页面 title 已生效。' },
      ],
    },
    completedAt: '2026-08-08T00:00:00.000Z',
    git: { baseCommit: 'aaa', headCommit: 'bbb', changedFiles: ['src/page.tsx', 'src/page.tsx'] },
    ...overrides,
  });
}

describe('action collection and prefilter', () => {
  it('normalizes turn, tool and git evidence', () => {
    const result = context();
    expect(result.userIntent).toBe('修改页面 title 并部署');
    expect(result.agentResult).toContain('已部署到 production');
    expect(result.toolNames).toEqual(['npm run deploy']);
    expect(result.git.changedFiles).toEqual(['src/page.tsx']);
    expect(result.projectName).toBe('site');
  });

  it('accepts a deployed SEO change and rejects failed or query-only turns', () => {
    expect(prefilterActionContext(context())).toMatchObject({ eligible: true, signals: expect.arrayContaining(['deployment', 'seo_change']) });
    expect(prefilterActionContext(context({ turn: { id: 'turn-1', status: 'failed', items: [] } }))).toMatchObject({ eligible: false, signals: ['turn_failed'] });
    expect(prefilterActionContext(context({
      turn: { id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'inputText', text: '查看项目状态' }] }, { type: 'agentMessage', text: '项目正常。' }] },
      git: {},
    }))).toMatchObject({ eligible: false, signals: ['query_only'] });
  });
});

describe('structured action detection', () => {
  const raw = {
    batchSummary: '上线 SEO metadata',
    actions: [{
      actionType: 'seo_metadata', summary: '修改 title', affectedTargets: ['/games/*'],
      requiresEvaluation: true, template: 'seo', confidence: 0.92,
      productionState: 'deployed', reason: '搜索效果需要等待观察',
    }],
  };

  it('validates classifier output and skips an ineligible context', async () => {
    expect(parseStructuredDetection(raw).actions[0].template).toBe('seo');
    expect(parseStructuredDetection(JSON.stringify(raw)).batchSummary).toBe('上线 SEO metadata');
    await expect(detectStructuredActions(async () => raw, context(), { eligible: false, score: 0, signals: [], reasons: [] }))
      .resolves.toEqual({ actions: [], batchSummary: '未发现需要评估的行动' });
    expect(() => parseStructuredDetection({ ...raw, actions: [{ ...raw.actions[0], confidence: 2 }] })).toThrow(/confidence/);
  });
});

describe('candidate merging', () => {
  const actions = parseStructuredDetection({
    batchSummary: 'SEO',
    actions: [{
      actionType: 'seo_metadata', summary: '修改 title', affectedTargets: ['/games/*'],
      requiresEvaluation: true, template: 'seo', confidence: 0.9,
      productionState: 'not_deployed', reason: '需要观察',
    }],
  }).actions;

  it('merges continuous candidates in the same project and target', () => {
    const first = createCandidate({ context: context(), actions, id: 'candidate-1' });
    expect(createCandidate({ context: context(), actions }).id).toBe(createCandidate({ context: context(), actions }).id);
    const second = createCandidate({
      context: context({
        turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', text: '继续调整 canonical' }] },
        completedAt: '2026-08-09T00:00:00.000Z',
        git: { baseCommit: 'bbb', headCommit: 'ccc', changedFiles: ['src/metadata.ts'] },
      }),
      actions: [{ ...actions[0], summary: '调整 canonical' }],
      id: 'candidate-2',
    });
    expect(canMergeCandidate(first, second)).toBe(true);
    expect(mergeCandidates(first, second)).toMatchObject({
      id: 'candidate-1',
      currentCommit: 'ccc',
      actionSummaries: ['修改 title', '调整 canonical'],
      confidence: 0.9,
    });
  });

  it('does not merge candidates from different projects', () => {
    const first = createCandidate({ context: context(), actions, id: 'candidate-1' });
    const other = createCandidate({ context: { ...context(), projectId: 'other-project' }, actions, id: 'candidate-2' });
    expect(canMergeCandidate(first, other)).toBe(false);
  });
});
