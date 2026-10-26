import { describe, expect, test } from 'bun:test';

import { nextMilestoneId } from '../src/index';
import type { Issue, MilestoneStatus, RiskReason } from '../src/index';
import {
  ago,
  assessmentOf,
  day,
  evaluate,
  issue,
  issuesIn,
  meta,
  milestone,
  project,
  STATE,
  workspace,
} from './helpers';

// One project, one milestone due `daysLeft` days from today (null = undated)
// holding `issues`.
function single(daysLeft: number | null, issues: Issue[]) {
  const evaluated = evaluate(
    workspace({
      projects: [project('p1')],
      milestones: [
        milestone('m1', 'p1', {
          targetDate: daysLeft === null ? null : day(daysLeft),
        }),
      ],
      issues: issues.map((i) => ({ ...i, projectId: 'p1', milestoneId: 'm1' })),
    })
  );
  return assessmentOf(evaluated, 'm1');
}

const open = (id: string, overrides: Partial<Issue> = {}): Issue =>
  issue(id, { assigneeId: 'lead', stateId: STATE.started, ...overrides });
const done = (id: string, overrides: Partial<Issue> = {}): Issue =>
  issue(id, { assigneeId: 'lead', stateId: STATE.done, ...overrides });

describe('the design doc example', () => {
  test('3/7 done with 2 days left is behind pace → at_risk', () => {
    const a = single(2, [
      done('d1'),
      done('d2'),
      done('d3'),
      open('o1'),
      open('o2'),
      open('o3'),
      open('o4'),
    ]);
    expect(a.status).toBe('at_risk');
    expect(a.reasons).toEqual(['behind_pace']);
    expect(a.daysLeft).toBe(2);
    expect(a.progress.completed).toBe(3);
    expect(a.progress.scope).toBe(7);
  });
});

describe('status precedence (§2.5)', () => {
  test.each<
    [string, number | null, () => Issue[], MilestoneStatus, RiskReason[]]
  >([
    ['no issues → empty, even when past due', -5, () => [], 'empty', []],
    [
      'all done → complete, even when past due',
      -5,
      () => [done('a'), done('b')],
      'complete',
      [],
    ],
    [
      'only canceled and duplicates → complete',
      3,
      () => [
        issue('c', { stateId: STATE.canceled }),
        issue('d', { stateId: STATE.duplicate }),
      ],
      'complete',
      [],
    ],
    [
      'open issues, no date → unscheduled (no reasons)',
      null,
      () => [issue('u')],
      'unscheduled',
      [],
    ],
    [
      'past due with open issues → overdue with reasons',
      -1,
      () => [done('a'), issue('u')],
      'overdue',
      ['unassigned_open', 'behind_pace'],
    ],
    [
      'due in exactly warnLeadDays with a reason → at_risk',
      7,
      () => [issue('u'), open('o')],
      'at_risk',
      ['unassigned_open'],
    ],
    [
      'due beyond warnLeadDays with a reason → on_track, no reasons',
      8,
      () => [issue('u')],
      'on_track',
      [],
    ],
    [
      'due soon, assigned, moving, ahead of pace → on_track',
      3,
      () => [done('a'), done('b'), done('c'), open('o')],
      'on_track',
      [],
    ],
    [
      'due today with open work → at_risk (behind pace)',
      0,
      () => [done('a'), open('o')],
      'at_risk',
      ['behind_pace'],
    ],
  ])('%s', (_name, daysLeft, build, status, reasons) => {
    const a = single(daysLeft, build());
    expect(a.status).toBe(status);
    expect(a.reasons).toEqual(reasons);
  });
});

describe('risk reasons', () => {
  test('an unassigned issue in Triage counts as unassigned_open', () => {
    const a = single(3, [
      done('a'),
      done('b'),
      done('c'),
      issue('t', { stateId: STATE.triage }),
    ]);
    expect(a.progress.openTriage).toBe(1);
    expect(a.reasons).toEqual(['unassigned_open']);
    expect(a.status).toBe('at_risk');
  });

  test.each([
    ['exactly stallDays ago → not stalled', ago(7), false],
    [
      'one millisecond past stallDays → stalled',
      new Date(Date.parse(ago(7)) - 1).toISOString(),
      true,
    ],
    ['nine days ago → stalled', ago(9), true],
    ['an hour ago → not stalled', ago(1 / 24), false],
  ])('%s', (_name, lastStateChangeAt, stalled) => {
    // Plenty of time and most work done, so only staleness can matter.
    const a = single(5, [
      done('a', { lastStateChangeAt }),
      done('b', { lastStateChangeAt }),
      done('c', { lastStateChangeAt }),
      open('o', { lastStateChangeAt }),
    ]);
    expect(a.reasons.includes('stalled')).toBe(stalled);
    expect(a.status).toBe(stalled ? 'at_risk' : 'on_track');
  });

  test('a recently closed issue counts as movement', () => {
    const a = single(5, [
      done('a', { lastStateChangeAt: ago(1) }),
      done('b', { lastStateChangeAt: ago(20) }),
      done('c', { lastStateChangeAt: ago(20) }),
      open('o', { lastStateChangeAt: ago(20) }),
    ]);
    expect(a.reasons).toEqual([]);
    expect(a.lastStateChangeAt).toBe(ago(1));
  });

  test.each([
    // [completed, open, daysLeft, behind]
    [5, 2, 2, false], // 2/7 left vs 2/7 time: equal is not behind
    [4, 3, 2, true],
    [6, 1, 1, false],
    [0, 1, 7, false], // 1/1 left vs 7/7 time
    [1, 9, 6, true], // 9/10 left vs 6/7 time
  ])(
    '%d done + %d open with %d days left → behind %s',
    (completed, openCount, daysLeft, behind) => {
      const issues = [
        ...Array.from({ length: completed }, (_, i) => done(`d${i}`)),
        ...Array.from({ length: openCount }, (_, i) => open(`o${i}`)),
      ];
      expect(single(daysLeft, issues).reasons.includes('behind_pace')).toBe(
        behind
      );
    }
  );

  test('paceWindowDays 0 turns behind_pace off', () => {
    const evaluated = evaluate(
      workspace({
        projects: [project('p1')],
        milestones: [milestone('m1', 'p1', { targetDate: day(1) })],
        issues: [open('o', { projectId: 'p1', milestoneId: 'm1' })],
      }),
      { tuning: { paceWindowDays: 0 } }
    );
    expect(assessmentOf(evaluated, 'm1').reasons).toEqual([]);
  });

  test('canceled issues leave the pace scope', () => {
    // 1 done, 1 open, 5 canceled: 1/2 left vs 2/7 time → behind.
    const a = single(2, [
      done('d'),
      open('o'),
      ...Array.from({ length: 5 }, (_, i) =>
        issue(`c${i}`, { stateId: STATE.canceled })
      ),
    ]);
    expect(a.progress.scope).toBe(2);
    expect(a.reasons).toEqual(['behind_pace']);
  });
});

describe('assessWorkspace', () => {
  test('assesses every milestone and copies rubric and done-means', () => {
    const evaluated = evaluate(
      workspace({
        projects: [project('p1')],
        milestones: [
          milestone('m1', 'p1', { description: null }),
          milestone('m2', 'p1', { targetDate: null }),
        ],
        issues: issuesIn('i', 'p1', 'm1', 2),
      }),
      { meta: [meta('m2', { doneMeans: 'It works' })] }
    );
    expect([...evaluated.assessments.keys()]).toEqual(['m1', 'm2']);
    const m1 = assessmentOf(evaluated, 'm1');
    expect(m1.rubric.gaps).toEqual(['no_done_means']);
    expect(m1.doneMeans).toEqual({ text: null, source: null });
    const m2 = assessmentOf(evaluated, 'm2');
    expect(m2.doneMeans).toEqual({ text: 'It works', source: 'planner' });
    expect(m2.rubric.gaps).toEqual(['no_target_date', 'no_issues']);
    expect(m2.status).toBe('empty');
    expect(m2.lastStateChangeAt).toBeNull();
  });

  test('lastStateChangeAt compares instants, not strings', () => {
    const a = single(5, [
      done('a', { lastStateChangeAt: '2026-10-21T10:00:00.000Z' }),
      // 09:00 at UTC-5 is 14:00 UTC: the later instant.
      done('b', { lastStateChangeAt: '2026-10-21T09:00:00.000-05:00' }),
      open('o', { lastStateChangeAt: '2026-10-20T00:00:00.000Z' }),
    ]);
    expect(a.lastStateChangeAt).toBe('2026-10-21T09:00:00.000-05:00');
  });
});

describe('next milestone (§2.6, §6.11)', () => {
  // Milestones in one project; `state` picks how its issues look.
  function project1(
    specs: {
      id: string;
      days: number | null;
      state: 'open' | 'done' | 'empty';
      sortOrder?: number;
    }[],
    weights: Record<string, number> = {}
  ) {
    const issues: Issue[] = [];
    for (const spec of specs) {
      if (spec.state === 'empty') continue;
      issues.push(
        issue(`${spec.id}-i`, {
          projectId: 'p1',
          milestoneId: spec.id,
          assigneeId: 'lead',
          stateId: spec.state === 'done' ? STATE.done : STATE.started,
        })
      );
    }
    const evaluated = evaluate(
      workspace({
        projects: [project('p1')],
        milestones: specs.map((spec) =>
          milestone(spec.id, 'p1', {
            targetDate: spec.days === null ? null : day(spec.days),
            sortOrder: spec.sortOrder ?? 0,
          })
        ),
        issues,
      }),
      {
        meta: Object.entries(weights).map(([id, weight]) =>
          meta(id, { weight })
        ),
      }
    );
    const next = nextMilestoneId(
      evaluated.snapshot,
      'p1',
      evaluated.assessments
    );
    const flagged = [...evaluated.assessments.values()]
      .filter((a) => a.isNext)
      .map((a) => a.milestoneId);
    return { next, flagged };
  }

  test.each<
    [
      string,
      Parameters<typeof project1>[0],
      Record<string, number>,
      string | null,
    ]
  >([
    [
      'earliest dated incomplete milestone',
      [
        { id: 'late', days: 30, state: 'open' },
        { id: 'early', days: 10, state: 'open' },
      ],
      {},
      'early',
    ],
    [
      'complete milestones are passed over',
      [
        { id: 'first', days: 5, state: 'done' },
        { id: 'second', days: 10, state: 'open' },
      ],
      {},
      'second',
    ],
    [
      'undated milestones come last',
      [
        { id: 'undated', days: null, state: 'open' },
        { id: 'dated', days: 40, state: 'open' },
      ],
      {},
      'dated',
    ],
    [
      'an undated milestone is next once dated ones are complete',
      [
        { id: 'undated', days: null, state: 'open' },
        { id: 'dated', days: 5, state: 'done' },
      ],
      {},
      'undated',
    ],
    [
      'an empty milestone blocks its project (it is not complete)',
      [
        { id: 'empty', days: 5, state: 'empty' },
        { id: 'later', days: 10, state: 'open' },
      ],
      {},
      'empty',
    ],
    [
      'an overdue milestone stays next',
      [
        { id: 'overdue', days: -3, state: 'open' },
        { id: 'later', days: 10, state: 'open' },
      ],
      {},
      'overdue',
    ],
    [
      'a weight override does not change next',
      [
        { id: 'early', days: 5, state: 'open' },
        { id: 'heavy', days: 10, state: 'open' },
      ],
      { heavy: 100 },
      'early',
    ],
    [
      'same date: sortOrder decides',
      [
        { id: 'b', days: 5, state: 'open', sortOrder: 2 },
        { id: 'a', days: 5, state: 'open', sortOrder: 1 },
      ],
      {},
      'a',
    ],
    [
      'all complete → none',
      [
        { id: 'a', days: 5, state: 'done' },
        { id: 'b', days: null, state: 'done' },
      ],
      {},
      null,
    ],
    ['no milestones → none', [], {}, null],
  ])('%s', (_name, specs, weights, expected) => {
    const { next, flagged } = project1(specs, weights);
    expect(next).toBe(expected);
    expect(flagged).toEqual(expected === null ? [] : [expected]);
  });

  test('a milestone without an assessment is treated as not complete', () => {
    const evaluated = evaluate(
      workspace({
        projects: [project('p1')],
        milestones: [milestone('m1', 'p1')],
      })
    );
    expect(nextMilestoneId(evaluated.snapshot, 'p1', new Map())).toBe('m1');
  });
});
