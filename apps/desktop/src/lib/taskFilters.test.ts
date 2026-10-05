import type { TaskDoc } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  applyTaskFilters,
  clauseParts,
  defaultOpFor,
  EMPTY_TASK_FILTER_SET,
  hasActiveTaskFilters,
  matchesTaskFilterSet,
  migrateLegacyFilters,
  parseTaskFilterSet,
  removeFilterClause,
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

  test('epic, milestone and run state read `none` as unset', () => {
    expect(
      applyTaskFilters(
        TASKS,
        set([{ facet: 'epic', op: 'is', values: ['none'] }])
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
          { facet: 'epic', op: 'is', values: ['e-1'] },
          {
            epicTitleById: new Map([['e-1', 'Payments']]),
          }
        )
      )
    ).toBe('Epic is Payments');
    expect(
      sentence(clauseParts({ facet: 'epic', op: 'is', values: ['none'] }))
    ).toBe('Epic is No epic');
  });
});
