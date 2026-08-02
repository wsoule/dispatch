import type { FixLoopState } from '@dispatch/client';
import type { EscalationStep } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  fixLoopNeedsRuling,
  fixLoopStatusLabel,
  willEscalateNextRound,
} from './fixLoopStatus';

function state(overrides: Partial<FixLoopState>): FixLoopState {
  return {
    taskId: 't-1',
    round: 1,
    cap: 5,
    state: 'implementing',
    baseSha: 'abc123',
    lastReviewedSha: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('fixLoopStatusLabel', () => {
  test('labels every state', () => {
    expect(fixLoopStatusLabel(state({ state: 'idle', round: 0 }))).toBe(
      'Not started'
    );
    expect(
      fixLoopStatusLabel(state({ state: 'implementing', round: 2, cap: 5 }))
    ).toBe('Round 2/5 · Implementing');
    expect(
      fixLoopStatusLabel(state({ state: 'reviewing', round: 2, cap: 5 }))
    ).toBe('Round 2/5 · Reviewing');
    expect(
      fixLoopStatusLabel(state({ state: 'capped', round: 5, cap: 5 }))
    ).toBe('Capped at 5/5 — needs a ruling');
    expect(fixLoopStatusLabel(state({ state: 'complete' }))).toBe('Complete');
  });
});

describe('fixLoopNeedsRuling', () => {
  test('true only for a capped loop', () => {
    expect(fixLoopNeedsRuling(null)).toBe(false);
    expect(fixLoopNeedsRuling(state({ state: 'implementing' }))).toBe(false);
    expect(fixLoopNeedsRuling(state({ state: 'capped' }))).toBe(true);
  });
});

describe('willEscalateNextRound', () => {
  const escalation: EscalationStep[] = [
    { round: 1, strategy: 'resume', modelTier: 'standard' },
    { round: 4, strategy: 'fresh', modelTier: 'high' },
  ];

  test('resumes below the escalation rung', () => {
    expect(willEscalateNextRound(state({ round: 1 }), escalation)).toBe(false);
    expect(willEscalateNextRound(state({ round: 2 }), escalation)).toBe(false);
  });

  test('escalates once the next round reaches the fresh rung', () => {
    expect(willEscalateNextRound(state({ round: 3 }), escalation)).toBe(true);
    expect(willEscalateNextRound(state({ round: 4 }), escalation)).toBe(true);
  });

  test('an empty table never escalates', () => {
    expect(willEscalateNextRound(state({ round: 9 }), [])).toBe(false);
  });

  test('never escalates once round has reached cap — openRound caps the loop there instead of dispatching a next round', () => {
    // Same rung table as above, so a naive "would round 6 be fresh" check
    // would say yes; there is no round 6, the loop stops at round 5.
    expect(willEscalateNextRound(state({ round: 5, cap: 5 }), escalation)).toBe(
      false
    );
  });

  test('never escalates a capped or complete loop, even with round < cap', () => {
    // A blocking ruling can cap a loop before round hits cap (fixLoop.ts's
    // canSettle branch) — round 3 would otherwise read rung 4 as upcoming.
    expect(
      willEscalateNextRound(
        state({ round: 3, cap: 5, state: 'capped' }),
        escalation
      )
    ).toBe(false);
    expect(
      willEscalateNextRound(
        state({ round: 3, cap: 5, state: 'complete' }),
        escalation
      )
    ).toBe(false);
  });
});
