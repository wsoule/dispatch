import type { TaskDoc } from '@dispatch/core/browser';
import { statusModelOf } from '@dispatch/core/browser';
import { afterEach, describe, expect, test } from 'bun:test';

import { groupTasks, nestRows, sortTasks, visibleRowIds } from './listGrouping';
import { setActiveStatusModel } from './statusModel';
import { DEFAULT_TASKS_DISPLAY, type TasksDisplayPrefs } from './tasksPrefs';

type Meta = TaskDoc['meta'];

function task(id: string, overrides: Partial<Meta> = {}, title = id): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-09-01T12:00:00.000Z',
      updated: '2026-09-01T12:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...overrides,
    },
    body: '',
  } as TaskDoc;
}

const STATUSES = ['draft', 'ready', 'working', 'review', 'landed', 'dropped'];

afterEach(() => setActiveStatusModel(null));

function prefs(overrides: Partial<TasksDisplayPrefs> = {}): TasksDisplayPrefs {
  return { ...DEFAULT_TASKS_DISPLAY, ...overrides };
}

describe('groupTasks by status (the default)', () => {
  test('groups follow config order, skipping empty statuses', () => {
    const groups = groupTasks(
      [task('a', { status: 'working' }), task('b', { status: 'ready' })],
      prefs(),
      { statuses: STATUSES, epics: [] }
    );
    expect(groups.map((g) => g.key)).toEqual([
      'status:ready',
      'status:working',
    ]);
    expect(groups[0]?.label).toBe('Ready');
    expect(groups[0]?.icon).toEqual({ kind: 'status', status: 'ready' });
    expect(groups[0]?.tint).toBe('var(--status-todo)');
    expect(groups[0]?.preset).toEqual({ status: 'ready' });
  });

  test('showEmptyGroups keeps every configured status', () => {
    const groups = groupTasks(
      [task('a', { status: 'ready' })],
      prefs({ showEmptyGroups: true }),
      { statuses: STATUSES, epics: [] }
    );
    expect(groups.map((g) => g.key)).toEqual(
      STATUSES.map((s) => `status:${s}`)
    );
  });

  test('a status the config no longer lists still gets a trailing group', () => {
    const groups = groupTasks([task('a', { status: 'qa' })], prefs(), {
      statuses: STATUSES,
      epics: [],
    });
    expect(groups.map((g) => g.key)).toEqual(['status:qa']);
  });

  test('archived tasks trail as one read-only group', () => {
    const groups = groupTasks([task('a')], prefs(), {
      statuses: STATUSES,
      epics: [],
      archivedTasks: [task('old')],
    });
    expect(groups.at(-1)).toMatchObject({
      key: 'archived',
      kind: 'archived',
      archived: true,
    });
    expect(groups.at(-1)?.rows.map((r) => r.doc.meta.id)).toEqual(['old']);
  });
});

describe('nested sub-tasks', () => {
  test('a child whose parent is in the same group indents under it', () => {
    const epic = task(
      'e-1',
      { kind: 'milestone', status: 'ready' },
      'Payments'
    );
    const child = task('t-1', { parent: 'e-1', status: 'ready' });
    const other = task('t-2', { status: 'ready' });
    const groups = groupTasks([other, child, epic], prefs(), {
      statuses: STATUSES,
      epics: [epic],
    });
    const rows = groups[0]?.rows.map((r) => [r.doc.meta.id, r.indent]);
    expect(rows).toEqual([
      ['t-2', 0],
      ['e-1', 0],
      ['t-1', 1],
    ]);
  });

  // The default prefs nest, and a task under a task under an epic is an ordinary shape — a
  // three-deep chain in one group must keep every row (the grandchild once fell off).
  test('a grandchild in the same group follows its parent, clamped to one indent', () => {
    const epic = task('e-1', { kind: 'milestone' });
    const member = task('t-1', { parent: 'e-1' });
    const sub = task('t-2', { parent: 't-1' });
    const loose = task('t-3');
    const groups = groupTasks([loose, sub, member, epic], prefs(), {
      statuses: STATUSES,
      epics: [epic],
    });
    expect(groups[0]?.rows.map((r) => [r.doc.meta.id, r.indent])).toEqual([
      ['t-3', 0],
      ['e-1', 0],
      ['t-1', 1],
      ['t-2', 1],
    ]);
  });

  test('a parent cycle still renders every row at the top level', () => {
    const a = task('a', { parent: 'b' });
    const b = task('b', { parent: 'a' });
    expect(nestRows([a, b], prefs()).map((r) => r.doc.meta.id)).toEqual([
      'a',
      'b',
    ]);
  });

  test('a child in another group is its own top-level row', () => {
    const epic = task('e-1', { kind: 'milestone', status: 'ready' });
    const child = task('t-1', { parent: 'e-1', status: 'working' });
    const groups = groupTasks([epic, child], prefs(), {
      statuses: STATUSES,
      epics: [epic],
    });
    expect(groups.map((g) => g.rows.map((r) => r.indent))).toEqual([[0], [0]]);
  });

  test('nestedSubtasks off flattens everything', () => {
    const parent = task('p');
    const child = task('c', { parent: 'p' });
    expect(nestRows([parent, child], prefs({ nestedSubtasks: false }))).toEqual(
      [
        { doc: parent, indent: 0 },
        { doc: child, indent: 0 },
      ]
    );
  });

  // Epic members are not sub-tasks; only a task under another task is.
  test('showSubtasks off hides task-under-task children but keeps epic members', () => {
    const epic = task('e-1', { kind: 'milestone' });
    const member = task('t-1', { parent: 'e-1' });
    const sub = task('t-2', { parent: 't-1' });
    const groups = groupTasks(
      [epic, member, sub],
      prefs({ showSubtasks: false, nestedSubtasks: false }),
      { statuses: STATUSES, epics: [epic] }
    );
    expect(groups[0]?.rows.map((r) => r.doc.meta.id)).toEqual(['e-1', 't-1']);
  });
});

describe('groupTasks by epic and milestone', () => {
  const epic = task('e-1', { kind: 'milestone' }, 'Payments');
  const tasks = [
    epic,
    task('t-1', { parent: 'e-1' }),
    task('t-2', { parent: 'ghost' }),
    task('t-3'),
  ];

  test('epic order, then dangling parents, then No epic; epic docs are headers not rows', () => {
    const groups = groupTasks(tasks, prefs({ grouping: 'epic' }), {
      statuses: STATUSES,
      epics: [epic],
    });
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['epic:e-1', 'Payments'],
      ['epic:ghost', 'ghost'],
      ['epic:none', 'No epic'],
    ]);
    expect(groups[0]?.epicId).toBe('e-1');
    expect(groups[0]?.preset).toEqual({ epic: 'e-1' });
    expect(groups[0]?.tint).toMatch(/^var\(--project-color-[1-8]\)$/);
    expect(groups.flatMap((g) => g.rows.map((r) => r.doc.meta.id))).toEqual([
      't-1',
      't-2',
      't-3',
    ]);
  });

  test('milestone grouping wears the rolled-up status and sinks finished milestones', () => {
    const done = task('e-2', { kind: 'milestone' }, 'Shipped');
    const groups = groupTasks(
      [
        done,
        task('t-9', { parent: 'e-2', status: 'landed' }),
        epic,
        task('t-1', { parent: 'e-1', status: 'working' }),
      ],
      prefs({ grouping: 'milestone' }),
      { statuses: STATUSES, epics: [done, epic] }
    );
    expect(groups.map((g) => g.key)).toEqual([
      'milestone:e-1',
      'milestone:e-2',
    ]);
    expect(groups[0]?.icon).toEqual({ kind: 'milestone', status: 'working' });
    expect(groups[0]?.tint).toBe('var(--status-progress)');
    expect(groups[1]?.icon).toEqual({ kind: 'milestone', status: 'landed' });
  });

  test("a milestone group's + files the new task under it as its parent", () => {
    const groups = groupTasks(tasks, prefs({ grouping: 'milestone' }), {
      statuses: STATUSES,
      epics: [epic],
    });
    expect(groups[0]?.key).toBe('milestone:e-1');
    expect(groups[0]?.preset).toEqual({ epic: 'e-1' });
    expect(groups.find((g) => g.key === 'milestone:ghost')?.preset).toEqual({
      epic: 'ghost',
    });
  });
});

describe('groupTasks by milestone follows the real hierarchy', () => {
  // Growth › Payments (project) › Beta, GA (milestones); a parent issue under Beta with
  // two sub-issues; one issue filed straight under the project; a loose parent issue.
  const growth = task('i-1', { kind: 'initiative' }, 'Growth');
  const payments = task('p-1', { kind: 'project', parent: 'i-1' }, 'Payments');
  const beta = task('m-1', { kind: 'milestone', parent: 'p-1' }, 'Beta');
  const ga = task('m-2', { kind: 'milestone', parent: 'p-1' }, 'GA');
  const checkout = task('t-1', { parent: 'm-1' }, 'Checkout');
  const card = task('t-2', { parent: 't-1' }, 'Card form');
  const receipt = task('t-3', { parent: 't-1' }, 'Receipt');
  const direct = task('t-4', { parent: 'p-1' }, 'Pricing page');
  const launch = task('t-5', { parent: 'm-2' }, 'Launch');
  const loose = task('t-6', {}, 'Loose parent');
  const looseChild = task('t-7', { parent: 't-6' }, 'Loose child');
  const all = [
    growth,
    payments,
    beta,
    ga,
    checkout,
    card,
    receipt,
    direct,
    launch,
    loose,
    looseChild,
  ];
  // What the app passes: every container kind plus every task with children.
  const epics = [growth, payments, beta, ga, checkout, loose];

  test('groups are milestones (and projects with work straight under them), in tree order', () => {
    const groups = groupTasks(all, prefs({ grouping: 'milestone' }), {
      statuses: STATUSES,
      epics,
    });
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['milestone:p-1', 'Growth › Payments'],
      ['milestone:m-1', 'Payments › Beta'],
      ['milestone:m-2', 'Payments › GA'],
      ['epic:none', 'No milestone'],
    ]);
    // A parent issue is a row with its sub-issues nested under it, not a group.
    expect(
      groups[1]?.rows.map((r) => [r.doc.meta.id, r.indent] as const)
    ).toEqual([
      ['t-1', 0],
      ['t-2', 1],
      ['t-3', 1],
    ]);
    expect(groups[0]?.rows.map((r) => r.doc.meta.id)).toEqual(['t-4']);
    expect(groups[3]?.rows.map((r) => r.doc.meta.id)).toEqual(['t-6', 't-7']);
  });

  test('a project with only milestones under it is no group, however empty they are', () => {
    const groups = groupTasks(
      [growth, payments, beta, ga],
      prefs({ grouping: 'milestone', showEmptyGroups: true }),
      { statuses: STATUSES, epics: [growth, payments, beta, ga] }
    );
    expect(groups.map((g) => g.key)).toEqual([
      'milestone:m-1',
      'milestone:m-2',
    ]);
  });

  test('an empty project with nothing below it is still a group', () => {
    const lone = task('p-2', { kind: 'project' }, 'Lone');
    const groups = groupTasks(
      [lone],
      prefs({ grouping: 'milestone', showEmptyGroups: true }),
      { statuses: STATUSES, epics: [lone] }
    );
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['milestone:p-2', 'Lone'],
    ]);
  });

  test('a filter that hides a parent issue leaves its sub-issues under their milestone', () => {
    // The list passes only the rows its filter keeps; the parent issues are still epics.
    const groups = groupTasks(
      [card, looseChild],
      prefs({ grouping: 'milestone' }),
      { statuses: STATUSES, epics }
    );
    expect(groups.map((g) => [g.key, g.label, g.preset])).toEqual([
      ['milestone:m-1', 'Payments › Beta', { epic: 'm-1' }],
      ['epic:none', 'No milestone', {}],
    ]);
    expect(groups[0]?.rows.map((r) => r.doc.meta.id)).toEqual(['t-2']);
    expect(groups[1]?.rows.map((r) => r.doc.meta.id)).toEqual(['t-7']);
  });

  test('showSubtasks off hides sub-issues even though their parent has children', () => {
    const groups = groupTasks(
      all,
      prefs({ grouping: 'milestone', showSubtasks: false }),
      { statuses: STATUSES, epics }
    );
    expect(groups.flatMap((g) => g.rows.map((r) => r.doc.meta.id))).toEqual([
      't-4',
      't-1',
      't-5',
      't-6',
    ]);
  });
});

describe('groupTasks by assignee, priority and none', () => {
  test('assignee: agents, then people, then unassigned', () => {
    const groups = groupTasks(
      [
        task('a', { assignee: 'none' }),
        task('b', { assignee: 'human' }),
        task('c', { assignee: 'agent' }),
      ],
      prefs({ grouping: 'assignee' }),
      { statuses: STATUSES, epics: [] }
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Agent',
      'Human',
      'Unassigned',
    ]);
  });

  test('priority: urgent first, empties dropped unless shown', () => {
    const tasks = [
      task('a', { priority: 'low' }),
      task('b', { priority: 'urgent' }),
    ];
    expect(
      groupTasks(tasks, prefs({ grouping: 'priority' }), {
        statuses: STATUSES,
        epics: [],
      }).map((g) => g.label)
    ).toEqual(['Urgent', 'Low']);
    expect(
      groupTasks(
        tasks,
        prefs({ grouping: 'priority', showEmptyGroups: true }),
        { statuses: STATUSES, epics: [] }
      ).map((g) => g.key)
    ).toEqual([
      'priority:urgent',
      'priority:high',
      'priority:medium',
      'priority:low',
      'priority:none',
    ]);
  });

  test('none: one headerless group', () => {
    const groups = groupTasks(
      [task('a'), task('b')],
      prefs({ grouping: 'none' }),
      {
        statuses: STATUSES,
        epics: [],
      }
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'all', kind: 'none', icon: null });
  });
});

describe('sortTasks', () => {
  const urgent = task('u', {
    priority: 'urgent',
    updated: '2026-09-02T12:00:00.000Z',
  });
  const low = task('l', {
    priority: 'low',
    updated: '2026-09-03T12:00:00.000Z',
  });
  const none = task('n', {
    priority: 'none',
    updated: '2026-09-01T12:00:00.000Z',
  });

  test('priority ascending is urgent first; desc reverses', () => {
    expect(
      sortTasks([low, none, urgent], prefs()).map((t) => t.meta.id)
    ).toEqual(['u', 'l', 'n']);
    expect(
      sortTasks([low, none, urgent], prefs({ orderDir: 'desc' })).map(
        (t) => t.meta.id
      )
    ).toEqual(['n', 'l', 'u']);
  });

  test('updated is newest first; title is A→Z; manual keeps input order', () => {
    expect(
      sortTasks([urgent, low, none], prefs({ ordering: 'updated' })).map(
        (t) => t.meta.id
      )
    ).toEqual(['l', 'u', 'n']);
    const b = task('b', {}, 'Beta');
    const a = task('a', {}, 'alpha');
    expect(
      sortTasks([b, a], prefs({ ordering: 'title' })).map((t) => t.meta.id)
    ).toEqual(['a', 'b']);
    expect(
      sortTasks([low, urgent], prefs({ ordering: 'manual' })).map(
        (t) => t.meta.id
      )
    ).toEqual(['l', 'u']);
  });

  test("completedByRecency reads the project's own status types", () => {
    setActiveStatusModel(
      statusModelOf({
        statuses: ['Todo', 'Done', 'Canceled'],
        statusDefinitions: [
          { name: 'Todo', type: 'unstarted', color: null },
          { name: 'Done', type: 'completed', color: null },
          { name: 'Canceled', type: 'canceled', color: null },
        ],
      })
    );
    const done = task('d', { status: 'Done', priority: 'urgent' });
    const canceled = task('c', { status: 'Canceled', priority: 'urgent' });
    const todo = task('o', { status: 'Todo', priority: 'low' });
    expect(
      sortTasks([done, canceled, todo], prefs()).map((t) => t.meta.id)
    ).toEqual(['o', 'd', 'c']);
  });

  test('a passed model beats the open project’s, which may not be set yet', () => {
    const linear = statusModelOf({
      statuses: ['Todo', 'Done'],
      statusDefinitions: [
        { name: 'Todo', type: 'unstarted', color: null },
        { name: 'Done', type: 'completed', color: null },
      ],
      statusRoles: {
        ready: 'Todo',
        dispatched: 'Todo',
        review: 'Todo',
        landing: null,
        landed: 'Done',
        dropped: 'Done',
      },
    });
    const done = task('d', { status: 'Done', priority: 'urgent' });
    const todo = task('o', { status: 'Todo', priority: 'low' });
    expect(
      sortTasks([done, todo], prefs(), linear).map((t) => t.meta.id)
    ).toEqual(['o', 'd']);
    const milestone = task('m', { kind: 'milestone' });
    const groups = groupTasks(
      [
        milestone,
        task('a', { parent: 'm', status: 'Done' }),
        task('b', { status: 'Todo', parent: 'n' }),
      ],
      prefs({ grouping: 'milestone' }),
      {
        statuses: ['Todo', 'Done'],
        epics: [milestone, task('n', { kind: 'milestone' })],
        model: linear,
      }
    );
    // Finished under the passed model: it sinks below the open one and wears Done.
    expect(groups.map((g) => g.key)).toEqual(['milestone:n', 'milestone:m']);
    expect(groups[1]?.icon).toEqual({ kind: 'milestone', status: 'Done' });
    expect(groups[1]?.tint).toBe('var(--status-done)');
  });

  test('completedByRecency sinks landed/dropped below open rows, newest first', () => {
    const doneOld = task('d1', {
      status: 'landed',
      priority: 'urgent',
      updated: '2026-08-01T12:00:00.000Z',
    });
    const doneNew = task('d2', {
      status: 'dropped',
      priority: 'urgent',
      updated: '2026-08-05T12:00:00.000Z',
    });
    expect(
      sortTasks([doneOld, doneNew, low], prefs()).map((t) => t.meta.id)
    ).toEqual(['l', 'd2', 'd1']);
    expect(
      sortTasks(
        [doneOld, doneNew, low],
        prefs({ completedByRecency: false })
      ).map((t) => t.meta.id)
    ).toEqual(['d1', 'd2', 'l']);
  });
});

describe('visibleRowIds', () => {
  test('walks expanded groups only', () => {
    const groups = groupTasks(
      [task('a', { status: 'ready' }), task('b', { status: 'working' })],
      prefs(),
      { statuses: STATUSES, epics: [] }
    );
    expect(visibleRowIds(groups, new Set())).toEqual(['a', 'b']);
    expect(visibleRowIds(groups, new Set(['status:ready']))).toEqual(['b']);
  });
});
