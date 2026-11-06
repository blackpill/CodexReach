import { describe, it, expect } from 'vitest';
import { decideNext } from './supervisor.js';

describe('supervisor decisions', () => {
  it('does not treat completed turns as completed issues', () => {
    expect(
      decideNext({ stage: 'DEVELOPING', turn: 'completed', failures: 0, noProgress: 0 }),
    ).toEqual({ stage: 'VALIDATING' });
  });
  it('stops repeated failures or no progress', () => {
    expect(
      decideNext({ stage: 'VALIDATING', validation: 'failed', failures: 3, noProgress: 0 }).stage,
    ).toBe('BLOCKED');
    expect(
      decideNext({ stage: 'VALIDATING', validation: 'failed', failures: 1, noProgress: 2 }).stage,
    ).toBe('BLOCKED');
    expect(
      decideNext({ stage: 'VALIDATING', validation: 'failed', failures: 1, noProgress: 0 }).stage,
    ).toBe('DEVELOPING');
  });
  it('requires all configured CI checks successful on current sha', () => {
    const state = {
      stage: 'CI_CHECKING' as const,
      headSha: 'new',
      checkedSha: 'new',
      required: ['verify'],
      checks: { verify: 'success' },
      failures: 0,
      noProgress: 0,
    };
    expect(decideNext(state).stage).toBe('PR_READY');
    expect(decideNext({ ...state, checkedSha: 'old' }).stage).toBe('CI_CHECKING');
    expect(decideNext({ ...state, checks: { verify: 'skipped' } }).stage).toBe('BLOCKED');
    expect(decideNext({ ...state, required: [] }).stage).toBe('BLOCKED');
    expect(decideNext({ ...state, checks: {} }).stage).toBe('CI_CHECKING');
  });
});
