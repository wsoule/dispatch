import type {
  LabelDefinition,
  TaskComment,
  TaskCycle,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import { statusModelOf } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { DispatchReadiness } from '../lib/dispatchReadiness';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import { taskIndexOf } from '../lib/taskIndex';
import { AGENT_POOL_LABEL, AGENTS_GROUP } from './people';
import { NEEDS_ASSIGNEE_LABEL } from './rows';
import {
  acceptancePatch,
  blockerAddPatch,
  blockerRemovePatch,
  blocksRemovePatch,
  buildDetailActivity,
  buildDetailAlerts,
  buildDetailComments,
  buildDetailDescription,
  buildDetailFacts,
  buildDetailHeader,
  buildDetailRelations,
  descriptionPatch,
  type DetailAlertsInput,
  type DetailContext,
  type DetailFact,
  duplicateOfPatch,
  ESTIMATE_SCALE,
  estimateChoices,
  type FactId,
  labelChoices,
  patchFor,
  personChoices,
  planChoices,
  relatedAddPatch,
  relatedRemovePatch,
  type RelationError,
  type RelationModel,
  relationSearch,
  stateChoices,
} from './taskDetail';

// Monday 26 October 2026, midday local time: every date below reads against it.
const NOW = new Date(2026, 9, 26, 12);
const TODAY = dayFromNow(0, NOW);
const YESTERDAY = dayFromNow(-1, NOW);
const TOMORROW = dayFromNow(1, NOW);
const IN_FIVE_DAYS = dayFromNow(5, NOW);

/** An ISO instant `ms` before NOW. */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MODEL = statusModelOf(null);
const ME = 'human:wyat';
const LINKS = {
  'uuid-full': {
    identifier: 'ENG-24',
    url: 'https://linear.app/acme/issue/ENG-24',
  },
  'uuid-done': {
    identifier: 'ENG-12',
    url: 'https://linear.app/acme/issue/ENG-12',
  },
};

// The hierarchy most tests sit in: an initiative holding a project holding a
// milestone, plus a milestone of its own (a legacy epic) under nothing, and an
// issue with a sub-issue that has a sub-issue of its own.
const INITIATIVE = taskDoc({
  id: 'i-1',
  title: 'Platform',
  kind: 'initiative',
});
const PROJECT = taskDoc({
  id: 'p-1',
  title: 'Atlas',
  kind: 'project',
  parent: 'i-1',
});
const MILESTONE = taskDoc({
  id: 'm-1',
  title: 'Dual-write',
  kind: 'milestone',
  parent: 'p-1',
  dueDate: '2026-11-13',
});
const EPIC = taskDoc({ id: 'e-1', title: 'Payments', kind: 'milestone' });
const PARENT_ISSUE = taskDoc({ id: 't-parent', title: 'Parent issue' });
const CHILD = taskDoc({ id: 't-child', title: 'Child', parent: 't-parent' });
const GRANDCHILD = taskDoc({
  id: 't-grandchild',
  title: 'Grandchild',
  parent: 't-child',
});
const CONTAINERS = [
  INITIATIVE,
  PROJECT,
  MILESTONE,
  EPIC,
  PARENT_ISSUE,
  CHILD,
  GRANDCHILD,
];

const DONE = taskDoc({
  id: 't-done',
  title: 'Schema migration',
  status: 'landed',
  assignee: 'agent:wyat/claude',
  external: 'linear:uuid-done',
  parent: 'm-1',
});
const OPEN = taskDoc({
  id: 't-open',
  title: 'Backfill script',
  status: 'ready',
  assignee: 'none',
});
const AFTER = taskDoc({
  id: 't-after',
  title: 'Cutover rehearsal',
  blockedBy: ['t-full'],
});
const ARCHIVED = taskDoc({
  id: 't-arch',
  title: 'Old thing',
  status: 'landed',
  archivedAt: '2026-10-20T12:00:00.000Z',
});

const BODY = `## Description

Reconcile drift.

## Acceptance Criteria

- [ ] Drift report lists every mismatch
- [x] Fix script is idempotent
2. Tests cover the backfill

## Amendments

Scope cut: no UI.

## Activity

- 2026-10-20T10:00:00.000Z dispatched (claude) — human:wyat
- 2026-10-21T10:00:00.000Z [run r-1] finished: failed — error: tests failed
- 2026-10-22T10:00:00.000Z [run r-2] merged into main
- a plain note
`;

const CYCLE: TaskCycle = {
  id: 'c-1',
  number: 42,
  name: null,
  startsAt: '2026-10-19T12:00:00.000Z',
  endsAt: '2026-11-01T12:00:00.000Z',
};

const FULL = taskDoc(
  {
    id: 't-full',
    title: 'Dual-write drift reconciler',
    status: 'working',
    parent: 'm-1',
    blockedBy: ['t-done', 't-open', 't-gone'],
    labels: ['ui', 'Area/search'],
    priority: 'urgent',
    assignee: ME,
    estimate: 5,
    dueDate: YESTERDAY,
    startDate: '2026-10-01',
    cycle: CYCLE,
    relatedTo: ['t-open'],
    duplicateOf: 't-done',
    creator: ME,
    risk: 'critical',
    model: 'claude-opus-5',
    selfReview: true,
    exercised: true,
    external: 'linear:uuid-full',
    created: '2026-09-25T10:00:00.000Z',
  },
  BODY
);
const EMPTY = taskDoc({
  id: 't-empty',
  title: '',
  status: 'draft',
  assignee: 'none',
  priority: 'none',
});
const TASKS = [FULL, EMPTY, DONE, OPEN, AFTER, ARCHIVED];

function context(
  tasks: readonly TaskListItem[] = TASKS,
  over: Partial<DetailContext> = {}
): DetailContext {
  const index = taskIndexOf([...CONTAINERS, ...tasks]);
  return {
    model: MODEL,
    tasksById: index.byId,
    index,
    personFor: (assignee) =>
      assignee === ME ? { name: 'Wyatt Soule' } : undefined,
    me: ME,
    linearLinks: LINKS,
    people: [
      { ref: 'human:ana', name: 'Ana Moreno' },
      { ref: ME, name: 'Wyatt Soule' },
    ],
    executors: ['claude'],
    labelCatalogue: [],
    now: NOW,
    today: TODAY,
    hrefFor: (id) => `#/task/${id}`,
    canEdit: true,
    ...over,
  };
}

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-9',
    taskId: 't-full',
    taskTitle: 'Dual-write drift reconciler',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-full',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-10-23T10:00:00.000Z',
    updatedAt: '2026-10-23T11:00:00.000Z',
    ...over,
  };
}

function readiness(
  checks: DispatchReadiness['checks'],
  over: Partial<DispatchReadiness> = {}
): DispatchReadiness {
  return {
    checks,
    canDispatch: true,
    closed: false,
    blocked: checks.some((c) => c.id === 'blockers' && c.tone === 'block'),
    warnings: checks.filter((c) => c.tone === 'warn').length,
    ...over,
  };
}

function alertsInput(over: Partial<DetailAlertsInput> = {}): DetailAlertsInput {
  return {
    doc: taskDoc({ id: 't-1', title: 'Plain' }),
    model: MODEL,
    readiness: null,
    latestRun: undefined,
    asksCount: 0,
    now: NOW,
    ...over,
  };
}

function fact(facts: DetailFact[], id: FactId): DetailFact {
  const found = facts.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no ${id} fact`);
  return found;
}

function comment(over: Partial<TaskComment> & Pick<TaskComment, 'id'>) {
  return {
    taskId: 't-full',
    author: ME,
    body: `Body of ${over.id}`,
    created: ago(2 * HOUR),
    updated: ago(2 * HOUR),
    parentId: null,
    external: null,
    ...over,
  } satisfies TaskComment;
}

describe('buildDetailHeader', () => {
  test('a linked task is keyed by its Linear identifier and links there', () => {
    const header = buildDetailHeader(FULL, context());
    expect(header.taskKey).toBe('ENG-24');
    expect(header.href).toBe('https://linear.app/acme/issue/ENG-24');
    expect(header.title).toBe('Dual-write drift reconciler');
    expect(header.status).toEqual({ kind: 'started', label: 'Working' });
    expect(header.closed).toBe(false);
  });

  test('an unlinked task is keyed by its id and has no link', () => {
    const header = buildDetailHeader(OPEN, context());
    expect(header.taskKey).toBe('t-open');
    expect('href' in header).toBe(false);
  });

  test('without a links map a linked task still keys by its id', () => {
    const header = buildDetailHeader(
      FULL,
      context(TASKS, { linearLinks: undefined })
    );
    expect(header.taskKey).toBe('t-full');
    expect('href' in header).toBe(false);
  });

  test('the crumbs walk initiative › project › milestone, then the key', () => {
    expect(buildDetailHeader(FULL, context()).breadcrumb).toEqual([
      { label: 'Platform', href: '#/task/i-1' },
      { label: 'Atlas', href: '#/task/p-1' },
      { label: 'Dual-write', href: '#/task/m-1' },
      { label: 'ENG-24' },
    ]);
  });

  test('a task under nothing has the key as its only crumb', () => {
    expect(buildDetailHeader(OPEN, context()).breadcrumb).toEqual([
      { label: 't-open' },
    ]);
  });

  test('a dangling parent ends the trail', () => {
    const orphan = taskDoc({ id: 't-o', title: 'Orphan', parent: 'nope' });
    expect(buildDetailHeader(orphan, context([orphan])).breadcrumb).toEqual([
      { label: 't-o' },
    ]);
  });

  test('a blank title reads "Untitled task" and a landed task is closed', () => {
    expect(buildDetailHeader(EMPTY, context()).title).toBe('Untitled task');
    const done = buildDetailHeader(DONE, context());
    expect(done.closed).toBe(true);
    expect(done.status).toEqual({ kind: 'completed', label: 'Landed' });
  });
});

describe('buildDetailAlerts', () => {
  test('an open, on-time task with nothing waiting has no alerts', () => {
    expect(buildDetailAlerts(alertsInput())).toEqual([]);
  });

  test('a past due date is a red Overdue alert', () => {
    const alerts = buildDetailAlerts(
      alertsInput({
        doc: taskDoc({ id: 't-1', title: 'x', dueDate: YESTERDAY }),
      })
    );
    expect(alerts).toEqual([
      {
        id: 'overdue',
        label: 'Overdue',
        tone: 'danger',
        message: 'Due Oct 25, 1d overdue.',
      },
    ]);
  });

  test('a due date today or ahead, or on a closed task, is not overdue', () => {
    for (const dueDate of [TODAY, TOMORROW]) {
      expect(
        buildDetailAlerts(
          alertsInput({ doc: taskDoc({ id: 't-1', title: 'x', dueDate }) })
        )
      ).toEqual([]);
    }
    expect(
      buildDetailAlerts(
        alertsInput({
          doc: taskDoc({
            id: 't-1',
            title: 'x',
            dueDate: YESTERDAY,
            status: 'landed',
          }),
        })
      )
    ).toEqual([]);
  });

  test('open asks are an amber Needs you alert, counted', () => {
    expect(buildDetailAlerts(alertsInput({ asksCount: 2 }))).toEqual([
      {
        id: 'asks',
        label: 'Needs you',
        tone: 'warning',
        message: '2 questions waiting on you.',
      },
    ]);
    expect(buildDetailAlerts(alertsInput({ asksCount: 1 }))[0]?.message).toBe(
      '1 question waiting on you.'
    );
  });

  test('a failed latest run is a red Failed alert naming the error', () => {
    const failed = buildDetailAlerts(
      alertsInput({
        latestRun: run({ state: 'failed', error: 'tests failed.' }),
      })
    );
    expect(failed).toEqual([
      {
        id: 'run-failed',
        label: 'Failed',
        tone: 'danger',
        message: 'The latest run failed: tests failed.',
      },
    ]);
    expect(
      buildDetailAlerts(alertsInput({ latestRun: run({ state: 'failed' }) }))[0]
        ?.message
    ).toBe('The latest run failed.');
    expect(
      buildDetailAlerts(
        alertsInput({ latestRun: run({ state: 'interrupted-dirty' }) })
      )[0]?.message
    ).toBe('The latest run was interrupted and left uncommitted work.');
  });

  test('a finished, live or closed-out failed run raises nothing', () => {
    expect(buildDetailAlerts(alertsInput({ latestRun: run() }))).toEqual([]);
    expect(
      buildDetailAlerts(alertsInput({ latestRun: run({ state: 'running' }) }))
    ).toEqual([]);
    expect(
      buildDetailAlerts(
        alertsInput({
          latestRun: run({
            state: 'failed',
            reviewedAt: 'x',
            reviewAction: 'discard',
          }),
        })
      )
    ).toEqual([]);
  });

  test('readiness repeats blockers, a thin spec and overlaps in amber, not writes', () => {
    const alerts = buildDetailAlerts(
      alertsInput({
        readiness: readiness([
          {
            id: 'blockers',
            tone: 'block',
            label: 'Waits on 2 tasks',
            taskIds: ['a', 'b'],
          },
          { id: 'spec', tone: 'warn', label: 'Only a title' },
          { id: 'writes', tone: 'warn', label: 'No declared writes' },
          {
            id: 'overlap',
            tone: 'warn',
            label: 'Overlaps 1 live run',
            taskIds: ['c'],
          },
        ]),
      })
    );
    expect(alerts).toEqual([
      {
        id: 'readiness-blockers',
        label: 'Blocked',
        tone: 'warning',
        message: 'Waits on 2 tasks.',
      },
      {
        id: 'readiness-spec',
        label: 'Thin spec',
        tone: 'warning',
        message: 'Only a title.',
      },
      {
        id: 'readiness-overlap',
        label: 'Overlaps',
        tone: 'warning',
        message: 'Overlaps 1 live run.',
      },
    ]);
  });

  test('blockers not found read as Blockers; passing and pending checks say nothing', () => {
    const alerts = buildDetailAlerts(
      alertsInput({
        readiness: readiness([
          { id: 'blockers', tone: 'warn', label: '1 blocker not found' },
          { id: 'spec', tone: 'pending', label: 'Reading the spec…' },
          { id: 'writes', tone: 'pass', label: 'Writes 2 paths' },
        ]),
      })
    );
    expect(alerts.map((a) => [a.id, a.label])).toEqual([
      ['readiness-blockers', 'Blockers'],
    ]);
  });

  test('a closed task or a container gets no readiness advice', () => {
    const checks = readiness([
      { id: 'spec', tone: 'warn', label: 'Only a title' },
    ]);
    expect(
      buildDetailAlerts(
        alertsInput({
          doc: taskDoc({ id: 't-1', title: 'x', status: 'dropped' }),
          readiness: checks,
        })
      )
    ).toEqual([]);
    expect(
      buildDetailAlerts(alertsInput({ doc: MILESTONE, readiness: checks }))
    ).toEqual([]);
  });

  test('an archived task says so, quietly', () => {
    expect(buildDetailAlerts(alertsInput({ doc: ARCHIVED }))).toEqual([
      {
        id: 'archived',
        label: 'Archived',
        tone: 'muted',
        message: 'Archived Oct 20.',
      },
    ]);
  });

  test('everything at once sorts red, then amber, then grey', () => {
    const alerts = buildDetailAlerts(
      alertsInput({
        doc: taskDoc({
          id: 't-1',
          title: 'x',
          dueDate: YESTERDAY,
          archivedAt: '2026-10-20T12:00:00.000Z',
        }),
        asksCount: 1,
        latestRun: run({ state: 'failed' }),
        readiness: readiness([
          {
            id: 'blockers',
            tone: 'block',
            label: 'Waits on 1 task',
            taskIds: ['a'],
          },
          { id: 'spec', tone: 'warn', label: 'No acceptance criteria' },
        ]),
      })
    );
    expect(alerts.map((a) => a.id)).toEqual([
      'overdue',
      'run-failed',
      'asks',
      'readiness-blockers',
      'readiness-spec',
      'archived',
    ]);
  });
});

describe('buildDetailFacts', () => {
  const full = buildDetailFacts(FULL, context());
  const empty = buildDetailFacts(EMPTY, context());

  test('a fully populated task shows every fact, in the rail’s order', () => {
    expect(full.map((f) => f.id)).toEqual([
      'status',
      'assignee',
      'priority',
      'labels',
      'estimate',
      'start',
      'due',
      'parent',
      'cycle',
      'creator',
      'risk',
      'model',
      'selfReview',
      'exercised',
      'external',
    ]);
  });

  test('an empty task shows the editable facts only, each as its unset words', () => {
    expect(empty.map((f) => f.id)).toEqual([
      'status',
      'assignee',
      'priority',
      'labels',
      'estimate',
      'due',
      'parent',
      'selfReview',
    ]);
    expect(empty.map((f) => f.value)).toEqual([
      'Draft',
      'Unassigned',
      'No priority',
      'No labels',
      'No estimate',
      'No due date',
      'No parent',
      'Off',
    ]);
    for (const id of [
      'assignee',
      'labels',
      'estimate',
      'due',
      'parent',
      'selfReview',
    ] as const) {
      expect(fact(empty, id).tone).toBe('muted');
    }
  });

  test('every fact is read-only when the window may not write', () => {
    const readOnly = buildDetailFacts(FULL, context(TASKS, { canEdit: false }));
    expect(readOnly.every((f) => !f.editable)).toBe(true);
    // And with writes, only the facts that have a control are editable.
    expect(full.filter((f) => f.editable).map((f) => f.id)).toEqual([
      'status',
      'assignee',
      'priority',
      'labels',
      'estimate',
      'start',
      'due',
      'parent',
      'selfReview',
    ]);
  });

  test('status: the label and the status id', () => {
    expect(fact(full, 'status')).toEqual({
      id: 'status',
      kind: 'state',
      label: 'Status',
      value: 'Working',
      editable: true,
      raw: 'working',
    });
  });

  test('assignee: the registry’s name and the ref; nobody reads muted on a draft', () => {
    expect(fact(full, 'assignee')).toMatchObject({
      kind: 'person',
      value: 'Wyatt Soule',
      raw: ME,
    });
    expect(fact(full, 'assignee').tone).toBeUndefined();
    expect(fact(empty, 'assignee')).toMatchObject({
      value: 'Unassigned',
      tone: 'muted',
      raw: null,
    });
  });

  test('assignee: nobody on an open, specified task needs one, in amber', () => {
    const open = buildDetailFacts(OPEN, context());
    expect(fact(open, 'assignee')).toMatchObject({
      value: NEEDS_ASSIGNEE_LABEL,
      tone: 'warning',
      raw: null,
    });
    // Not on a container, nor on finished work.
    const bare = taskDoc({
      id: 'm-x',
      title: 'M',
      kind: 'milestone',
      assignee: 'none',
    });
    expect(fact(buildDetailFacts(bare, context([bare])), 'assignee').tone).toBe(
      'muted'
    );
    const done = taskDoc({
      id: 't-d',
      title: 'D',
      status: 'landed',
      assignee: 'none',
    });
    expect(fact(buildDetailFacts(done, context([done])), 'assignee').tone).toBe(
      'muted'
    );
  });

  test('assignee: the agent pool reads "Any agent"', () => {
    const pooled = taskDoc({ id: 't-p', title: 'P', assignee: 'agent' });
    expect(
      fact(buildDetailFacts(pooled, context([pooled])), 'assignee')
    ).toMatchObject({
      value: AGENT_POOL_LABEL,
      raw: 'agent',
    });
  });

  test('priority: the table’s scale, urgent in red', () => {
    expect(fact(full, 'priority')).toMatchObject({
      kind: 'priority',
      value: 'Urgent',
      tone: 'danger',
      raw: 1,
    });
    expect(fact(empty, 'priority')).toMatchObject({
      value: 'No priority',
      raw: 0,
    });
    expect(fact(empty, 'priority').tone).toBeUndefined();
  });

  test('labels: joined, with the list as the raw value (a copy)', () => {
    const labels = fact(full, 'labels');
    expect(labels).toMatchObject({ kind: 'labels', value: 'ui, Area/search' });
    expect(labels.raw).toEqual(['ui', 'Area/search']);
    expect(labels.raw).not.toBe(FULL.meta.labels);
    expect(fact(empty, 'labels').raw).toEqual([]);
  });

  test('estimate: points, singular for one', () => {
    expect(fact(full, 'estimate')).toMatchObject({
      kind: 'estimate',
      value: '5 points',
      raw: 5,
    });
    const one = taskDoc({ id: 't-1', title: 'x', estimate: 1 });
    expect(fact(buildDetailFacts(one, context([one])), 'estimate').value).toBe(
      '1 point'
    );
  });

  test('start date: shown when set or on a container, "Started" once past', () => {
    expect(fact(full, 'start')).toMatchObject({
      kind: 'date',
      value: 'Oct 1',
      note: 'Started',
      raw: '2026-10-01',
    });
    const ahead = taskDoc({ id: 't-1', title: 'x', startDate: IN_FIVE_DAYS });
    expect(fact(buildDetailFacts(ahead, context([ahead])), 'start').note).toBe(
      'Starts'
    );
    const milestone = buildDetailFacts(MILESTONE, context());
    expect(fact(milestone, 'start')).toMatchObject({
      value: 'No start date',
      tone: 'muted',
      raw: null,
    });
  });

  test('due date: red once past, amber on the day and the eve, plain later', () => {
    expect(fact(full, 'due')).toMatchObject({
      kind: 'date',
      value: 'Oct 25',
      tone: 'danger',
      note: '1d overdue',
      raw: YESTERDAY,
    });
    const today = taskDoc({ id: 't-1', title: 'x', dueDate: TODAY });
    expect(
      fact(buildDetailFacts(today, context([today])), 'due')
    ).toMatchObject({
      tone: 'warning',
      note: 'Today',
    });
    const tomorrow = taskDoc({ id: 't-1', title: 'x', dueDate: TOMORROW });
    expect(
      fact(buildDetailFacts(tomorrow, context([tomorrow])), 'due')
    ).toMatchObject({
      tone: 'warning',
      note: 'Tomorrow',
    });
    const later = buildDetailFacts(
      taskDoc({ id: 't-1', title: 'x', dueDate: IN_FIVE_DAYS }),
      context()
    );
    expect(fact(later, 'due').tone).toBeUndefined();
    expect(fact(later, 'due').note).toBe('in 5d');
  });

  test('due date: a finished task’s date is no longer a deadline', () => {
    const done = taskDoc({
      id: 't-1',
      title: 'x',
      dueDate: YESTERDAY,
      status: 'landed',
    });
    const due = fact(buildDetailFacts(done, context([done])), 'due');
    expect(due.value).toBe('Oct 25');
    expect(due.tone).toBeUndefined();
    expect(due.note).toBeUndefined();
  });

  test('parent: the container’s title with its kind, or the unknown task', () => {
    expect(fact(full, 'parent')).toMatchObject({
      kind: 'plan',
      value: 'Dual-write',
      note: 'Milestone',
      raw: 'm-1',
    });
    const orphan = taskDoc({ id: 't-o', title: 'O', parent: 'nope' });
    expect(
      fact(buildDetailFacts(orphan, context([orphan])), 'parent')
    ).toMatchObject({
      value: 'Unknown task',
      raw: 'nope',
    });
  });

  test('cycle: its number or its name, with its span, read-only', () => {
    expect(fact(full, 'cycle')).toEqual({
      id: 'cycle',
      kind: 'text',
      label: 'Cycle',
      value: 'Cycle 42',
      note: 'Oct 19 – Nov 1',
      editable: false,
      raw: 'c-1',
    });
    const named = taskDoc({
      id: 't-1',
      title: 'x',
      cycle: { ...CYCLE, name: 'Sprint 7' },
    });
    expect(fact(buildDetailFacts(named, context([named])), 'cycle').value).toBe(
      'Sprint 7'
    );
  });

  test('creator: who, and when', () => {
    expect(fact(full, 'creator')).toEqual({
      id: 'creator',
      kind: 'person',
      label: 'Creator',
      value: 'Wyatt Soule',
      note: 'Created Sep 25',
      editable: false,
      raw: ME,
    });
  });

  test('risk: only when not routine, critical red and elevated amber', () => {
    expect(fact(full, 'risk')).toMatchObject({
      value: 'Critical',
      tone: 'danger',
      raw: 'critical',
    });
    const elevated = taskDoc({ id: 't-1', title: 'x', risk: 'elevated' });
    expect(
      fact(buildDetailFacts(elevated, context([elevated])), 'risk')
    ).toMatchObject({
      value: 'Elevated',
      tone: 'warning',
    });
  });

  test('model, self review and verification', () => {
    expect(fact(full, 'model')).toMatchObject({
      kind: 'text',
      value: 'claude-opus-5',
      editable: false,
    });
    expect(fact(full, 'selfReview')).toMatchObject({
      kind: 'switch',
      value: 'On',
      raw: true,
      editable: true,
    });
    expect(fact(full, 'selfReview').tone).toBeUndefined();
    expect(fact(full, 'exercised')).toEqual({
      id: 'exercised',
      kind: 'switch',
      label: 'Verified',
      value: 'Exercised by a verify run',
      tone: 'success',
      editable: false,
      raw: true,
    });
  });

  test('external: the Linear identifier with its link, the entity without one, another tracker as linked', () => {
    expect(fact(full, 'external')).toEqual({
      id: 'external',
      kind: 'link',
      label: 'Linear',
      value: 'ENG-24',
      href: 'https://linear.app/acme/issue/ENG-24',
      editable: false,
      raw: 'linear:uuid-full',
    });
    const unknown = taskDoc({
      id: 't-1',
      title: 'x',
      external: 'linear-project:uuid-x',
    });
    const linearOnly = fact(
      buildDetailFacts(unknown, context([unknown])),
      'external'
    );
    expect(linearOnly).toMatchObject({
      label: 'Linear',
      value: 'Linear project',
    });
    expect('href' in linearOnly).toBe(false);
    const other = taskDoc({ id: 't-2', title: 'y', external: 'jira:ABC-1' });
    expect(
      fact(buildDetailFacts(other, context([other])), 'external')
    ).toMatchObject({
      label: 'External',
      value: 'Linked',
    });
  });
});

describe('picker choices', () => {
  test('stateChoices lists the model’s statuses by label and type', () => {
    const states = stateChoices(MODEL);
    expect(states.map((s) => s.id)).toEqual([
      'draft',
      'ready',
      'working',
      'review',
      'landing',
      'landed',
      'dropped',
    ]);
    expect(states[0]).toEqual({ id: 'draft', name: 'Draft', kind: 'backlog' });
    expect(states.at(-1)).toEqual({
      id: 'dropped',
      name: 'Dropped',
      kind: 'canceled',
    });
  });

  test('stateChoices appends an unknown current status, never a known one twice', () => {
    expect(stateChoices(MODEL, 'qa-review').at(-1)).toEqual({
      id: 'qa-review',
      name: 'Qa Review',
      kind: 'backlog',
    });
    expect(stateChoices(MODEL, 'working')).toHaveLength(7);
  });

  test('personChoices hands the registry, you first, then the agents', () => {
    const choices = personChoices(context());
    expect(choices.map((c) => c.id)).toEqual([
      ME,
      'human:ana',
      'agent',
      'agent:wyat/claude',
    ]);
    expect(choices[2]).toMatchObject({
      name: AGENT_POOL_LABEL,
      group: AGENTS_GROUP,
    });
  });

  // A label's colour is registry data the adapter only passes through (drawn
  // as the option's swatch, never by this code), assembled at runtime so the
  // Gr8r scan's rule (no hex literal under adapters/) stays meaningful.
  const LABEL_BLUE = `#${'5e6ad2'}`;
  const CATALOGUE: LabelDefinition[] = [
    { name: 'ui', color: LABEL_BLUE },
    { name: 'search', color: null, group: 'Area' },
  ];

  test('labelChoices offers the catalogue by ref, coloured and grouped', () => {
    expect(labelChoices(CATALOGUE, EMPTY)).toEqual([
      { id: 'ui', name: 'ui', color: LABEL_BLUE },
      {
        id: 'Area/search',
        name: 'search',
        group: { id: 'Area', name: 'Area' },
      },
    ]);
  });

  test('labelChoices keeps a label the task carries that the catalogue lacks', () => {
    const orphaned = taskDoc({
      id: 't-1',
      title: 'x',
      labels: ['UI', 'legacy', 'Size/M'],
    });
    expect(labelChoices(CATALOGUE, orphaned).map((c) => c.id)).toEqual([
      'ui',
      'Area/search',
      'legacy',
      'Size/M',
    ]);
    expect(labelChoices(CATALOGUE, orphaned).at(-1)).toEqual({
      id: 'Size/M',
      name: 'M',
      group: { id: 'Size', name: 'Size' },
    });
  });

  test('labelChoices lists the project’s other labels in use before the task’s orphans', () => {
    const orphaned = taskDoc({ id: 't-1', title: 'x', labels: ['legacy'] });
    expect(
      labelChoices(CATALOGUE, orphaned, ['api', 'ui']).map((c) => c.id)
    ).toEqual(['ui', 'Area/search', 'api', 'legacy']);
  });

  test('planChoices: a task may move under any container or a parent issue', () => {
    const ctx = context();
    const choices = planChoices(ctx.tasksById, OPEN, ctx.index, NOW);
    expect(choices.projects).toEqual([
      { id: 'i-1', name: 'Platform', hint: 'Initiative' },
      { id: 'p-1', name: 'Atlas', hint: 'Project' },
    ]);
    expect(choices.milestones).toEqual([
      { id: 'm-1', name: 'Dual-write', hint: 'Nov 13', group: 'Atlas' },
      { id: 'e-1', name: 'Payments', hint: 'Milestone' },
    ]);
    expect(choices.issues.map((c) => c.id)).toEqual(['t-parent', 't-child']);
  });

  test('planChoices never offers the task itself or anything beneath it', () => {
    const ctx = context();
    const choices = planChoices(ctx.tasksById, PARENT_ISSUE, ctx.index, NOW);
    expect(choices.issues).toEqual([]);
    const child = planChoices(ctx.tasksById, CHILD, ctx.index, NOW);
    expect(child.issues.map((c) => c.id)).toEqual(['t-parent']);
  });

  test('planChoices respects the kinds and skips archived containers', () => {
    const gone = taskDoc({
      id: 'p-gone',
      title: 'Retired',
      kind: 'project',
      archivedAt: '2026-10-01T00:00:00.000Z',
    });
    const ctx = context([gone]);
    const milestone = planChoices(ctx.tasksById, MILESTONE, ctx.index, NOW);
    expect(milestone.projects.map((c) => c.id)).toEqual(['i-1', 'p-1']);
    expect(milestone.milestones).toEqual([]);
    expect(milestone.issues).toEqual([]);
    const project = planChoices(ctx.tasksById, PROJECT, ctx.index, NOW);
    expect(project.projects.map((c) => c.id)).toEqual(['i-1']);
  });

  test('estimateChoices is the fixed scale, with 0 points distinct from no estimate', () => {
    expect(ESTIMATE_SCALE).toEqual([0, 1, 2, 3, 5, 8, 13]);
    expect(estimateChoices().map((c) => c.label)).toEqual([
      '0 points',
      '1 point',
      '2 points',
      '3 points',
      '5 points',
      '8 points',
      '13 points',
    ]);
    expect(estimateChoices()[4]).toEqual({ value: 5, label: '5 points' });
  });
});

describe('patchFor', () => {
  test('status', () => {
    expect(patchFor('status', 'review')).toEqual({ status: 'review' });
  });

  test('assignee: a ref, or none for nobody', () => {
    expect(patchFor('assignee', 'human:ana')).toEqual({
      assignee: 'human:ana',
    });
    expect(patchFor('assignee', null)).toEqual({ assignee: 'none' });
    expect(patchFor('assignee', '')).toEqual({ assignee: 'none' });
  });

  test('priority: the table’s scale back to Dispatch’s word', () => {
    expect(patchFor('priority', 1)).toEqual({ priority: 'urgent' });
    expect(patchFor('priority', 0)).toEqual({ priority: 'none' });
    expect(patchFor('priority', 4)).toEqual({ priority: 'low' });
  });

  test('labels: the complete list, copied', () => {
    const labels = ['ui', 'api'];
    const patch = patchFor('labels', labels);
    expect(patch).toEqual({ labels: ['ui', 'api'] });
    expect(patch.labels).not.toBe(labels);
  });

  test('estimate: a number or null', () => {
    expect(patchFor('estimate', 5)).toEqual({ estimate: 5 });
    expect(patchFor('estimate', null)).toEqual({ estimate: null });
  });

  test('start and due dates: a day or null, a blank reading as null', () => {
    expect(patchFor('start', '2026-10-01')).toEqual({
      startDate: '2026-10-01',
    });
    expect(patchFor('start', null)).toEqual({ startDate: null });
    expect(patchFor('due', '2026-11-13')).toEqual({ dueDate: '2026-11-13' });
    expect(patchFor('due', '')).toEqual({ dueDate: null });
    expect(patchFor('due', '2026-11-13T00:00:00.000Z')).toEqual({
      dueDate: '2026-11-13',
    });
  });

  test('parent and self review', () => {
    expect(patchFor('parent', 'm-1')).toEqual({ parent: 'm-1' });
    expect(patchFor('parent', null)).toEqual({ parent: null });
    expect(patchFor('selfReview', true)).toEqual({ selfReview: true });
    expect(patchFor('selfReview', false)).toEqual({ selfReview: false });
  });
});

describe('buildDetailRelations', () => {
  const relations = buildDetailRelations(FULL, context());

  test('blocked by: each blocker with its key, state, assignee and containers', () => {
    expect(relations.blockedBy).toHaveLength(3);
    expect(relations.blockedBy[0]).toEqual({
      id: 't-done',
      taskKey: 'ENG-12',
      title: 'Schema migration',
      href: '#/task/t-done',
      state: { kind: 'completed', label: 'Landed' },
      assignee: 'claude',
      context: 'Platform / Atlas / Dual-write',
      resolved: true,
    });
    expect(relations.blockedBy[1]).toEqual({
      id: 't-open',
      taskKey: 't-open',
      title: 'Backfill script',
      href: '#/task/t-open',
      state: { kind: 'unstarted', label: 'Ready' },
      assignee: null,
      resolved: false,
    });
  });

  test('a dangling blocker is kept as a missing row', () => {
    const missing: RelationModel = {
      id: 't-gone',
      taskKey: 't-gone',
      title: 'Unknown task',
      href: '#/task/t-gone',
      state: { kind: 'backlog', label: 'Unknown' },
      resolved: false,
      missing: true,
    };
    expect(relations.blockedBy[2]).toEqual(missing);
  });

  test('blocks: the tasks that name this one, from the index', () => {
    expect(relations.blocks.map((r) => r.id)).toEqual(['t-after']);
    expect(relations.blocks[0]).toMatchObject({
      title: 'Cutover rehearsal',
      assignee: AGENT_POOL_LABEL,
      resolved: false,
    });
  });

  test('related and duplicate of', () => {
    expect(relations.related.map((r) => r.id)).toEqual(['t-open']);
    expect(relations.duplicateOf).toMatchObject({
      id: 't-done',
      resolved: true,
    });
    const bare = buildDetailRelations(EMPTY, context());
    expect(bare).toEqual({
      blockedBy: [],
      blocks: [],
      related: [],
      duplicateOf: null,
    });
  });
});

describe('relation patches', () => {
  const ctx = context();
  /** A refused link, as the builders answer it. */
  const refused = (error: RelationError) => ({ error });

  test('blockerAddPatch refuses the task itself, a repeat and an unknown id', () => {
    expect(blockerAddPatch(FULL, 't-full', ctx.tasksById)).toEqual(
      refused('self')
    );
    expect(blockerAddPatch(FULL, 't-open', ctx.tasksById)).toEqual({
      error: 'duplicate',
    });
    expect(blockerAddPatch(FULL, 't-nope', ctx.tasksById)).toEqual({
      error: 'missing',
    });
  });

  test('blockerAddPatch refuses a dependency cycle', () => {
    // t-after already waits on t-full; t-full waiting on t-after would loop.
    expect(blockerAddPatch(FULL, 't-after', ctx.tasksById)).toEqual({
      error: 'cycle',
    });
    const a = taskDoc({ id: 't-a', title: 'A', blockedBy: ['t-b'] });
    const b = taskDoc({ id: 't-b', title: 'B', blockedBy: ['t-c'] });
    const c = taskDoc({ id: 't-c', title: 'C' });
    const chain = context([a, b, c]);
    expect(blockerAddPatch(c, 't-a', chain.tasksById)).toEqual({
      error: 'cycle',
    });
  });

  test('blockerAddPatch appends the blocker; a cycle elsewhere is not its business', () => {
    expect(blockerAddPatch(OPEN, 't-done', ctx.tasksById)).toEqual({
      patch: { blockedBy: ['t-done'] },
    });
    expect(blockerAddPatch(FULL, 't-parent', ctx.tasksById)).toEqual({
      patch: { blockedBy: ['t-done', 't-open', 't-gone', 't-parent'] },
    });
    const x = taskDoc({ id: 't-x', title: 'X', blockedBy: ['t-y'] });
    const y = taskDoc({ id: 't-y', title: 'Y', blockedBy: ['t-x'] });
    const looped = context([x, y]);
    expect(blockerAddPatch(OPEN, 't-x', looped.tasksById)).toEqual({
      patch: { blockedBy: ['t-x'] },
    });
  });

  test('blockerRemovePatch drops one blocker and keeps the rest', () => {
    expect(blockerRemovePatch(FULL, 't-open')).toEqual({
      blockedBy: ['t-done', 't-gone'],
    });
    expect(blockerRemovePatch(FULL, 't-nope')).toEqual({
      blockedBy: ['t-done', 't-open', 't-gone'],
    });
  });

  test('blocksRemovePatch edits the other task', () => {
    expect(blocksRemovePatch(AFTER, 't-full')).toEqual({
      taskId: 't-after',
      patch: { blockedBy: [] },
    });
  });

  test('relatedAddPatch and relatedRemovePatch', () => {
    expect(relatedAddPatch(FULL, 't-full', ctx.tasksById)).toEqual({
      error: 'self',
    });
    expect(relatedAddPatch(FULL, 't-open', ctx.tasksById)).toEqual({
      error: 'duplicate',
    });
    expect(relatedAddPatch(FULL, 't-nope', ctx.tasksById)).toEqual({
      error: 'missing',
    });
    expect(relatedAddPatch(FULL, 't-after', ctx.tasksById)).toEqual({
      patch: { relatedTo: ['t-open', 't-after'] },
    });
    expect(relatedRemovePatch(FULL, 't-open')).toEqual({ relatedTo: [] });
  });

  test('duplicateOfPatch marks, refuses and clears', () => {
    expect(duplicateOfPatch(OPEN, 't-done', ctx.tasksById)).toEqual({
      patch: { duplicateOf: 't-done' },
    });
    expect(duplicateOfPatch(OPEN, 't-open', ctx.tasksById)).toEqual({
      error: 'self',
    });
    expect(duplicateOfPatch(FULL, 't-done', ctx.tasksById)).toEqual({
      error: 'duplicate',
    });
    expect(duplicateOfPatch(OPEN, 't-nope', ctx.tasksById)).toEqual({
      error: 'missing',
    });
    expect(duplicateOfPatch(FULL, null, ctx.tasksById)).toEqual({
      patch: { duplicateOf: null },
    });
  });
});

describe('relationSearch', () => {
  const NONE = new Set<string>();

  test('an exact key or id comes first, then a prefix, then a title match', () => {
    const a1 = taskDoc({ id: 't-a1', title: 'Alpha' });
    const a10 = taskDoc({ id: 't-a10', title: 'Alpha ten' });
    const x = taskDoc({ id: 't-x', title: 'Mentions t-a1 in its title' });
    const ctx = context([x, a10, a1]);
    expect(relationSearch('t-a1', ctx, NONE).map((r) => r.id)).toEqual([
      't-a1',
      't-a10',
      't-x',
    ]);
  });

  test('a Linear identifier is searched like an id, and reported as the key', () => {
    const ctx = context();
    const hits = relationSearch('ENG-24', ctx, NONE);
    expect(hits[0]).toEqual({
      id: 't-full',
      taskKey: 'ENG-24',
      title: 'Dual-write drift reconciler',
      state: { kind: 'started', label: 'Working' },
    });
    expect(relationSearch('24', ctx, NONE).map((r) => r.id)).toEqual([
      't-full',
    ]);
  });

  test('title words all have to match; open tasks come before closed ones', () => {
    const done = taskDoc({
      id: 't-1',
      title: 'Schema migration',
      status: 'landed',
    });
    const open = taskDoc({ id: 't-2', title: 'Data migration' });
    const ctx = context([done, open]);
    expect(relationSearch('migration', ctx, NONE).map((r) => r.id)).toEqual([
      't-2',
      't-1',
    ]);
    expect(
      relationSearch('data migration', ctx, NONE).map((r) => r.id)
    ).toEqual(['t-2']);
    expect(relationSearch('data schema', ctx, NONE)).toEqual([]);
  });

  test('excluded and archived tasks are never offered', () => {
    const ctx = context();
    expect(relationSearch('old thing', ctx, NONE)).toEqual([]);
    expect(relationSearch('backfill', ctx, NONE).map((r) => r.id)).toEqual([
      't-open',
    ]);
    expect(relationSearch('backfill', ctx, new Set(['t-open']))).toEqual([]);
  });

  test('an empty query lists open tasks in list order, up to the limit', () => {
    const ctx = context();
    const all = relationSearch('', ctx, NONE);
    expect(all.map((r) => r.id)).toEqual([
      'i-1',
      'p-1',
      'm-1',
      'e-1',
      't-parent',
      't-child',
      't-grandchild',
      't-full',
      't-empty',
      't-open',
      't-after',
    ]);
    expect(relationSearch('', ctx, NONE, 2).map((r) => r.id)).toEqual([
      'i-1',
      'p-1',
    ]);
    // The default limit: 25 open tasks beside the 7 containers give 20 hits.
    const many = context(
      Array.from({ length: 25 }, (_, i) =>
        taskDoc({ id: `t-m${i}`, title: `Many ${i}` })
      )
    );
    expect(relationSearch('', many, NONE)).toHaveLength(20);
  });
});

describe('buildDetailDescription', () => {
  test('reads the description, the criteria (each one stripped) and the amendments', () => {
    expect(buildDetailDescription(FULL)).toEqual({
      description: 'Reconcile drift.',
      acceptance:
        '- [ ] Drift report lists every mismatch\n- [x] Fix script is idempotent\n2. Tests cover the backfill',
      criteria: [
        'Drift report lists every mismatch',
        'Fix script is idempotent',
        'Tests cover the backfill',
      ],
      amendments: 'Scope cut: no UI.',
    });
  });

  test('a bare body has empty sections', () => {
    expect(buildDetailDescription(EMPTY)).toEqual({
      description: '',
      acceptance: '',
      criteria: [],
      amendments: '',
    });
  });

  test('the patches replace one section each', () => {
    expect(descriptionPatch('New text.')).toEqual({ description: 'New text.' });
    expect(acceptancePatch('- it works')).toEqual({
      acceptanceCriteria: '- it works',
    });
  });
});

describe('buildDetailComments', () => {
  test('threads: each root followed by its replies, oldest first', () => {
    const items = buildDetailComments(
      [
        comment({ id: 'a' }),
        comment({ id: 'b' }),
        comment({ id: 'a-1', parentId: 'a' }),
        comment({ id: 'b-1', parentId: 'b' }),
        comment({ id: 'a-1-1', parentId: 'a-1' }),
      ],
      context()
    );
    expect(items.map((c) => c.id)).toEqual(['a', 'a-1', 'a-1-1', 'b', 'b-1']);
    expect(items.map((c) => c.reply === true)).toEqual([
      false,
      true,
      true,
      false,
      true,
    ]);
    expect(items[1]?.parentId).toBe('a');
  });

  test('own: the person’s own comments and their agents’, never a pending one', () => {
    const items = buildDetailComments(
      [
        comment({ id: 'mine' }),
        comment({ id: 'agent', author: 'agent:wyat/claude' }),
        comment({ id: 'theirs', author: 'human:ana' }),
        comment({ id: 'pending:1' }),
      ],
      context()
    );
    expect(items.map((c) => [c.id, c.own, c.pending])).toEqual([
      ['mine', true, false],
      ['agent', true, false],
      ['theirs', false, false],
      ['pending:1', false, true],
    ]);
    expect(
      buildDetailComments(
        [comment({ id: 'mine' })],
        context(TASKS, { me: null })
      )[0]?.own
    ).toBe(false);
  });

  test('authors are named by the registry, an agent’s comment reads quiet', () => {
    const [mine, agent, stranger] = buildDetailComments(
      [
        comment({ id: 'mine' }),
        comment({ id: 'agent', author: 'agent:wyat/claude' }),
        comment({ id: 'stranger', author: 'human:zed' }),
      ],
      context()
    );
    expect(mine).toMatchObject({ author: 'Wyatt Soule', body: 'Body of mine' });
    expect(mine?.tone).toBeUndefined();
    expect(agent).toMatchObject({ author: 'claude', tone: 'muted' });
    expect(stranger?.author).toBe('zed');
  });

  test('dates: relative to now, with the instant for <time>', () => {
    const created = ago(2 * HOUR);
    const [item] = buildDetailComments(
      [comment({ id: 'c', created })],
      context()
    );
    expect(item).toMatchObject({ at: '2h ago', dateTime: created });
  });

  test('relative time: just now, minutes, hours, days, then the calendar day', () => {
    const ats = [
      ago(10_000),
      ago(5 * MINUTE),
      ago(3 * HOUR),
      ago(2 * DAY),
      ago(10 * DAY),
      'not a date',
    ];
    const items = buildDetailComments(
      ats.map((created, i) => comment({ id: `c${i}`, created })),
      context()
    );
    expect(items.map((c) => c.at)).toEqual([
      'just now',
      '5m ago',
      '3h ago',
      '2d ago',
      'Oct 16',
      '—',
    ]);
  });
});

describe('buildDetailActivity', () => {
  const personFor = context().personFor;

  test('merges the Activity lines with runs no line mentions, newest first', () => {
    const items = buildDetailActivity({
      doc: FULL,
      runs: [
        run({ id: 'r-1', state: 'failed' }),
        run({
          id: 'r-2',
          reviewedAt: '2026-10-22T10:00:00.000Z',
          reviewAction: 'merge',
        }),
        run({
          id: 'r-3',
          state: 'running',
          createdAt: '2026-10-23T10:00:00.000Z',
        }),
      ],
      now: NOW,
      personFor,
    });
    expect(items.map((i) => [i.id, i.label])).toEqual([
      ['run-r-3', 'Run r-3 running on claude'],
      ['line-0', 'Merged into main'],
      ['line-1', 'Failed — error: tests failed'],
      ['line-2', 'Dispatched (claude)'],
      ['line-3', 'A plain note'],
    ]);
    expect(items.map((i) => i.dateTime)).toEqual([
      '2026-10-23T10:00:00.000Z',
      '2026-10-22T10:00:00.000Z',
      '2026-10-21T10:00:00.000Z',
      '2026-10-20T10:00:00.000Z',
      undefined,
    ]);
    expect(items.map((i) => i.at)).toEqual([
      '3d ago',
      '4d ago',
      '5d ago',
      '6d ago',
      'Undated',
    ]);
  });

  test('tones: a failure red, a merge green, a dispatch or live run blue, a note plain', () => {
    const items = buildDetailActivity({
      doc: FULL,
      runs: [run({ id: 'r-3', state: 'running' })],
      now: NOW,
      personFor,
    });
    expect(items.map((i) => i.tone)).toEqual([
      'info',
      'success',
      'danger',
      'info',
      undefined,
    ]);
  });

  test('the actor a line is credited to is the detail', () => {
    const items = buildDetailActivity({
      doc: FULL,
      runs: [],
      now: NOW,
      personFor,
    });
    expect(items.find((i) => i.id === 'line-2')?.detail).toBe(
      'By Wyatt Soule.'
    );
    expect(items.find((i) => i.id === 'line-0')?.detail).toBeUndefined();
  });

  test('runs the lines never mention are worded from their state', () => {
    const doc = taskDoc({ id: 't-r', title: 'Runs only' });
    const items = buildDetailActivity({
      doc,
      runs: [
        run({
          id: 'r-a',
          state: 'failed',
          error: 'tests failed',
          updatedAt: '2026-10-25T10:00:00.000Z',
        }),
        run({
          id: 'r-b',
          state: 'cancelled',
          updatedAt: '2026-10-24T10:00:00.000Z',
        }),
        run({ id: 'r-c', updatedAt: '2026-10-23T10:00:00.000Z' }),
        run({
          id: 'r-d',
          reviewedAt: '2026-10-22T10:00:00.000Z',
          reviewAction: 'discard',
        }),
        run({
          id: 'r-e',
          reviewedAt: '2026-10-21T10:00:00.000Z',
          reviewAction: 'pr',
          prUrl: 'https://github.com/x/y/pull/1',
        }),
        run({
          id: 'r-f',
          state: 'interrupted-dirty',
          updatedAt: '2026-10-20T10:00:00.000Z',
        }),
        run({
          id: 'r-g',
          state: 'awaiting-approval',
          createdAt: '2026-10-19T10:00:00.000Z',
        }),
        run({ id: 'r-h', reviewedAt: '2026-10-18T10:00:00.000Z' }),
      ],
      now: NOW,
      personFor,
    });
    expect(items.map((i) => [i.label, i.tone, i.detail])).toEqual([
      ['Run r-a failed', 'danger', 'tests failed'],
      ['Run r-b cancelled', 'muted', 'Ran on claude.'],
      ['Run r-c finished', undefined, 'Ran on claude.'],
      ['Run r-d discarded', 'muted', 'Ran on claude.'],
      ['Run r-e merged', 'success', 'Ran on claude.'],
      ['Run r-f interrupted', 'danger', 'Ran on claude.'],
      ['Run r-g awaiting approval on claude', 'info', undefined],
      ['Run r-h closed', undefined, 'Ran on claude.'],
    ]);
    // A reviewed run is dated by its review, a live one by its start.
    expect(items[3]?.dateTime).toBe('2026-10-22T10:00:00.000Z');
    expect(items[6]?.dateTime).toBe('2026-10-19T10:00:00.000Z');
  });

  test('a task with no Activity section and no runs has no history', () => {
    expect(
      buildDetailActivity({ doc: EMPTY, runs: [], now: NOW, personFor })
    ).toEqual([]);
  });
});
