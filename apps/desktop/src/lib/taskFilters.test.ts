import type { TaskDoc } from '@dispatch-foo/core/browser';
import { ApiError } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  aiFilterErrorText,
  applyDatePick,
  applyTaskFilters,
  clauseParts,
  DATE_PICKS,
  datePickBound,
  DAY_MS,
  defaultOpFor,
  EMPTY_TASK_FILTER_SET,
  FILTER_NONE,
  type FilterPickerContext,
  hasActiveTaskFilters,
  isDateFacet,
  matches,
  matchesTaskFilterSet,
  migrateLegacyFilters,
  optionsFor,
  parseTaskFilterSet,
  pickedDateValue,
  removeFilterClause,
  selectedCount,
  serializeTaskFilterSet,
  setDateFilter,
  setFilterJoin,
  type TaskFilterSet,
  taskFilterSetFromValue,
  toggleClauseNegation,
  toggleFilterValue,
} from './taskFilters';

function task(id: string, overrides: Partial<TaskDoc['meta']> = {}): TaskDoc {
  return {
    meta: {
      id,
      title: id,
      status: 'ready',
      kind: 'task',
      priority: 'medium',
      parent: null,
      milestone: null,
      labels: [],
      assignee: 'none',
      blockedBy: [],
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-13T00:00:00.000Z',
      ...overrides,
    },
    body: '',
  } as unknown as TaskDoc;
}

const TASKS = [
  task('t-1', { status: 'working', priority: 'urgent', labels: ['ui'] }),
  task('t-2', { status: 'ready', priority: 'low', parent: 'e-1' }),
  task('t-3', {
    status: 'ready',
    priority: 'urgent',
    labels: ['ui', 'api'],
    assignee: 'agent',
    created: '2026-08-01T00:00:00.000Z',
  }),
];

function set(
  clauses: TaskFilterSet['clauses'],
  join: TaskFilterSet['join'] = 'and'
): TaskFilterSet {
  return { clauses, join };
}

describe('clauses', () => {
  test('an empty set passes everything and returns the same array', () => {
    expect(applyTaskFilters(TASKS, EMPTY_TASK_FILTER_SET)).toBe(TASKS);
    expect(hasActiveTaskFilters(EMPTY_TASK_FILTER_SET)).toBe(false);
  });

  test('`is` matches any of the clause values', () => {
    const filters = set([
      { facet: 'status', op: 'is', values: ['working', 'review'] },
    ]);
    expect(applyTaskFilters(TASKS, filters).map((t) => t.meta.id)).toEqual([
      't-1',
    ]);
  });

  test('`is not` excludes the clause values', () => {
    const filters = set([
      { facet: 'priority', op: 'is not', values: ['urgent'] },
    ]);
    expect(applyTaskFilters(TASKS, filters).map((t) => t.meta.id)).toEqual([
      't-2',
    ]);
  });

  test('labels `includes` wants every named label', () => {
    const filters = set([
      { facet: 'labels', op: 'includes', values: ['ui', 'api'] },
    ]);
    expect(applyTaskFilters(TASKS, filters).map((t) => t.meta.id)).toEqual([
      't-3',
    ]);
  });

  test('milestone and run state read `none` as unset', () => {
    expect(
      applyTaskFilters(
        TASKS,
        set([{ facet: 'milestone', op: 'is', values: ['none'] }])
      ).map((t) => t.meta.id)
    ).toEqual(['t-1', 't-3']);
    expect(
      matchesTaskFilterSet(
        TASKS[0],
        set([{ facet: 'run', op: 'is', values: ['running'] }]),
        { liveRunStateByTaskId: new Map([['t-1', 'running']]) }
      )
    ).toBe(true);
    expect(
      matchesTaskFilterSet(
        TASKS[1],
        set([{ facet: 'run', op: 'is', values: ['none'] }]),
        { liveRunStateByTaskId: new Map([['t-1', 'running']]) }
      )
    ).toBe(true);
  });

  test('date facets compare before/after one ISO bound', () => {
    const filters = set([
      { facet: 'created', op: 'before', values: ['2026-08-15T00:00:00.000Z'] },
    ]);
    expect(applyTaskFilters(TASKS, filters).map((t) => t.meta.id)).toEqual([
      't-3',
    ]);
  });
});

describe('and/or', () => {
  const clauses: TaskFilterSet['clauses'] = [
    { facet: 'status', op: 'is', values: ['working'] },
    { facet: 'priority', op: 'is', values: ['urgent'] },
  ];

  test('`and` wants every clause', () => {
    expect(
      applyTaskFilters(TASKS, set(clauses, 'and')).map((t) => t.meta.id)
    ).toEqual(['t-1']);
  });

  test('`or` wants any clause', () => {
    expect(
      applyTaskFilters(TASKS, set(clauses, 'or')).map((t) => t.meta.id)
    ).toEqual(['t-1', 't-3']);
  });

  test('setFilterJoin flips the join without touching the clauses', () => {
    const next = setFilterJoin(set(clauses), 'or');
    expect(next.join).toBe('or');
    expect(next.clauses).toBe(clauses);
  });
});

describe('editing', () => {
  test('toggling a value creates the facet clause, extends it, then empties it away', () => {
    let filters = toggleFilterValue(EMPTY_TASK_FILTER_SET, 'status', 'ready');
    expect(filters.clauses).toEqual([
      { facet: 'status', op: 'is', values: ['ready'] },
    ]);
    filters = toggleFilterValue(filters, 'status', 'working');
    expect(filters.clauses[0]?.values).toEqual(['ready', 'working']);
    filters = toggleFilterValue(filters, 'status', 'ready');
    filters = toggleFilterValue(filters, 'status', 'working');
    expect(filters.clauses).toEqual([]);
  });

  test('labels default to `includes`, dates to `after`', () => {
    expect(defaultOpFor('labels')).toBe('includes');
    expect(defaultOpFor('created')).toBe('after');
    expect(defaultOpFor('status')).toBe('is');
  });

  test('a date clause replaces the previous one for its facet', () => {
    let filters = setDateFilter(
      EMPTY_TASK_FILTER_SET,
      'updated',
      'after',
      '2026-09-01'
    );
    filters = setDateFilter(filters, 'updated', 'before', '2026-09-10');
    expect(filters.clauses).toEqual([
      { facet: 'updated', op: 'before', values: ['2026-09-10'] },
    ]);
  });

  test('removing and negating a clause by index', () => {
    const filters = set([
      { facet: 'status', op: 'is', values: ['ready'] },
      { facet: 'priority', op: 'is', values: ['low'] },
    ]);
    expect(removeFilterClause(filters, 0).clauses).toEqual([
      { facet: 'priority', op: 'is', values: ['low'] },
    ]);
    expect(toggleClauseNegation(filters, 1).clauses[1]?.op).toBe('is not');
    // A label `includes` clause has no negation to flip.
    const labels = set([{ facet: 'labels', op: 'includes', values: ['ui'] }]);
    expect(toggleClauseNegation(labels, 0)).toBe(labels);
  });
});

describe('storage', () => {
  test('round-trips through serialize/parse', () => {
    const filters = set(
      [{ facet: 'status', op: 'is not', values: ['landed'] }],
      'or'
    );
    expect(parseTaskFilterSet(serializeTaskFilterSet(filters))).toEqual(
      filters
    );
  });

  test('migrates the v1 chip shape into `is` clauses when v2 is unset', () => {
    const legacy = JSON.stringify({
      statuses: ['ready', 'working'],
      priorities: ['urgent'],
    });
    expect(parseTaskFilterSet(null, legacy)).toEqual({
      join: 'and',
      clauses: [
        { facet: 'status', op: 'is', values: ['ready', 'working'] },
        { facet: 'priority', op: 'is', values: ['urgent'] },
      ],
    });
    expect(migrateLegacyFilters(JSON.stringify({ statuses: [] }))).toEqual(
      EMPTY_TASK_FILTER_SET
    );
  });

  test('a written v2 value wins over the legacy key', () => {
    const v2 = serializeTaskFilterSet(
      set([{ facet: 'priority', op: 'is', values: ['low'] }])
    );
    const legacy = JSON.stringify({ statuses: ['ready'], priorities: [] });
    expect(parseTaskFilterSet(v2, legacy).clauses).toEqual([
      { facet: 'priority', op: 'is', values: ['low'] },
    ]);
  });

  test('junk falls back to the empty set', () => {
    expect(parseTaskFilterSet('{not json')).toEqual(EMPTY_TASK_FILTER_SET);
    expect(parseTaskFilterSet('[]')).toEqual(EMPTY_TASK_FILTER_SET);
    expect(
      parseTaskFilterSet(
        JSON.stringify({
          clauses: [{ facet: 'nope', values: ['x'] }, { facet: 'status' }],
          join: 'xor',
        })
      )
    ).toEqual(EMPTY_TASK_FILTER_SET);
  });

  test('taskFilterSetFromValue walks an object and rejects anything else', () => {
    expect(
      taskFilterSetFromValue({
        clauses: [
          { facet: 'status', op: 'is', values: ['ready'] },
          { facet: 'labels', values: ['ui'] },
        ],
        join: 'or',
      })
    ).toEqual({
      clauses: [
        { facet: 'status', op: 'is', values: ['ready'] },
        { facet: 'labels', op: 'includes', values: ['ui'] },
      ],
      join: 'or',
    });
    expect(taskFilterSetFromValue(null)).toBeNull();
    expect(taskFilterSetFromValue('{}')).toBeNull();
    expect(taskFilterSetFromValue([])).toBeNull();
    // An unknown facet drops its clause; the rest of the set survives.
    expect(
      taskFilterSetFromValue({
        clauses: [
          { facet: 'sprint', op: 'is', values: ['3'] },
          { facet: 'priority', op: 'is not', values: ['none'] },
        ],
      })
    ).toEqual({
      clauses: [{ facet: 'priority', op: 'is not', values: ['none'] }],
      join: 'and',
    });
  });

  test('a stored epic clause reads back as a milestone clause', () => {
    // Filter sets written before the epic -> milestone rename name the
    // parent container facet `epic`; the `milestone` facet now matches the
    // same parent ids, so the clause survives instead of dropping.
    const stored = JSON.stringify({
      clauses: [
        { facet: 'epic', op: 'is', values: ['e-1'] },
        { facet: 'epic', op: 'is not', values: [FILTER_NONE] },
        { facet: 'epic', values: ['e-2'] },
      ],
      join: 'or',
    });
    expect(parseTaskFilterSet(stored)).toEqual({
      clauses: [
        { facet: 'milestone', op: 'is', values: ['e-1'] },
        { facet: 'milestone', op: 'is not', values: [FILTER_NONE] },
        { facet: 'milestone', op: 'is', values: ['e-2'] },
      ],
      join: 'or',
    });
  });

  test('serializeTaskFilterSet writes a fixed field order', () => {
    const shuffled = {
      join: 'and',
      clauses: [{ values: ['ready'], op: 'is', facet: 'status' }],
    } satisfies TaskFilterSet;
    expect(serializeTaskFilterSet(shuffled)).toBe(
      serializeTaskFilterSet(
        set([{ facet: 'status', op: 'is', values: ['ready'] }])
      )
    );
  });
});

describe('labels', () => {
  const sentence = (parts: ReturnType<typeof clauseParts>) =>
    `${parts.facet} ${parts.op} ${parts.values}`;

  test('a chip reads `Status is In progress`', () => {
    expect(
      sentence(clauseParts({ facet: 'status', op: 'is', values: ['working'] }))
    ).toBe('Status is Working');
    expect(
      sentence(
        clauseParts({ facet: 'labels', op: 'includes', values: ['ui', 'api'] })
      )
    ).toBe('Labels includes ui, api');
    expect(
      sentence(
        clauseParts(
          { facet: 'milestone', op: 'is', values: ['e-1'] },
          {
            milestoneTitleById: new Map([['e-1', 'Payments']]),
          }
        )
      )
    ).toBe('Milestone is Payments');
    expect(
      sentence(clauseParts({ facet: 'milestone', op: 'is', values: ['none'] }))
    ).toBe('Milestone is No milestone');
  });
});

describe('Filter picker vocabulary', () => {
  const PICKER_CONTEXT: FilterPickerContext = {
    statuses: ['draft', 'working'],
    milestones: [task('e-1', { title: 'Payments' })],
    labels: ['api', 'ui'],
  };
  const NOW = Date.parse('2026-10-26T12:00:00.000Z');

  test('optionsFor lists each facet in menu order with its marks', () => {
    expect(optionsFor('status', PICKER_CONTEXT)).toEqual([
      {
        value: 'draft',
        label: 'Draft',
        mark: { kind: 'state', status: 'draft' },
      },
      {
        value: 'working',
        label: 'Working',
        mark: { kind: 'state', status: 'working' },
      },
    ]);
    expect(
      optionsFor('priority', PICKER_CONTEXT).map((o) => [o.value, o.mark])
    ).toEqual([
      ['urgent', { kind: 'priority', priority: 'urgent' }],
      ['high', { kind: 'priority', priority: 'high' }],
      ['medium', { kind: 'priority', priority: 'medium' }],
      ['low', { kind: 'priority', priority: 'low' }],
      ['none', { kind: 'priority', priority: 'none' }],
    ]);
    // Nobody is the blank (dashed) avatar.
    expect(optionsFor('assignee', PICKER_CONTEXT)).toEqual([
      {
        value: 'agent',
        label: 'Agent',
        mark: { kind: 'avatar', name: 'Agent' },
      },
      {
        value: 'human',
        label: 'Human',
        mark: { kind: 'avatar', name: 'Human' },
      },
      {
        value: 'none',
        label: 'Unassigned',
        mark: { kind: 'avatar', name: '' },
      },
    ]);
    expect(optionsFor('labels', PICKER_CONTEXT)).toEqual([
      { value: 'api', label: 'api' },
      { value: 'ui', label: 'ui' },
    ]);
    // A milestone is filtered on by id and read by its title.
    expect(optionsFor('milestone', PICKER_CONTEXT)).toEqual([
      { value: 'none', label: 'No milestone' },
      { value: 'e-1', label: 'Payments' },
    ]);
    expect(optionsFor('run', PICKER_CONTEXT).map((o) => o.label)).toEqual([
      'Working',
      'Provisioning',
      'Awaiting approval',
      'Finished',
      'Failed',
      'Cancelled',
      'Interrupted',
      'No live run',
    ]);
    expect(optionsFor('created', PICKER_CONTEXT)).toEqual(
      DATE_PICKS.map((pick) => ({
        value: `${pick.op}:${pick.days}`,
        label: pick.label,
      }))
    );
    expect(optionsFor('updated', PICKER_CONTEXT)).toEqual(
      optionsFor('created', PICKER_CONTEXT)
    );
  });

  test('an empty vocabulary leaves only the "none" rows', () => {
    const empty: FilterPickerContext = {
      statuses: [],
      milestones: [],
      labels: [],
    };
    expect(optionsFor('status', empty)).toEqual([]);
    expect(optionsFor('labels', empty)).toEqual([]);
    expect(optionsFor('milestone', empty)).toEqual([
      { value: 'none', label: 'No milestone' },
    ]);
  });

  test('matches is a trimmed, case-blind substring test', () => {
    expect(matches('  STAT ', 'Status')).toBe(true);
    expect(matches('run st', 'Run state')).toBe(true);
    expect(matches('', 'Anything')).toBe(true);
    expect(matches('parent', 'Milestone')).toBe(false);
  });

  test('isDateFacet names the two date facets', () => {
    expect(isDateFacet('created')).toBe(true);
    expect(isDateFacet('updated')).toBe(true);
    expect(isDateFacet('status')).toBe(false);
  });

  test('selectedCount counts the clause values of one facet', () => {
    const filters = set([
      { facet: 'status', op: 'is', values: ['ready', 'working'] },
      { facet: 'created', op: 'after', values: ['2026-10-01T00:00:00.000Z'] },
    ]);
    expect(selectedCount(filters, 'status')).toBe(2);
    expect(selectedCount(filters, 'created')).toBe(1);
    expect(selectedCount(filters, 'labels')).toBe(0);
  });

  test('datePickBound turns a pick into its operator and ISO bound', () => {
    expect(datePickBound('after:7', NOW)).toEqual({
      op: 'after',
      bound: new Date(NOW - 7 * DAY_MS).toISOString(),
    });
    expect(datePickBound('before:30', NOW)).toEqual({
      op: 'before',
      bound: new Date(NOW - 30 * DAY_MS).toISOString(),
    });
  });

  test('applyDatePick replaces the facet bound and keeps other clauses', () => {
    const start = set([
      { facet: 'status', op: 'is', values: ['ready'] },
      { facet: 'created', op: 'after', values: ['2020-01-01T00:00:00.000Z'] },
    ]);
    const next = applyDatePick(start, 'created', 'before:7', NOW);
    expect(next.clauses).toEqual([
      { facet: 'status', op: 'is', values: ['ready'] },
      {
        facet: 'created',
        op: 'before',
        values: [new Date(NOW - 7 * DAY_MS).toISOString()],
      },
    ]);
    expect(start.clauses).toHaveLength(2);
    expect(start.clauses[1]?.op).toBe('after');
  });

  test('pickedDateValue finds the pick nearest the bound age, by operator', () => {
    for (const pick of DATE_PICKS) {
      const value = `${pick.op}:${pick.days}`;
      const filters = applyDatePick(
        EMPTY_TASK_FILTER_SET,
        'updated',
        value,
        NOW
      );
      expect(pickedDateValue(filters, 'updated', NOW)).toBe(value);
    }
    // A day later the week pick still reads as the week, not the month.
    const week = applyDatePick(
      EMPTY_TASK_FILTER_SET,
      'created',
      'after:7',
      NOW
    );
    expect(pickedDateValue(week, 'created', NOW + DAY_MS)).toBe('after:7');
    // A clause from elsewhere (an AI filter, a saved view) maps to the nearest pick.
    const nineDays = set([
      {
        facet: 'created',
        op: 'before',
        values: [new Date(NOW - 9 * DAY_MS).toISOString()],
      },
    ]);
    expect(pickedDateValue(nineDays, 'created', NOW)).toBe('before:7');
  });

  test('pickedDateValue is null without a clause or a readable bound', () => {
    expect(pickedDateValue(EMPTY_TASK_FILTER_SET, 'created', NOW)).toBeNull();
    const bad = set([
      { facet: 'created', op: 'after', values: ['not a date'] },
    ]);
    expect(pickedDateValue(bad, 'created', NOW)).toBeNull();
    // An operator no pick uses has no nearest pick.
    const odd = set([
      { facet: 'created', op: 'is', values: ['2026-10-01T00:00:00.000Z'] },
    ]);
    expect(pickedDateValue(odd, 'created', NOW)).toBeNull();
  });

  test('aiFilterErrorText reads a 404 as the update hint', () => {
    expect(aiFilterErrorText(new ApiError('not found', 404))).toBe(
      'Update the daemon to use AI filters'
    );
    expect(aiFilterErrorText(new ApiError('model unavailable', 503))).toBe(
      'model unavailable'
    );
    expect(aiFilterErrorText(new Error('boom'))).toBe('boom');
    expect(aiFilterErrorText(new Error(''))).toBe('AI filter failed');
    expect(aiFilterErrorText('a string')).toBe('AI filter failed');
  });
});
