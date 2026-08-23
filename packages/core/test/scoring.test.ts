import { describe, expect, it } from 'bun:test';

import type { QueueWeights, ScoreFactorKey } from '../src/scoring.js';
import {
  AGE_HORIZON_DAYS,
  DEFAULT_QUEUE_WEIGHTS,
  QUEUE_FACTOR_KEYS,
  QUEUE_FACTORS,
  rankTasks,
  UNBLOCKING_HALF_VALUE,
} from '../src/scoring.js';
import type { TaskDoc, TaskMeta } from '../src/types.js';

const NOW = '2026-03-01T00:00:00.000Z';

function make(partial: Partial<TaskMeta>): TaskDoc {
  return {
    meta: {
      id: 't-000000',
      title: 'x',
      status: 'todo',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: NOW,
      updated: NOW,
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...partial,
    },
    body: '',
  };
}

// Days before NOW, as an ISO string, so an age-sensitive case reads as its age.
function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

// Only one factor's weight is non-zero, so a case can assert on that factor's
// contribution without the other two moving the total.
function only(key: ScoreFactorKey): QueueWeights {
  const weights = {} as QueueWeights;
  for (const factor of QUEUE_FACTOR_KEYS) weights[factor] = 0;
  weights[key] = 1;
  return weights;
}

describe('rankTasks candidate set', () => {
  it('scores exactly the ready tasks: todo, kind=task, blockers done', () => {
    const blocker = make({ id: 't-aaaaaa', status: 'in-progress' });
    const blocked = make({ id: 't-bbbbbb', blockedBy: ['t-aaaaaa'] });
    const free = make({ id: 't-cccccc' });
    const epic = make({ id: 'e-dddddd', kind: 'epic' });
    const backlog = make({ id: 't-eeeeee', status: 'backlog' });

    const ranked = rankTasks([blocker, blocked, free, epic, backlog], {
      weights: DEFAULT_QUEUE_WEIGHTS,
      now: NOW,
    });

    expect(ranked.map((entry) => entry.task.meta.id)).toEqual(['t-cccccc']);
  });

  // The queue exists to be pulled from, so it must show exactly what the
  // orchestrator would agree to start. A blocker in review is dispatch-
  // satisfied; ranking with readyTasks instead would hide startable work from
  // the one surface whose job is to surface it.
  it('includes a task whose blocker is in review, matching dispatch', () => {
    const inReview = make({ id: 't-aaaaaa', status: 'in-review' });
    const dependent = make({ id: 't-bbbbbb', blockedBy: ['t-aaaaaa'] });

    const ranked = rankTasks([inReview, dependent], {
      weights: DEFAULT_QUEUE_WEIGHTS,
      now: NOW,
    });

    expect(ranked.map((entry) => entry.task.meta.id)).toEqual(['t-bbbbbb']);
  });

  it('returns an empty ranking when nothing is ready', () => {
    expect(
      rankTasks([make({ status: 'done' })], {
        weights: DEFAULT_QUEUE_WEIGHTS,
        now: NOW,
      })
    ).toEqual([]);
  });
});

describe('urgency factor', () => {
  it('maps priority onto 0..1 with urgent at the top and none at the floor', () => {
    const byPriority = ['urgent', 'high', 'medium', 'low', 'none'] as const;
    const tasks = byPriority.map((priority, index) =>
      make({ id: `t-00000${index}`, priority })
    );

    const ranked = rankTasks(tasks, { weights: only('urgency'), now: NOW });

    expect(ranked.map((entry) => entry.score)).toEqual([1, 0.75, 0.5, 0.25, 0]);
    expect(ranked.map((entry) => entry.task.meta.priority)).toEqual([
      ...byPriority,
    ]);
  });

  it('names the priority in the factor detail', () => {
    const [entry] = rankTasks([make({ priority: 'high' })], {
      weights: only('urgency'),
      now: NOW,
    });
    const urgency = entry?.factors.find((f) => f.key === 'urgency');
    expect(urgency?.detail).toBe('priority: high');
  });
});

describe('unblocking factor', () => {
  it('counts transitive dependents, not just direct ones', () => {
    // t-aaaaaa <- t-bbbbbb <- t-cccccc: finishing the root frees two tasks.
    const root = make({ id: 't-aaaaaa' });
    const mid = make({ id: 't-bbbbbb', blockedBy: ['t-aaaaaa'] });
    const leaf = make({ id: 't-cccccc', blockedBy: ['t-bbbbbb'] });
    const lone = make({ id: 't-dddddd' });

    const ranked = rankTasks([root, mid, leaf, lone], {
      weights: only('unblocking'),
      now: NOW,
    });

    const rootEntry = ranked.find((e) => e.task.meta.id === 't-aaaaaa');
    const unblocking = rootEntry?.factors.find((f) => f.key === 'unblocking');
    expect(unblocking?.detail).toBe('unblocks 1 of 2 downstream tasks');
    expect(rootEntry?.score).toBeCloseTo(2 / (2 + UNBLOCKING_HALF_VALUE), 10);
  });

  it('ignores dependents that are already done or cancelled', () => {
    const root = make({ id: 't-aaaaaa' });
    const finished = make({
      id: 't-bbbbbb',
      status: 'done',
      blockedBy: ['t-aaaaaa'],
    });
    const dropped = make({
      id: 't-cccccc',
      status: 'cancelled',
      blockedBy: ['t-aaaaaa'],
    });

    const [entry] = rankTasks([root, finished, dropped], {
      weights: only('unblocking'),
      now: NOW,
    });

    expect(entry?.score).toBe(0);
    expect(entry?.factors.find((f) => f.key === 'unblocking')?.detail).toBe(
      'unblocks nothing'
    );
  });

  it('terminates on a dependency cycle instead of recursing forever', () => {
    // A cycle is invalid (doctor reports it) but must never hang the queue.
    const a = make({ id: 't-aaaaaa', blockedBy: ['t-cccccc'] });
    const b = make({ id: 't-bbbbbb', blockedBy: ['t-aaaaaa'] });
    const c = make({ id: 't-cccccc', blockedBy: ['t-bbbbbb'] });
    const free = make({ id: 't-dddddd' });

    const ranked = rankTasks([a, b, c, free], {
      weights: only('unblocking'),
      now: NOW,
    });

    // None of the cycle members are ready (each has an unfinished blocker),
    // so only the free task ranks — and the walk still returned.
    expect(ranked.map((e) => e.task.meta.id)).toEqual(['t-dddddd']);
  });

  // A diamond reaches the same dependent by two paths; it is still one task
  // freed, so the transitive count must not double it.
  it('counts a dependent reachable by two paths only once', () => {
    const root = make({ id: 't-aaaaaa' });
    const mid = make({ id: 't-bbbbbb', blockedBy: ['t-aaaaaa'] });
    const join = make({ id: 't-cccccc', blockedBy: ['t-bbbbbb', 't-aaaaaa'] });

    const [entry] = rankTasks([root, mid, join], {
      weights: only('unblocking'),
      now: NOW,
    });

    expect(entry?.factors.find((f) => f.key === 'unblocking')?.detail).toBe(
      'unblocks 1 of 2 downstream tasks'
    );
  });

  it('does not let a repeated blockedBy entry inflate the direct count', () => {
    const root = make({ id: 't-aaaaaa' });
    const dupe = make({ id: 't-bbbbbb', blockedBy: ['t-aaaaaa', 't-aaaaaa'] });

    const [entry] = rankTasks([root, dupe], {
      weights: only('unblocking'),
      now: NOW,
    });

    expect(entry?.factors.find((f) => f.key === 'unblocking')?.detail).toBe(
      'unblocks 1 of 1 downstream task'
    );
  });
  // An epic is a container the orchestrator never starts, and a derived task
  // only anchors a review of someone else's artifact. Counting either as freed
  // work inflates a blocker with tasks nobody will ever be handed.
  it('does not count epics or derived tasks as freed work', () => {
    const root = make({ id: 't-aaaaaa' });
    const epic = make({
      id: 'e-bbbbbb',
      kind: 'epic',
      blockedBy: ['t-aaaaaa'],
    });
    const derived = make({
      id: 't-cccccc',
      derivedFrom: 'github-pr:7',
      blockedBy: ['t-aaaaaa'],
    });

    const [entry] = rankTasks([root, epic, derived], {
      weights: only('unblocking'),
      now: NOW,
    });

    expect(entry?.score).toBe(0);
    expect(entry?.factors.find((f) => f.key === 'unblocking')?.detail).toBe(
      'unblocks nothing'
    );
  });

  // Without this, all three blockers below claim to "unblock 1 task" about the
  // same dependent, when finishing any one of them releases nothing.
  it('only credits a release to the last blocker standing', () => {
    const a = make({ id: 't-aaaaaa' });
    const b = make({ id: 't-bbbbbb' });
    const c = make({ id: 't-cccccc' });
    const shared = make({
      id: 't-dddddd',
      blockedBy: ['t-aaaaaa', 't-bbbbbb', 't-cccccc'],
    });

    const ranked = rankTasks([a, b, c, shared], {
      weights: only('unblocking'),
      now: NOW,
    });

    for (const entry of ranked) {
      expect(entry.factors.find((f) => f.key === 'unblocking')?.detail).toBe(
        'unblocks 0 of 1 downstream task'
      );
    }
  });

  it('credits the release once the other blockers are satisfied', () => {
    const last = make({ id: 't-aaaaaa' });
    const merged = make({ id: 't-bbbbbb', status: 'done' });
    // in-review counts as satisfied for dispatch, so it is not holding
    // t-dddddd back either.
    const inReview = make({ id: 't-cccccc', status: 'in-review' });
    const shared = make({
      id: 't-dddddd',
      blockedBy: ['t-aaaaaa', 't-bbbbbb', 't-cccccc'],
    });

    const [entry] = rankTasks([last, merged, inReview, shared], {
      weights: only('unblocking'),
      now: NOW,
    });

    expect(entry?.task.meta.id).toBe('t-aaaaaa');
    expect(entry?.factors.find((f) => f.key === 'unblocking')?.detail).toBe(
      'unblocks 1 of 1 downstream task'
    );
  });

  // A dangling blockedBy id is treated as satisfied by readyTasks, so it must
  // not count as something holding the dependent back either.
  it('treats a dangling blocker as already satisfied', () => {
    const real = make({ id: 't-aaaaaa' });
    const dependent = make({
      id: 't-bbbbbb',
      blockedBy: ['t-aaaaaa', 't-ghost0'],
    });

    const [entry] = rankTasks([real, dependent], {
      weights: only('unblocking'),
      now: NOW,
    });

    expect(entry?.factors.find((f) => f.key === 'unblocking')?.detail).toBe(
      'unblocks 1 of 1 downstream task'
    );
  });
});

describe('age factor', () => {
  it('ramps linearly to the horizon and pins there', () => {
    const fresh = make({ id: 't-aaaaaa', created: NOW });
    const half = make({
      id: 't-bbbbbb',
      created: daysAgo(AGE_HORIZON_DAYS / 2),
    });
    const old = make({
      id: 't-cccccc',
      created: daysAgo(AGE_HORIZON_DAYS * 4),
    });

    const ranked = rankTasks([fresh, half, old], {
      weights: only('age'),
      now: NOW,
    });

    expect(ranked.map((e) => e.task.meta.id)).toEqual([
      't-cccccc',
      't-bbbbbb',
      't-aaaaaa',
    ]);
    expect(ranked.map((e) => e.score)).toEqual([1, 0.5, 0]);
  });

  it('treats an unparseable created stamp as brand new rather than NaN', () => {
    const [entry] = rankTasks([make({ created: 'not-a-date' })], {
      weights: only('age'),
      now: NOW,
    });
    expect(entry?.score).toBe(0);
    expect(entry?.factors.find((f) => f.key === 'age')?.detail).toBe(
      'age unknown'
    );
  });

  it('clamps a created stamp in the future to zero age', () => {
    const [entry] = rankTasks([make({ created: daysAgo(-10) })], {
      weights: only('age'),
      now: NOW,
    });
    expect(entry?.score).toBe(0);
  });
});

describe('weighting and the breakdown', () => {
  it('normalizes the score so contributions sum to it', () => {
    const root = make({
      id: 't-aaaaaa',
      priority: 'high',
      created: daysAgo(15),
    });
    const dependent = make({ id: 't-bbbbbb', blockedBy: ['t-aaaaaa'] });

    const [entry] = rankTasks([root, dependent], {
      weights: DEFAULT_QUEUE_WEIGHTS,
      now: NOW,
    });

    const summed = entry.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(summed).toBeCloseTo(entry.score, 10);
    expect(entry.score).toBeGreaterThan(0);
    expect(entry.score).toBeLessThanOrEqual(1);
  });

  it('reports every factor in the table even when its weight is zero', () => {
    const [entry] = rankTasks([make({ priority: 'urgent' })], {
      weights: only('urgency'),
      now: NOW,
    });

    expect(entry?.factors.map((f) => f.key)).toEqual(
      QUEUE_FACTORS.map((f) => f.key)
    );
    const age = entry?.factors.find((f) => f.key === 'age');
    expect(age?.weight).toBe(0);
    expect(age?.contribution).toBe(0);
  });

  it('changing a weight reorders the queue', () => {
    const urgentAndFresh = make({
      id: 't-aaaaaa',
      priority: 'urgent',
      created: NOW,
    });
    const lowAndAncient = make({
      id: 't-bbbbbb',
      priority: 'low',
      created: daysAgo(AGE_HORIZON_DAYS),
    });
    const tasks = [urgentAndFresh, lowAndAncient];

    expect(
      rankTasks(tasks, { weights: only('urgency'), now: NOW }).map(
        (e) => e.task.meta.id
      )
    ).toEqual(['t-aaaaaa', 't-bbbbbb']);
    expect(
      rankTasks(tasks, { weights: only('age'), now: NOW }).map(
        (e) => e.task.meta.id
      )
    ).toEqual(['t-bbbbbb', 't-aaaaaa']);
  });

  it('falls back to oldest-then-id ordering when every weight is zero', () => {
    const weights = { urgency: 0, unblocking: 0, age: 0 };
    const newer = make({ id: 't-aaaaaa', created: daysAgo(1) });
    const older = make({ id: 't-bbbbbb', created: daysAgo(9) });

    const ranked = rankTasks([newer, older], { weights, now: NOW });

    expect(ranked.map((e) => e.score)).toEqual([0, 0]);
    expect(ranked.map((e) => e.task.meta.id)).toEqual(['t-bbbbbb', 't-aaaaaa']);
  });

  it('breaks a score tie by created, then by id', () => {
    const sameA = make({ id: 't-bbbbbb', created: daysAgo(3) });
    const sameB = make({ id: 't-aaaaaa', created: daysAgo(3) });
    const older = make({ id: 't-cccccc', created: daysAgo(4) });

    const ranked = rankTasks([sameA, sameB, older], {
      weights: only('urgency'),
      now: NOW,
    });

    expect(ranked.map((e) => e.task.meta.id)).toEqual([
      't-cccccc',
      't-aaaaaa',
      't-bbbbbb',
    ]);
  });

  it('applies the limit after ranking, not before', () => {
    const low = make({ id: 't-aaaaaa', priority: 'low' });
    const urgent = make({ id: 't-zzzzzz', priority: 'urgent' });

    const ranked = rankTasks([low, urgent], {
      weights: only('urgency'),
      now: NOW,
      limit: 1,
    });

    expect(ranked.map((e) => e.task.meta.id)).toEqual(['t-zzzzzz']);
  });
});

describe('unusable weights', () => {
  it('ignores a NaN weight instead of poisoning every score', () => {
    const urgent = make({ id: 't-aaaaaa', priority: 'urgent' });
    const low = make({ id: 't-bbbbbb', priority: 'low' });

    const ranked = rankTasks([urgent, low], {
      weights: { urgency: 1, unblocking: Number.NaN, age: 0 },
      now: NOW,
    });

    for (const entry of ranked) expect(Number.isNaN(entry.score)).toBe(false);
    // The NaN weight drops out entirely, leaving urgency alone to decide.
    expect(ranked.map((e) => e.score)).toEqual([1, 0.25]);
    expect(ranked[0]?.factors.find((f) => f.key === 'unblocking')?.weight).toBe(
      0
    );
  });

  it('ignores an Infinity weight rather than collapsing the score to NaN', () => {
    const [entry] = rankTasks([make({ priority: 'urgent' })], {
      weights: { urgency: Number.POSITIVE_INFINITY, unblocking: 1, age: 0 },
      now: NOW,
    });

    expect(Number.isFinite(entry?.score ?? Number.NaN)).toBe(true);
    expect(entry?.factors.find((f) => f.key === 'urgency')?.weight).toBe(0);
  });

  // A negative weight would invert a factor's meaning. loadConfig rejects it,
  // but a caller handing rankTasks raw JSON can still get one here.
  it('ignores a negative weight', () => {
    const [entry] = rankTasks([make({ priority: 'urgent' })], {
      weights: { urgency: 1, unblocking: 0, age: -5 },
      now: NOW,
    });

    expect(entry?.score).toBe(1);
    expect(entry?.factors.find((f) => f.key === 'age')?.weight).toBe(0);
  });
});
