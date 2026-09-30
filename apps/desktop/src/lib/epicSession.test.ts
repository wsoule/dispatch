import type {
  EpicChildPhase,
  EpicProgressChild,
  EpicSpend,
  EpicWave,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { EpicPausedEvent } from './epicSession';
import {
  defaultMaxRuns,
  defaultSpendCeiling,
  drillTargetFor,
  epicPausedNotice,
  formatUsd,
  pausedReasonLabel,
  PHASE_CHIP_ORDER,
  PHASE_LABEL,
  phaseCounts,
  phaseTint,
  rulingsWaiting,
  showsPhasePill,
  spendPillLabel,
  spendTitle,
  spendTone,
  waveSteps,
} from './epicSession';

const ALL_PHASES: EpicChildPhase[] = [
  'draft',
  'waiting',
  'queued',
  'held',
  'working',
  'reviewing',
  'fixing',
  'needs-review',
  'capped',
  'failed',
  'blocked',
  'landing',
  'landed',
  'dropped',
];

function child(
  phase: EpicChildPhase,
  overrides: Partial<EpicProgressChild> = {}
): EpicProgressChild {
  return {
    id: `t-${phase}`,
    title: phase,
    status: 'todo',
    phase,
    wave: 1,
    openFindings: 0,
    ...overrides,
  };
}

function spend(overrides: Partial<EpicSpend> = {}): EpicSpend {
  return {
    settledUsd: 41.2,
    liveCount: 3,
    estimatedLiveUsd: 30,
    runsStarted: 7,
    maxSpendUsd: 60,
    maxRuns: 20,
    ...overrides,
  };
}

function wave(
  index: number,
  byPhase: Partial<Record<EpicChildPhase, number>>
): EpicWave {
  const total = Object.values(byPhase).reduce((sum, n) => sum + n, 0);
  return { index, total, byPhase };
}

function paused(overrides: Partial<EpicPausedEvent> = {}): EpicPausedEvent {
  return {
    type: 'epic.paused',
    epicId: 'e-1',
    reason: 'budget',
    settledUsd: 41.2,
    estimatedLiveUsd: 30,
    maxSpendUsd: 60,
    runsStarted: 7,
    maxRuns: 20,
    ...overrides,
  };
}

describe('PHASE_LABEL', () => {
  test('names every phase in sentence case', () => {
    for (const phase of ALL_PHASES) {
      expect(PHASE_LABEL[phase]).toMatch(/^[A-Z][a-z]+( [a-z]+)?$/);
    }
    expect(PHASE_LABEL).toEqual({
      draft: 'Draft',
      waiting: 'Waiting',
      queued: 'Queued',
      held: 'Held',
      working: 'Working',
      reviewing: 'Reviewing',
      fixing: 'Fixing',
      'needs-review': 'Needs review',
      capped: 'Capped',
      failed: 'Failed',
      blocked: 'Blocked',
      landing: 'Landing',
      landed: 'Landed',
      dropped: 'Dropped',
    });
  });
});

describe('phaseTint', () => {
  test('groups the phases onto the state tokens', () => {
    expect(phaseTint('working')).toBe('var(--state-working-fg)');
    expect(phaseTint('reviewing')).toBe('var(--state-working-fg)');
    expect(phaseTint('fixing')).toBe('var(--state-working-fg)');
    expect(phaseTint('capped')).toBe('var(--state-waiting-fg)');
    expect(phaseTint('held')).toBe('var(--state-waiting-fg)');
    expect(phaseTint('waiting')).toBe('var(--state-waiting-fg)');
    expect(phaseTint('failed')).toBe('var(--state-failed-fg)');
    expect(phaseTint('blocked')).toBe('var(--state-failed-fg)');
    expect(phaseTint('needs-review')).toBe('var(--state-review-fg)');
    expect(phaseTint('landing')).toBe('var(--state-landing-fg)');
  });

  test('leaves the glyph-only phases untinted', () => {
    for (const phase of ['draft', 'queued', 'landed', 'dropped'] as const) {
      expect(phaseTint(phase)).toBeNull();
    }
  });
});

describe('phase chips', () => {
  test('the chip order is the seven header phases, running first', () => {
    expect(PHASE_CHIP_ORDER).toEqual([
      'working',
      'reviewing',
      'fixing',
      'queued',
      'blocked',
      'capped',
      'failed',
    ]);
  });

  test('phaseCounts tallies every phase, zeros included', () => {
    const counts = phaseCounts([
      child('working', { id: 'a' }),
      child('working', { id: 'b' }),
      child('capped', { id: 'c' }),
      child('landed', { id: 'd' }),
    ]);
    expect(counts.working).toBe(2);
    expect(counts.capped).toBe(1);
    expect(counts.landed).toBe(1);
    expect(counts.failed).toBe(0);
    expect(Object.keys(counts).sort()).toEqual([...ALL_PHASES].sort());
    expect(PHASE_CHIP_ORDER.filter((p) => counts[p] > 0)).toEqual([
      'working',
      'capped',
    ]);
  });

  test('phaseCounts of nothing is all zeros', () => {
    const counts = phaseCounts([]);
    for (const phase of ALL_PHASES) expect(counts[phase]).toBe(0);
  });
});

describe('showsPhasePill', () => {
  test('is true for exactly the eight phases a row pill adds to', () => {
    const shown = ALL_PHASES.filter(showsPhasePill).sort();
    const expected: EpicChildPhase[] = [
      'working',
      'reviewing',
      'fixing',
      'capped',
      'failed',
      'blocked',
      'held',
      'waiting',
    ];
    expect(shown).toEqual(expected.sort());
  });
});

describe('formatUsd', () => {
  test('drops the cents on whole dollars and groups thousands', () => {
    expect(formatUsd(41.2)).toBe('$41.20');
    expect(formatUsd(1300)).toBe('$1,300');
    expect(formatUsd(60)).toBe('$60');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(8.2)).toBe('$8.20');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  test('rounds float sums to cents first', () => {
    expect(formatUsd(41.199999)).toBe('$41.20');
    expect(formatUsd(60.000001)).toBe('$60');
  });
});

describe('spend copy', () => {
  test('spendPillLabel shows the ceiling when there is one', () => {
    expect(spendPillLabel(spend())).toBe('$41.20 / $60');
    expect(spendPillLabel(spend({ maxSpendUsd: null }))).toBe('$41.20');
    expect(spendPillLabel(spend({ settledUsd: 0, maxSpendUsd: 1300 }))).toBe(
      '$0 / $1,300'
    );
  });

  test('spendTitle reads in-flight estimate and run count', () => {
    expect(spendTitle(spend())).toBe('+~$30.00 in flight · 7/20 runs');
    expect(spendTitle(spend({ maxRuns: null }))).toBe(
      '+~$30.00 in flight · 7 runs'
    );
    expect(spendTitle(spend({ maxRuns: null, runsStarted: 1 }))).toBe(
      '+~$30.00 in flight · 1 run'
    );
    expect(spendTitle(spend({ liveCount: 0, estimatedLiveUsd: 0 }))).toBe(
      '7/20 runs'
    );
  });

  test('spendTone flips to warning from 80 % of the ceiling', () => {
    expect(spendTone(spend({ settledUsd: 10, estimatedLiveUsd: 0 }))).toBe(
      'working'
    );
    expect(spendTone(spend({ settledUsd: 47.99, estimatedLiveUsd: 0 }))).toBe(
      'working'
    );
    expect(spendTone(spend({ settledUsd: 48, estimatedLiveUsd: 0 }))).toBe(
      'warning'
    );
    // The in-flight estimate counts: that is what the gate charges.
    expect(spendTone(spend({ settledUsd: 30, estimatedLiveUsd: 20 }))).toBe(
      'warning'
    );
    expect(spendTone(spend({ settledUsd: 30, estimatedLiveUsd: 10 }))).toBe(
      'working'
    );
  });

  test('spendTone never warns without a ceiling', () => {
    expect(spendTone(spend({ settledUsd: 9999, maxSpendUsd: null }))).toBe(
      'working'
    );
  });
});

describe('pausedReasonLabel', () => {
  test('names every reason', () => {
    expect(pausedReasonLabel('budget')).toBe('Paused — budget ceiling');
    expect(pausedReasonLabel('runs')).toBe('Paused — run ceiling');
    expect(pausedReasonLabel('human')).toBe('Paused — by you');
    expect(pausedReasonLabel('fill-failed')).toBe(
      'Paused — auto-dispatch failed'
    );
  });
});

describe('rulingsWaiting', () => {
  test('counts the capped children only', () => {
    expect(
      rulingsWaiting([
        child('capped', { id: 'a' }),
        child('capped', { id: 'b' }),
        child('failed', { id: 'c' }),
        child('working', { id: 'd' }),
      ])
    ).toBe(2);
    expect(rulingsWaiting([])).toBe(0);
  });
});

describe('dialog defaults', () => {
  test('defaultSpendCeiling is tasks × estimate, clamped and rounded up', () => {
    expect(defaultSpendCeiling(3, 10)).toBe(30);
    expect(defaultSpendCeiling(7, 5)).toBe(40);
    expect(defaultSpendCeiling(1, 12.5)).toBe(20);
    expect(defaultSpendCeiling(0, 10)).toBe(10);
    expect(defaultSpendCeiling(1, 1)).toBe(10);
    expect(defaultSpendCeiling(100, 10)).toBe(200);
    expect(defaultSpendCeiling(20, 10)).toBe(200);
  });

  test('defaultMaxRuns is one run per task', () => {
    expect(defaultMaxRuns(12)).toBe(12);
    expect(defaultMaxRuns(1)).toBe(1);
  });
});

describe('epicPausedNotice', () => {
  test('budget carries the numbers the gate stopped on', () => {
    const notice = epicPausedNotice('Auth rewrite', paused());
    expect(notice.title).toBe('Auth rewrite paused — spend ceiling');
    expect(notice.body).toBe(
      '$41.20 settled + ~$30.00 in flight of $60.00. Resume or raise the ceiling to continue.'
    );
  });

  test('budget omits the halves it has no number for', () => {
    const notice = epicPausedNotice(
      'Auth rewrite',
      paused({ estimatedLiveUsd: 0, maxSpendUsd: null })
    );
    expect(notice.body).toBe(
      '$41.20 settled. Resume or raise the ceiling to continue.'
    );
  });

  test('runs reads started over ceiling', () => {
    const notice = epicPausedNotice(
      'Auth rewrite',
      paused({ reason: 'runs', runsStarted: 20 })
    );
    expect(notice.title).toBe('Auth rewrite paused — run ceiling');
    expect(notice.body).toBe(
      '20/20 runs started. Resume or raise the ceiling to continue.'
    );
    expect(
      epicPausedNotice('E', paused({ reason: 'runs', maxRuns: null })).body
    ).toBe('7 runs started. Resume or raise the ceiling to continue.');
  });

  test('fill-failed carries the detail when there is one', () => {
    expect(
      epicPausedNotice(
        'Auth rewrite',
        paused({ reason: 'fill-failed', detail: ' git worktree add failed ' })
      )
    ).toEqual({
      title: 'Auth rewrite paused — auto-dispatch failed',
      body: 'git worktree add failed. Resume to try again.',
    });
    expect(
      epicPausedNotice('Auth rewrite', paused({ reason: 'fill-failed' })).body
    ).toBe('Auto-dispatch kept failing. Resume to try again.');
  });

  test('human names the person', () => {
    expect(
      epicPausedNotice('Auth rewrite', paused({ reason: 'human' }))
    ).toEqual({
      title: 'Auth rewrite paused',
      body: 'Paused by you. Resume to keep dispatching.',
    });
  });
});

describe('waveSteps', () => {
  test('one segment per wave, named by index', () => {
    const steps = waveSteps([
      wave(1, { landed: 3 }),
      wave(2, { working: 1, queued: 1 }),
      wave(3, { waiting: 2 }),
    ]);
    expect(steps).toEqual([
      { name: 'Wave 1', status: 'passed' },
      { name: 'Wave 2', status: 'active' },
      { name: 'Wave 3', status: 'pending' },
    ]);
  });

  test('passed needs every child past reviewing', () => {
    expect(waveSteps([wave(1, { landed: 2, 'needs-review': 1 })])).toEqual([
      { name: 'Wave 1', status: 'passed' },
    ]);
    expect(waveSteps([wave(1, { landing: 1, dropped: 1 })])).toEqual([
      { name: 'Wave 1', status: 'passed' },
    ]);
    expect(waveSteps([wave(1, { landed: 2, capped: 1 })])).toEqual([
      { name: 'Wave 1', status: 'pending' },
    ]);
    expect(waveSteps([wave(1, {})])).toEqual([
      { name: 'Wave 1', status: 'pending' },
    ]);
  });

  test('a failure outranks activity in the same wave', () => {
    expect(waveSteps([wave(1, { working: 4, failed: 1 })])).toEqual([
      { name: 'Wave 1', status: 'failed' },
    ]);
    expect(waveSteps([wave(1, { landed: 4, blocked: 1 })])).toEqual([
      { name: 'Wave 1', status: 'failed' },
    ]);
  });

  test('reviewing and fixing keep a wave active', () => {
    expect(waveSteps([wave(1, { landed: 1, reviewing: 1 })])).toEqual([
      { name: 'Wave 1', status: 'active' },
    ]);
    expect(waveSteps([wave(1, { fixing: 1 })])).toEqual([
      { name: 'Wave 1', status: 'active' },
    ]);
  });
});

describe('drillTargetFor', () => {
  test('a failed child opens its run transcript', () => {
    expect(drillTargetFor(child('failed', { runId: 'r-9' }))).toEqual({
      tab: 'run',
      runId: 'r-9',
    });
    expect(drillTargetFor(child('failed'))).toEqual({ tab: 'run' });
  });

  test('everything else opens the page on its state', () => {
    expect(drillTargetFor(child('capped', { runId: 'r-1' }))).toEqual({
      tab: 'auto',
    });
    expect(drillTargetFor(child('held'))).toEqual({ tab: 'auto' });
    expect(drillTargetFor(child('working', { runId: 'r-2' }))).toEqual({
      tab: 'auto',
    });
  });
});
