import type { FixLoopState } from '@dispatch/client';
import type { EscalationStep } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  fixLoopCappedNotice,
  fixLoopNeedsRuling,
  fixLoopStatusLabel,
  fixLoopStopDetail,
  fixLoopTone,
  fixLoopTraceLabel,
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
    ).toBe('Capped at 5/5: needs a ruling');
    expect(fixLoopStatusLabel(state({ state: 'complete' }))).toBe('Complete');
  });

  test('a capped loop says why it stopped, not just that it stopped', () => {
    expect(
      fixLoopStatusLabel(
        state({
          state: 'capped',
          round: 2,
          cap: 5,
          stopReason: 'standing-block',
        })
      )
    ).toBe('Stopped at 2/5: held by a blocking ruling');
    expect(
      fixLoopStatusLabel(
        state({ state: 'capped', round: 3, cap: 5, stopReason: 'error' })
      )
    ).toBe('Stopped at 3/5: the loop failed');
    expect(
      fixLoopStatusLabel(
        state({
          state: 'capped',
          round: 5,
          cap: 5,
          stopReason: 'rounds-exhausted',
        })
      )
    ).toBe('Capped at 5/5: needs a ruling');
  });
});

describe('fixLoopNeedsRuling', () => {
  test('true only for a capped loop', () => {
    expect(fixLoopNeedsRuling(null)).toBe(false);
    expect(fixLoopNeedsRuling(state({ state: 'implementing' }))).toBe(false);
    expect(fixLoopNeedsRuling(state({ state: 'capped' }))).toBe(true);
  });

  test('a loop held by a blocking ruling has nothing left to rule on', () => {
    // Every finding was already adjudicated: the CTA would sit there with no
    // findings beneath it and no way to dismiss it.
    expect(
      fixLoopNeedsRuling(
        state({ state: 'capped', stopReason: 'standing-block' })
      )
    ).toBe(false);
  });

  test('an errored loop needs a report, not a verdict', () => {
    expect(
      fixLoopNeedsRuling(state({ state: 'capped', stopReason: 'error' }))
    ).toBe(false);
  });

  test('a loop capped before stopReason existed still asks for a ruling', () => {
    // The server falls back to rounds-exhausted when it cannot name a reason,
    // so an older persisted row must read the same way.
    expect(
      fixLoopNeedsRuling(state({ state: 'capped', stopReason: undefined }))
    ).toBe(true);
  });
});

describe('fixLoopTone', () => {
  test('only a loop waiting on the user gets the amber treatment', () => {
    expect(fixLoopTone(state({ state: 'implementing' }))).toBe('neutral');
    expect(fixLoopTone(state({ state: 'complete' }))).toBe('neutral');
    expect(fixLoopTone(state({ state: 'capped' }))).toBe('waiting');
    expect(
      fixLoopTone(state({ state: 'capped', stopReason: 'rounds-exhausted' }))
    ).toBe('waiting');
    expect(
      fixLoopTone(state({ state: 'capped', stopReason: 'standing-block' }))
    ).toBe('neutral');
    expect(fixLoopTone(state({ state: 'capped', stopReason: 'error' }))).toBe(
      'failed'
    );
  });
});

describe('fixLoopStopDetail', () => {
  test('surfaces the failure text, and only for an errored loop', () => {
    expect(
      fixLoopStopDetail(
        state({
          state: 'capped',
          stopReason: 'error',
          stopDetail: 'git failed',
        })
      )
    ).toBe('git failed');
    expect(
      fixLoopStopDetail(
        state({ state: 'capped', stopReason: 'error', stopDetail: '  ' })
      )
    ).toBeNull();
    expect(
      fixLoopStopDetail(state({ state: 'capped', stopReason: 'error' }))
    ).toBeNull();
    expect(
      fixLoopStopDetail(
        state({
          state: 'capped',
          stopReason: 'standing-block',
          stopDetail: 'ignored',
        })
      )
    ).toBeNull();
    expect(
      fixLoopStopDetail(state({ state: 'reviewing', stopDetail: 'ignored' }))
    ).toBeNull();
  });
});

describe('fixLoopCappedNotice', () => {
  test('a durable row never asks for a ruling that was already given', () => {
    expect(fixLoopCappedNotice('Ship it', 'rounds-exhausted')).toEqual({
      title: 'Fix loop capped',
      body: 'Ship it needs a ruling on its open findings.',
    });
    expect(fixLoopCappedNotice('Ship it', 'standing-block')).toEqual({
      title: 'Fix loop stopped',
      body: 'Ship it is held by a blocking ruling.',
    });
  });

  test('an error carries its message when there is one', () => {
    expect(
      fixLoopCappedNotice('Ship it', 'error', 'worktree vanished')
    ).toEqual({ title: 'Fix loop failed', body: 'Ship it: worktree vanished' });
    expect(fixLoopCappedNotice('Ship it', 'error')).toEqual({
      title: 'Fix loop failed',
      body: "Ship it's fix loop stopped on an error.",
    });
    expect(fixLoopCappedNotice('Ship it', 'error', '   ')).toEqual({
      title: 'Fix loop failed',
      body: "Ship it's fix loop stopped on an error.",
    });
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

describe('fixLoopTraceLabel', () => {
  const base = {
    taskId: 't-1',
    round: 2,
    cap: 5,
    state: 'reviewing',
    baseSha: 'abc',
    lastReviewedSha: null,
    updatedAt: '',
  } as const;

  test('joins the per-pass counts with arrows', () => {
    expect(fixLoopTraceLabel({ ...base, findingsTrace: [9, 4, 1] })).toBe(
      '9→4→1'
    );
  });

  test('a single reviewed round still reads as information', () => {
    expect(fixLoopTraceLabel({ ...base, findingsTrace: [9] })).toBe('9');
  });

  test('no reviewed rounds yields nothing', () => {
    expect(fixLoopTraceLabel({ ...base, findingsTrace: [] })).toBeNull();
    expect(fixLoopTraceLabel({ ...base })).toBeNull();
  });
});
