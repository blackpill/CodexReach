import { describe, expect, it } from 'vitest';
import { assertCandidateTransition, assertDraftTransition, assertNodeTransition } from './state-machine.js';

describe('evaluation state machine', () => {
  it('allows the expected happy-path transitions', () => {
    expect(() => assertCandidateTransition('candidate', 'deployed')).not.toThrow();
    expect(() => assertDraftTransition('draft_pending', 'confirmed')).not.toThrow();
    expect(() => assertNodeTransition('scheduled', 'waiting_confirmation')).not.toThrow();
    expect(() => assertNodeTransition('waiting_confirmation', 'running')).not.toThrow();
    expect(() => assertNodeTransition('running', 'completed')).not.toThrow();
  });

  it('rejects terminal and skipped transitions', () => {
    expect(() => assertCandidateTransition('deployed', 'candidate')).toThrow(/Invalid candidate transition/);
    expect(() => assertDraftTransition('confirmed', 'draft_pending')).toThrow(/Invalid draft transition/);
    expect(() => assertNodeTransition('scheduled', 'completed')).toThrow(/Invalid evaluation node transition/);
    expect(() => assertNodeTransition('completed', 'running')).toThrow(/Invalid evaluation node transition/);
  });
});
