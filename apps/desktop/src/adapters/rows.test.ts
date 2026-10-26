import type { Priority, TaskListItem } from '@dispatch-foo/core/browser';
import { statusModelOf } from '@dispatch-foo/core/browser';
import type {
  EpicChildPhase,
  EpicProgress,
  EpicSessionState,
  LinearIssueLink,
  MergeQueueEntryState,
  RunState,
} from '@dispatch/client';
import type { TaskPriority } from '@dispatch/ui';
import { describe, expect, test } from 'bun:test';

import {
  groupTasks,
  type ListGroup,
  type ListGroupRow,
} from '../lib/listGrouping';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../lib/tasksPrefs';
import type { TaskBucket, TaskStatusCounts } from '../lib/taskStatus';
import {
  dropTargetFor,
  dropVerdict,
  filterChips,
  fromTaskPriority,
  NEEDS_ASSIGNEE_LABEL,
  presetTabs,
  type RowContext,
  rowGroupIndex,
  rowIdsInOrder,
  toTaskGroup,
  toTaskPriority,
  toTaskRow,
  toTaskSections,
} from './rows';

// Monday 26 October 2026, midday local time: every date below reads against it.
const NOW = new Date(2026, 9, 26, 12);
const YESTERDAY = dayFromNow(-1, NOW);
const TODAY = dayFromNow(0, NOW);
const TOMORROW = dayFromNow(1, NOW);

const MODEL = statusModelOf(null);
const STATUSES = ['draft', 'ready', 'working', 'review', 'landed', 'dropped'];

// The hierarchy most tests sit in: an initiative holding a project holding a
// milestone, plus a milestone of its own (a legacy epic) under nothing.
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
});
const EPIC = taskDoc({ id: 'e-1', title: 'Payments', kind: 'milestone' });
const CONTAINERS = [INITIATIVE, PROJECT, MILESTONE, EPIC];

interface ContextInput extends Partial<Omit<RowContext, 'bucketOf'>> {
  /** The tasks `tasksById` holds (the containers are always in). */
  tasks?: readonly TaskListItem[];
  /** Each task's bucket; a task not listed is `ready`. */
  buckets?: Record<string, TaskBucket | null>;
}

function context(input: ContextInput = {}): RowContext {
  const tasksById = new Map<string, TaskListItem>();
  for (const doc of [...CONTAINERS, ...(input.tasks ?? [])]) {
    tasksById.set(doc.meta.id, doc);
  }
  const { tasks: _tasks, buckets, ...rest } = input;
  return {
    model: MODEL,
    tasksById,
    personFor: (assignee) =>
      assignee === 'human:wyat' ? { name: 'Wyatt Soule' } : undefined,
    bucketOf: (doc) => {
      const bucket = buckets?.[doc.meta.id];
      return bucket === undefined ? 'ready' : bucket;
    },
    now: NOW,
    hrefFor: (id) => `#/task/${id}`,
    ...rest,
  };
}

function row(doc: TaskListItem, indent: 0 | 1 = 0): ListGroupRow {
  return { doc, indent };
}

function group(
  over: Partial<ListGroup> & Pick<ListGroup, 'key' | 'kind'>
): ListGroup {
  return {
    label: '',
    tint: null,
    icon: null,
    rows: [],
    preset: {},
    epicId: null,
    archived: false,
    ...over,
  };
}

function prefs(over: Partial<TasksDisplayPrefs> = {}): TasksDisplayPrefs {
  return { ...DEFAULT_TASKS_DISPLAY, ...over };
}

/** `groupTasks` over the fixture hierarchy, as the view calls it. */
function grouped(
  tasks: TaskListItem[],
  over: Partial<TasksDisplayPrefs> = {},
  archivedTasks?: TaskListItem[]
): ListGroup[] {
  return groupTasks(tasks, prefs(over), {
    statuses: STATUSES,
    epics: CONTAINERS,
    archivedTasks,
    model: MODEL,
  });
}

function progress(
  epicId: string,
  children: { id: string; phase: EpicChildPhase }[],
  sessionState: EpicSessionState | null = null
): EpicProgress {
  return {
    epicId,
    active: sessionState === 'active',
    session:
      sessionState === null
        ? null
        : {
            epicId,
            concurrency: 2,
            executor: 'claude',
            state: sessionState,
            maxSpendUsd: null,
            maxRuns: null,
            startedAt: '2026-10-20T10:00:00.000Z',
            startedBy: 'human:wyat',
            scope: 'plan',
            updatedAt: '2026-10-20T10:00:00.000Z',
            active: sessionState === 'active',
          },
    spend: {
      settledUsd: 0,
      liveCount: 0,
      estimatedLiveUsd: 0,
      runsStarted: 0,
      maxSpendUsd: null,
      maxRuns: null,
    },
    children: children.map((child) => ({
      id: child.id,
      title: child.id,
      status: 'working',
      phase: child.phase,
      wave: 1,
      openFindings: 0,
    })),
    waves: [],
    liveRuns: [],
  };
}

const LINKS: Record<string, LinearIssueLink> = {
  'uuid-1': { identifier: 'ENG-12', url: 'https://linear.app/x/issue/ENG-12' },
};

describe('toTaskRow: identity, state and priority', () => {
  test('maps the task onto the table row, opening through hrefFor', () => {
    const doc = taskDoc({ id: 't-1', title: 'Ship it' });
    expect(toTaskRow(row(doc), context())).toEqual({
      id: 't-1',
      key: 't-1',
      title: 'Ship it',
      href: '#/task/t-1',
      state: 'Ready',
      stateKind: 'unstarted',
      priority: 3,
      priorityLabel: 'Medium',
      assignee: 'Any agent',
      milestone: null,
      done: false,
      indent: 0,
    });
  });

  test('every priority word lands on the table scale, and comes back', () => {
    const scale: [Priority, TaskPriority, string][] = [
      ['urgent', 1, 'Urgent'],
      ['high', 2, 'High'],
      ['medium', 3, 'Medium'],
      ['low', 4, 'Low'],
      ['none', 0, 'No priority'],
    ];
    for (const [word, level, label] of scale) {
      const out = toTaskRow(
        row(taskDoc({ id: 't', title: 't', priority: word })),
        context()
      );
      expect([out.priority, out.priorityLabel]).toEqual([level, label]);
      expect(toTaskPriority(word)).toBe(level);
      expect(fromTaskPriority(level)).toBe(word);
    }
  });

  test('the state is the status label and its workflow type; unknown statuses type as backlog', () => {
    const states = (status: string) => {
      const out = toTaskRow(
        row(taskDoc({ id: 't', title: 't', status })),
        context()
      );
      return [out.state, out.stateKind, out.done];
    };
    expect(states('draft')).toEqual(['Draft', 'backlog', false]);
    expect(states('in-progress')).toEqual(['In Progress', 'started', false]);
    expect(states('review')).toEqual(['Review', 'started', false]);
    expect(states('landed')).toEqual(['Landed', 'completed', true]);
    expect(states('dropped')).toEqual(['Dropped', 'canceled', true]);
    expect(states('qa')).toEqual(['Qa', 'backlog', false]);
  });

  test('a typed custom status takes its kind from the project model', () => {
    const model = statusModelOf({
      statusDefinitions: [
        { name: 'triage', type: 'triage', color: null },
        { name: 'qa', type: 'started', color: null },
        { name: 'done', type: 'completed', color: null },
      ],
    });
    const out = toTaskRow(
      row(taskDoc({ id: 't', title: 't', status: 'qa' })),
      context({ model })
    );
    expect(out.stateKind).toBe('started');
    const triage = toTaskRow(
      row(taskDoc({ id: 't', title: 't', status: 'triage' })),
      context({ model })
    );
    expect(triage.stateKind).toBe('triage');
  });

  test('the indent is the group nesting', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    expect(toTaskRow(row(doc, 1), context()).indent).toBe(1);
  });
});

describe('toTaskRow: the Linear key', () => {
  test('a linked task the links map knows reads by its identifier and opens in Linear from the ↗', () => {
    const doc = taskDoc({ id: 't-1', title: 't', external: 'linear:uuid-1' });
    const out = toTaskRow(row(doc), context({ linearLinks: LINKS }));
    expect(out.key).toBe('ENG-12');
    expect(out.externalHref).toBe('https://linear.app/x/issue/ENG-12');
    expect(out.externalLabel).toBe('Open ENG-12 in Linear');
  });

  test('a link the map has not got yet, another system, or no link keeps the task id', () => {
    const missing = taskDoc({
      id: 't-1',
      title: 't',
      external: 'linear:uuid-9',
    });
    const other = taskDoc({ id: 't-2', title: 't', external: 'github-pr:41' });
    const none = taskDoc({ id: 't-3', title: 't' });
    for (const doc of [missing, other, none]) {
      const out = toTaskRow(row(doc), context({ linearLinks: LINKS }));
      expect(out.key).toBe(doc.meta.id);
      expect(out.externalHref).toBeUndefined();
      expect(out.externalLabel).toBeUndefined();
    }
    // No links map at all (still loading): the id, never a throw.
    expect(toTaskRow(row(missing), context()).key).toBe('t-1');
  });
});

describe('toTaskRow: the hierarchy cells', () => {
  test('a task under a milestone under a project names both, the milestone with its project', () => {
    const doc = taskDoc({ id: 't', title: 't', parent: 'm-1' });
    const out = toTaskRow(row(doc), context());
    expect(out.project).toBe('Atlas');
    expect(out.milestone).toBe('Dual-write');
    expect(out.milestoneProject).toBe('Atlas');
  });

  test('where the project is already named, the milestone cell leaves it out', () => {
    const doc = taskDoc({ id: 't', title: 't', parent: 'm-1' });
    const out = toTaskRow(row(doc), context(), { projectNamed: true });
    expect(out.project).toBe('Atlas');
    expect(out.milestone).toBe('Dual-write');
    expect(out.milestoneProject).toBeUndefined();
  });

  test('a task filed straight under a project has no milestone', () => {
    const out = toTaskRow(
      row(taskDoc({ id: 't', title: 't', parent: 'p-1' })),
      context()
    );
    expect(out.project).toBe('Atlas');
    expect(out.milestone).toBeNull();
    expect(out.milestoneProject).toBeUndefined();
  });

  test('a milestone under nothing (a legacy epic) is a milestone with no project', () => {
    const out = toTaskRow(
      row(taskDoc({ id: 't', title: 't', parent: 'e-1' })),
      context()
    );
    expect(out.project).toBeUndefined();
    expect(out.milestone).toBe('Payments');
    expect(out.milestoneProject).toBeUndefined();
  });

  test('a sub-issue reaches its containers through its parent issue', () => {
    const parent = taskDoc({ id: 't-1', title: 'Parent', parent: 'm-1' });
    const sub = taskDoc({ id: 't-2', title: 'Sub', parent: 't-1' });
    const out = toTaskRow(row(sub), context({ tasks: [parent, sub] }));
    expect(out.project).toBe('Atlas');
    expect(out.milestone).toBe('Dual-write');
  });

  test('a dangling parent, no parent, or a parent cycle names nothing', () => {
    const dangling = taskDoc({ id: 't-1', title: 't', parent: 'gone' });
    const loose = taskDoc({ id: 't-2', title: 't' });
    const a = taskDoc({ id: 'a', title: 'a', parent: 'b' });
    const b = taskDoc({ id: 'b', title: 'b', parent: 'a' });
    const ctx = context({ tasks: [dangling, loose, a, b] });
    for (const doc of [dangling, loose, a]) {
      const out = toTaskRow(row(doc), ctx);
      expect(out.project).toBeUndefined();
      expect(out.milestone).toBeNull();
    }
  });
});

describe('toTaskRow: the due date', () => {
  const due = (dueDate: string | null, status = 'ready') => {
    const out = toTaskRow(
      row(taskDoc({ id: 't', title: 't', dueDate, status })),
      context()
    );
    return [out.due, out.dueTone, out.dueNote];
  };

  test('yesterday is red and says Overdue', () => {
    expect(due(YESTERDAY)).toEqual(['Oct 25', 'danger', 'Overdue']);
  });

  test('today and tomorrow are amber and say which', () => {
    expect(due(TODAY)).toEqual(['Oct 26', 'warning', 'Today']);
    expect(due(TOMORROW)).toEqual(['Oct 27', 'warning', 'Tomorrow']);
  });

  test('further out is a plain date; a date in another year carries the year', () => {
    expect(due(dayFromNow(5, NOW))).toEqual(['Oct 31', undefined, undefined]);
    expect(due('2027-01-04')).toEqual(['Jan 4, 2027', undefined, undefined]);
  });

  test('a finished task keeps its date but is never coloured', () => {
    expect(due(YESTERDAY, 'landed')).toEqual(['Oct 25', undefined, undefined]);
    expect(due(TODAY, 'dropped')).toEqual(['Oct 26', undefined, undefined]);
  });

  test('no due date is no due cell', () => {
    expect(due(null)).toEqual([undefined, undefined, undefined]);
  });
});

describe('toTaskRow: chips', () => {
  const chips = (doc: TaskListItem, input: ContextInput = {}) =>
    toTaskRow(row(doc), context({ tasks: [doc], ...input })).chips;

  test('labels come first as plain chips, and a row with nothing has no chips', () => {
    const plain = taskDoc({ id: 't', title: 't' });
    expect(chips(plain)).toBeUndefined();
    const labelled = taskDoc({ id: 't', title: 't', labels: ['ui', 'api'] });
    expect(chips(labelled)).toEqual([{ label: 'ui' }, { label: 'api' }]);
  });

  test('each bucket is one chip in its hue; ready and draft say nothing', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    const chipFor = (bucket: TaskBucket | null) =>
      chips(doc, { buckets: { t: bucket } });
    expect(chipFor('need-you')).toEqual([
      { label: 'Needs you', tone: 'warning', filled: true },
    ]);
    expect(chipFor('failed')).toEqual([
      { label: 'Failed', tone: 'danger', filled: true },
    ]);
    // Working is claimed for an agent only over a live run: a started status
    // alone (a person moved it) leaves the state glyph to say "Working".
    expect(chipFor('working')).toBeUndefined();
    expect(
      chips(doc, {
        buckets: { t: 'working' },
        liveRunStateByTaskId: new Map([['t', 'running' as RunState]]),
      })
    ).toEqual([{ label: 'Agent working', tone: 'info' }]);
    expect(chipFor('review')).toEqual([{ label: 'Review', tone: 'info' }]);
    expect(chipFor('landing')).toEqual([{ label: 'Landing', tone: 'info' }]);
    expect(chipFor('blocked')).toEqual([{ label: 'Blocked', tone: 'warning' }]);
    expect(chipFor('ready')).toBeUndefined();
    expect(chipFor('draft')).toBeUndefined();
    expect(chipFor(null)).toBeUndefined();
  });

  test('a landing task with a queue entry says the step in its one Landing chip', () => {
    const doc = taskDoc({ id: 't', title: 't', status: 'landing' });
    expect(
      chips(doc, {
        buckets: { t: 'landing' },
        landingByTaskId: new Map([['t', 'verifying' as MergeQueueEntryState]]),
      })
    ).toEqual([{ label: 'Landing · verifying', tone: 'info' }]);
  });

  test('a queue entry on a task another bucket claims is a second chip', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    expect(
      chips(doc, {
        buckets: { t: 'need-you' },
        landingByTaskId: new Map([
          ['t', 'waiting-github' as MergeQueueEntryState],
        ]),
      })
    ).toEqual([
      { label: 'Needs you', tone: 'warning', filled: true },
      { label: 'Landing · waiting on GitHub', tone: 'info' },
    ]);
  });

  test('a live run adds a quiet chip only where its state says more than the bucket', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    const withRun = (state: RunState, bucket: TaskBucket) =>
      chips(doc, {
        buckets: { t: bucket },
        liveRunStateByTaskId: new Map([['t', state]]),
      });
    expect(withRun('running', 'working')).toEqual([
      { label: 'Agent working', tone: 'info' },
    ]);
    expect(withRun('provisioning', 'working')).toEqual([
      { label: 'Agent working', tone: 'info' },
      { label: 'Provisioning', tone: 'muted' },
    ]);
    expect(withRun('awaiting-approval', 'need-you')).toEqual([
      { label: 'Needs you', tone: 'warning', filled: true },
      { label: 'Awaiting approval', tone: 'muted' },
    ]);
  });

  test('a fan-out phase is a chip when it adds a word the bucket does not say', () => {
    const doc = taskDoc({ id: 't', title: 't', parent: 'e-1' });
    // A working bucket here is an agent's live run, as in the app.
    const withPhase = (phase: EpicChildPhase, bucket: TaskBucket) =>
      chips(doc, {
        buckets: { t: bucket },
        liveRunStateByTaskId:
          bucket === 'working'
            ? new Map([['t', 'running' as RunState]])
            : undefined,
        epicProgressById: new Map([
          ['e-1', progress('e-1', [{ id: 't', phase }])],
        ]),
      });
    expect(withPhase('reviewing', 'working')).toEqual([
      { label: 'Agent working', tone: 'info' },
      { label: 'Reviewing', tone: 'info' },
    ]);
    expect(withPhase('fixing', 'working')).toEqual([
      { label: 'Agent working', tone: 'info' },
      { label: 'Fixing', tone: 'info' },
    ]);
    expect(withPhase('capped', 'ready')).toEqual([
      { label: 'Capped', tone: 'warning' },
    ]);
    expect(withPhase('held', 'ready')).toEqual([
      { label: 'Held', tone: 'warning' },
    ]);
    expect(withPhase('waiting', 'ready')).toEqual([
      { label: 'Waiting', tone: 'warning' },
    ]);
    // The bucket already says it.
    expect(withPhase('working', 'working')).toEqual([
      { label: 'Agent working', tone: 'info' },
    ]);
    expect(withPhase('failed', 'failed')).toEqual([
      { label: 'Failed', tone: 'danger', filled: true },
    ]);
    expect(withPhase('blocked', 'blocked')).toEqual([
      { label: 'Blocked', tone: 'warning' },
    ]);
    // A child waiting on its blockers is what Blocked already says.
    expect(withPhase('waiting', 'blocked')).toEqual([
      { label: 'Blocked', tone: 'warning' },
    ]);
    // A phase the status glyph already covers draws nothing.
    expect(withPhase('landed', 'ready')).toBeUndefined();
    expect(withPhase('queued', 'ready')).toBeUndefined();
  });

  test("a phase on another fan-out's child, or a task with no fan-out, is nothing", () => {
    const doc = taskDoc({ id: 't', title: 't', parent: 'e-1' });
    expect(
      chips(doc, {
        epicProgressById: new Map([
          ['e-1', progress('e-1', [{ id: 'other', phase: 'reviewing' }])],
        ]),
      })
    ).toBeUndefined();
  });

  test('the sub-task count and the unread count close the row, singular and plural', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    expect(
      chips(doc, {
        childCountByParent: new Map([['t', 1]]),
        unreadByTaskId: new Map([['t', 1]]),
      })
    ).toEqual([
      { label: '1 sub-task', tone: 'muted' },
      { label: '1 unread', tone: 'accent' },
    ]);
    expect(
      chips(doc, {
        childCountByParent: new Map([['t', 3]]),
        unreadByTaskId: new Map([['t', 2]]),
      })
    ).toEqual([
      { label: '3 sub-tasks', tone: 'muted' },
      { label: '2 unread', tone: 'accent' },
    ]);
    // Zero counts draw nothing.
    expect(
      chips(doc, {
        childCountByParent: new Map([['t', 0]]),
        unreadByTaskId: new Map([['t', 0]]),
      })
    ).toBeUndefined();
  });

  test('everything at once keeps the fixed order', () => {
    const doc = taskDoc({ id: 't', title: 't', parent: 'e-1', labels: ['ui'] });
    expect(
      chips(doc, {
        buckets: { t: 'need-you' },
        liveRunStateByTaskId: new Map([['t', 'awaiting-approval' as RunState]]),
        landingByTaskId: new Map([['t', 'verifying' as MergeQueueEntryState]]),
        epicProgressById: new Map([
          ['e-1', progress('e-1', [{ id: 't', phase: 'reviewing' }])],
        ]),
        childCountByParent: new Map([['t', 2]]),
        unreadByTaskId: new Map([['t', 3]]),
      })?.map((chip) => chip.label)
    ).toEqual([
      'ui',
      'Needs you',
      'Awaiting approval',
      'Landing · verifying',
      'Reviewing',
      '2 sub-tasks',
      '3 unread',
    ]);
  });

  test('an archived row keeps its labels and sub-task count but no overlay', () => {
    const doc = taskDoc({ id: 't', title: 't', labels: ['ui'] });
    const out = toTaskRow(
      row(doc),
      context({
        buckets: { t: 'need-you' },
        liveRunStateByTaskId: new Map([['t', 'provisioning' as RunState]]),
        landingByTaskId: new Map([['t', 'queued' as MergeQueueEntryState]]),
        childCountByParent: new Map([['t', 2]]),
        unreadByTaskId: new Map([['t', 1]]),
      }),
      { archived: true }
    );
    expect(out.chips).toEqual([
      { label: 'ui' },
      { label: '2 sub-tasks', tone: 'muted' },
      { label: '1 unread', tone: 'accent' },
    ]);
  });
});

describe('toTaskRow: the assignee', () => {
  test('a registered person by name, an agent by handle, the pool as Any agent', () => {
    const who = (assignee: string) =>
      toTaskRow(row(taskDoc({ id: 't', title: 't', assignee })), context());
    expect(who('human:wyat').assignee).toBe('Wyatt Soule');
    expect(who('human:ana').assignee).toBe('ana');
    expect(who('agent:wyat/claude').assignee).toBe('claude');
    expect(who('agent').assignee).toBe('Any agent');
    for (const value of ['human:wyat', 'agent:wyat/claude', 'agent']) {
      expect(who(value).assigneeTone).toBeUndefined();
      expect(who(value).unassignedLabel).toBeUndefined();
    }
  });

  test('nobody on open, specified work is amber and reads Needs assignee', () => {
    const doc = taskDoc({ id: 't', title: 't', assignee: 'none' });
    for (const bucket of [
      'ready',
      'blocked',
      'review',
      'need-you',
    ] as TaskBucket[]) {
      const out = toTaskRow(row(doc), context({ buckets: { t: bucket } }));
      expect(out.assignee).toBeNull();
      expect(out.assigneeTone).toBe('warning');
      expect(out.unassignedLabel).toBe(NEEDS_ASSIGNEE_LABEL);
    }
  });

  test('nobody on a draft, a finished task or a container is plain Unassigned', () => {
    const draft = taskDoc({
      id: 'd',
      title: 'd',
      assignee: 'none',
      status: 'draft',
    });
    const done = taskDoc({
      id: 'l',
      title: 'l',
      assignee: 'none',
      status: 'landed',
    });
    const container = taskDoc({
      id: 'c',
      title: 'c',
      assignee: 'none',
      kind: 'milestone',
    });
    const ctx = context({ buckets: { d: 'draft', l: null, c: null } });
    for (const doc of [draft, done, container]) {
      const out = toTaskRow(row(doc), ctx);
      expect(out.assignee).toBeNull();
      expect(out.assigneeTone).toBeUndefined();
      expect(out.unassignedLabel).toBeUndefined();
    }
  });

  test('an archived row never asks for an assignee', () => {
    const doc = taskDoc({ id: 't', title: 't', assignee: 'none' });
    const out = toTaskRow(row(doc), context(), { archived: true });
    expect(out.assignee).toBeNull();
    expect(out.assigneeTone).toBeUndefined();
  });
});

describe('toTaskRow: pending and failed changes', () => {
  test('a dispatch in flight marks the row busy with Dispatching…', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    const out = toTaskRow(
      row(doc),
      context({ pendingDispatch: new Set(['t']) })
    );
    expect(out.pending).toBe(true);
    expect(out.note).toEqual({ text: 'Dispatching…' });
  });

  test('a failed save prints why in red, without the busy state', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    const out = toTaskRow(
      row(doc),
      context({ saveErrorByTaskId: new Map([['t', 'daemon offline']]) })
    );
    expect(out.pending).toBeUndefined();
    expect(out.note).toEqual({
      text: 'Not saved · daemon offline',
      tone: 'danger',
    });
  });

  test('a dispatch in flight outranks an older save error; an archived row shows neither', () => {
    const doc = taskDoc({ id: 't', title: 't' });
    const input: ContextInput = {
      pendingDispatch: new Set(['t']),
      saveErrorByTaskId: new Map([['t', 'daemon offline']]),
    };
    expect(toTaskRow(row(doc), context(input)).note).toEqual({
      text: 'Dispatching…',
    });
    const archived = toTaskRow(row(doc), context(input), { archived: true });
    expect(archived.pending).toBeUndefined();
    expect(archived.note).toBeUndefined();
  });
});

describe('toTaskGroup: non-container groups', () => {
  test('a status group: keyed by status, a state mark, droppable', () => {
    const [ready] = grouped([taskDoc({ id: 't', title: 't' })]);
    const out = toTaskGroup(ready, context());
    expect(out).toMatchObject({
      id: 'status:ready',
      title: 'Ready',
      mark: { kind: 'state', state: 'unstarted' },
      droppable: true,
      count: 1,
      emptyLabel: 'No issues in this status',
    });
    expect(out.status).toBeUndefined();
    expect(out.eyebrow).toBeUndefined();
    expect(out.muted).toBeUndefined();
    expect(out.rows.map((r) => r.id)).toEqual(['t']);
  });

  test('a priority group: a priority mark, not droppable', () => {
    const [urgent] = grouped(
      [taskDoc({ id: 't', title: 't', priority: 'urgent' })],
      { grouping: 'priority' }
    );
    expect(toTaskGroup(urgent, context())).toMatchObject({
      id: 'priority:urgent',
      title: 'Urgent',
      mark: { kind: 'priority', priority: 1 },
      droppable: false,
      emptyLabel: 'No issues at this priority',
    });
  });

  test("an assignee group: the person's name and avatar; Unassigned with the blank avatar", () => {
    const groups = grouped(
      [
        taskDoc({ id: 'a', title: 'a', assignee: 'human:wyat' }),
        taskDoc({ id: 'b', title: 'b', assignee: 'none' }),
        taskDoc({ id: 'c', title: 'c', assignee: 'agent:wyat/claude' }),
      ],
      { grouping: 'assignee' }
    );
    const out = groups.map((g) => toTaskGroup(g, context()));
    expect(out.map((g) => [g.id, g.title, g.mark, g.droppable])).toEqual([
      [
        'assignee:agent:wyat/claude',
        'claude',
        { kind: 'avatar', name: 'claude' },
        false,
      ],
      [
        'assignee:human:wyat',
        'Wyatt Soule',
        { kind: 'avatar', name: 'Wyatt Soule' },
        false,
      ],
      ['assignee:none', 'Unassigned', { kind: 'avatar', name: '' }, false],
    ]);
    expect(out[0].emptyLabel).toBe('Nothing assigned');
  });

  test('the headerless all group reads All issues and takes no drops', () => {
    const [all] = grouped([taskDoc({ id: 't', title: 't' })], {
      grouping: 'none',
    });
    const out = toTaskGroup(all, context());
    expect(out).toMatchObject({
      id: 'all',
      title: 'All issues',
      droppable: false,
      emptyLabel: 'No issues',
    });
    expect(out.mark).toBeUndefined();
  });

  test('a footer comes from the view', () => {
    const [ready] = grouped([taskDoc({ id: 't', title: 't' })]);
    const footer = {
      text: 'Showing 1 of 1',
      actions: [{ label: 'Work on this', onActivate: () => {} }],
    };
    expect(toTaskGroup(ready, context()).footer).toBeUndefined();
    expect(
      toTaskGroup(ready, context(), {
        footerFor: (g) => (g.key === 'status:ready' ? footer : undefined),
      }).footer
    ).toBe(footer);
  });
});

describe('toTaskGroup: container groups', () => {
  const member = (id: string, status = 'ready') =>
    taskDoc({ id, title: id, parent: 'm-1', status });

  function milestoneGroup(
    tasks: TaskListItem[],
    input: ContextInput = {},
    container: TaskListItem = MILESTONE
  ) {
    // The container goes in last, so a variant of the fixture milestone (another
    // due date) replaces the one `context` seeds under the same id.
    const ctx = context({
      ...input,
      tasks: [...(input.tasks ?? []), ...tasks, container],
    });
    const g = group({
      key: `epic:${container.meta.id}`,
      kind: 'milestone',
      label: container.meta.title,
      icon: { kind: 'epic', epicId: container.meta.id },
      epicId: container.meta.id,
      rows: tasks.map((doc) => row(doc)),
    });
    return toTaskGroup(g, ctx);
  }

  test('titled by the container, with the container above as its eyebrow, droppable, rows with the project named', () => {
    const out = milestoneGroup([member('t-1')]);
    expect(out).toMatchObject({
      id: 'epic:m-1',
      title: 'Dual-write',
      eyebrow: 'Atlas',
      droppable: true,
      emptyLabel: 'No issues here yet',
    });
    expect(out.mark).toBeUndefined();
    expect(out.rows[0].milestone).toBe('Dual-write');
    expect(out.rows[0].milestoneProject).toBeUndefined();
  });

  test('a container under nothing has no eyebrow; one under an initiative names it', () => {
    const under = taskDoc({ id: 'x', title: 'x', parent: 'e-1' });
    expect(milestoneGroup([under], {}, EPIC).eyebrow).toBeUndefined();
    const inProject = taskDoc({ id: 'y', title: 'y', parent: 'p-1' });
    expect(milestoneGroup([inProject], {}, PROJECT).eyebrow).toBe('Platform');
  });

  test('idle work is on track; moving work is in progress', () => {
    const idle = milestoneGroup([member('t-1'), member('t-2', 'landed')]);
    expect(idle).toMatchObject({
      status: 'on_track',
      statusLabel: 'On track',
      progress: { done: 1, total: 2 },
    });
    expect(idle.progress?.tone).toBeUndefined();
    expect(idle.muted).toBeUndefined();
    const moving = milestoneGroup([member('t-1', 'working')], {
      buckets: { 't-1': 'working' },
    });
    expect(moving).toMatchObject({
      status: 'on_track',
      statusLabel: 'In progress',
      progress: { done: 0, total: 1 },
    });
  });

  test('asks or failures need attention, in amber', () => {
    const failed = milestoneGroup([member('t-1')], {
      buckets: { 't-1': 'failed' },
    });
    expect(failed).toMatchObject({
      status: 'at_risk',
      statusLabel: 'Needs attention',
      progress: { done: 0, total: 1, tone: 'warning' },
    });
    const asked = milestoneGroup([member('t-1')], {
      asksByTaskId: new Map([['t-1', 2]]),
    });
    expect(asked.status).toBe('at_risk');
  });

  test('everything landed is done, green and muted; dropped work does not count', () => {
    const out = milestoneGroup([
      member('t-1', 'landed'),
      member('t-2', 'landed'),
      member('t-3', 'dropped'),
    ]);
    expect(out).toMatchObject({
      status: 'done',
      statusLabel: 'All issues done',
      progress: { done: 2, total: 2, tone: 'success' },
      muted: true,
    });
  });

  test('a container past its due date is overdue, in red, with how late', () => {
    const late = taskDoc({ ...MILESTONE.meta, dueDate: YESTERDAY });
    const out = milestoneGroup([member('t-1')], {}, late);
    expect(out).toMatchObject({
      status: 'overdue',
      statusLabel: 'Overdue',
      progress: { done: 0, total: 1, tone: 'danger' },
      dueLabel: 'Oct 25',
      daysLeftLabel: '1d overdue',
      dueTone: 'danger',
    });
  });

  test('overdue outranks attention; done outranks overdue', () => {
    const late = taskDoc({ ...MILESTONE.meta, dueDate: YESTERDAY });
    const attention = milestoneGroup(
      [member('t-1')],
      {
        buckets: { 't-1': 'failed' },
      },
      late
    );
    expect(attention.status).toBe('overdue');
    const done = milestoneGroup([member('t-1', 'landed')], {}, late);
    expect(done).toMatchObject({
      status: 'done',
      dueLabel: 'Oct 25',
      daysLeftLabel: 'Done',
    });
    expect(done.dueTone).toBeUndefined();
  });

  test('due today or tomorrow is amber; further out is plain', () => {
    const soon = taskDoc({ ...MILESTONE.meta, dueDate: TOMORROW });
    expect(milestoneGroup([member('t-1')], {}, soon)).toMatchObject({
      dueLabel: 'Oct 27',
      daysLeftLabel: 'Tomorrow',
      dueTone: 'warning',
    });
    const later = taskDoc({ ...MILESTONE.meta, dueDate: dayFromNow(5, NOW) });
    const out = milestoneGroup([member('t-1')], {}, later);
    expect(out).toMatchObject({ dueLabel: 'Oct 31', daysLeftLabel: 'in 5d' });
    expect(out.dueTone).toBeUndefined();
  });

  test('a group with no rows is missing its issues and has no progress or due facts', () => {
    const out = milestoneGroup([]);
    expect(out).toMatchObject({
      status: 'missing',
      statusLabel: 'No issues yet',
      count: 0,
    });
    expect(out.progress).toBeUndefined();
    expect(out.dueLabel).toBeUndefined();
  });

  test('a paused fan-out session is a Paused tag; an active one is nothing', () => {
    const paused = milestoneGroup([member('t-1')], {
      epicProgressById: new Map([['m-1', progress('m-1', [], 'paused')]]),
    });
    expect(paused.tags).toEqual(['Paused']);
    const active = milestoneGroup([member('t-1')], {
      epicProgressById: new Map([['m-1', progress('m-1', [], 'active')]]),
    });
    expect(active.tags).toBeUndefined();
    expect(milestoneGroup([member('t-1')]).tags).toBeUndefined();
  });

  test('the No epic group has no container facts and takes a drop (to no parent)', () => {
    const groups = grouped([taskDoc({ id: 't', title: 't' })], {
      grouping: 'epic',
    });
    const none = groups.find((g) => g.key === 'epic:none');
    expect(none).toBeDefined();
    const out = toTaskGroup(none, context());
    expect(out).toMatchObject({
      id: 'epic:none',
      title: 'No epic',
      droppable: true,
    });
    expect(out.status).toBeUndefined();
    expect(out.mark).toBeUndefined();
    expect(out.eyebrow).toBeUndefined();
  });

  test('a milestone grouping\'s "Outer › Inner" label becomes title and eyebrow', () => {
    const groups = grouped([taskDoc({ id: 't', title: 't', parent: 'm-1' })], {
      grouping: 'milestone',
    });
    const dualWrite = groups.find((g) => g.key === 'milestone:m-1');
    expect(dualWrite?.label).toBe('Atlas › Dual-write');
    const out = toTaskGroup(
      dualWrite,
      context({ tasks: [taskDoc({ id: 't', title: 't', parent: 'm-1' })] })
    );
    expect(out.title).toBe('Dual-write');
    expect(out.eyebrow).toBe('Atlas');
    expect(out.droppable).toBe(true);
  });

  test("a group for a parent the window does not know keeps the grouping's label", () => {
    const g = group({
      key: 'epic:gone',
      kind: 'milestone',
      label: 'gone',
      icon: { kind: 'epic', epicId: 'gone' },
      epicId: 'gone',
    });
    const out = toTaskGroup(g, context());
    expect(out.title).toBe('gone');
    expect(out.status).toBeUndefined();
    expect(out.droppable).toBe(true);
  });

  test('the archived group is muted, takes no drops, and its rows carry no overlay', () => {
    const live = taskDoc({ id: 't', title: 't' });
    const old = taskDoc({ id: 'old', title: 'old', labels: ['ui'] });
    const groups = grouped([live], {}, [old]);
    const archived = groups.at(-1);
    const out = toTaskGroup(
      archived,
      context({ buckets: { old: 'need-you' } })
    );
    expect(out).toMatchObject({
      id: 'archived',
      title: 'Archived',
      muted: true,
      droppable: false,
      emptyLabel: 'Nothing archived',
    });
    expect(out.rows[0].chips).toEqual([{ label: 'ui' }]);
  });
});

describe('toTaskSections', () => {
  const live = taskDoc({ id: 't-1', title: 'Live', parent: 'm-1' });
  const working = taskDoc({ id: 't-2', title: 'Working', status: 'working' });
  const old = taskDoc({ id: 'old', title: 'Old' });

  test('one unnamed section of live groups, and an Archived section when there is one', () => {
    const sections = toTaskSections(
      grouped([live, working], {}, [old]),
      context({ tasks: [live, working, old] })
    );
    expect(sections.map((s) => [s.id, s.label])).toEqual([
      ['issues', undefined],
      ['archived', 'Archived'],
    ]);
    expect(sections[0].groups.map((g) => g.id)).toEqual([
      'status:ready',
      'status:working',
    ]);
    expect(sections[1].groups.map((g) => g.id)).toEqual(['archived']);
    expect(sections[1].groups[0].muted).toBe(true);
  });

  test('no groups at all is no sections; only archived is one section', () => {
    expect(toTaskSections([], context())).toEqual([]);
    const sections = toTaskSections(
      grouped([], {}, [old]),
      context({ tasks: [old] })
    );
    expect(sections.map((s) => s.id)).toEqual(['archived']);
  });

  test('with a project column the milestone cells leave the project out; without one they name it', () => {
    const groups = grouped([live]);
    const ctx = context({ tasks: [live] });
    const named = toTaskSections(groups, ctx, {
      columns: ['project', 'milestone', 'state'],
    });
    expect(named[0].groups[0].rows[0].milestoneProject).toBeUndefined();
    const unnamed = toTaskSections(groups, ctx, { columns: ['milestone'] });
    expect(unnamed[0].groups[0].rows[0].milestoneProject).toBe('Atlas');
    expect(
      toTaskSections(groups, ctx)[0].groups[0].rows[0].milestoneProject
    ).toBe('Atlas');
  });

  test('footers reach every group', () => {
    const sections = toTaskSections(
      grouped([live, working]),
      context({ tasks: [live, working] }),
      {
        footerFor: (g) => ({ text: g.key, actions: [] }),
      }
    );
    expect(sections[0].groups.map((g) => g.footer?.text)).toEqual([
      'status:ready',
      'status:working',
    ]);
  });

  test('rowIdsInOrder and rowGroupIndex read the drawn order across sections', () => {
    const sections = toTaskSections(
      grouped([live, working], {}, [old]),
      context({ tasks: [live, working, old] })
    );
    expect(rowIdsInOrder(sections)).toEqual(['t-1', 't-2', 'old']);
    expect([...rowGroupIndex(sections)]).toEqual([
      ['t-1', 'status:ready'],
      ['t-2', 'status:working'],
      ['old', 'archived'],
    ]);
    expect(rowIdsInOrder([])).toEqual([]);
    expect(rowGroupIndex([]).size).toBe(0);
  });
});

describe('dropTargetFor', () => {
  test('a status group moves to that status, colons in the name included', () => {
    expect(dropTargetFor('status:ready')).toEqual({
      kind: 'status',
      status: 'ready',
    });
    expect(dropTargetFor('status:in:qa')).toEqual({
      kind: 'status',
      status: 'in:qa',
    });
  });

  test('an epic or milestone group re-parents; No epic to no parent', () => {
    expect(dropTargetFor('epic:e-1')).toEqual({
      kind: 'parent',
      parentId: 'e-1',
    });
    expect(dropTargetFor('milestone:m-1')).toEqual({
      kind: 'parent',
      parentId: 'm-1',
    });
    expect(dropTargetFor('epic:none')).toEqual({
      kind: 'parent',
      parentId: null,
    });
  });

  test('every other group takes nothing', () => {
    for (const key of [
      'all',
      'archived',
      'assignee:human:wyat',
      'assignee:none',
      'priority:high',
      'status:',
      'epic:',
      'other:x',
    ]) {
      expect(dropTargetFor(key)).toBeNull();
    }
  });
});

describe('dropVerdict', () => {
  const tasksById = new Map<string, TaskListItem>([
    ['e-1', taskDoc({ id: 'e-1', title: 'Payments', kind: 'milestone' })],
    ['t-1', taskDoc({ id: 't-1', title: 'Charge card' })],
  ]);

  test('a status or container group takes plain tasks', () => {
    expect(dropVerdict(['t-1'], 'status:done', tasksById)).toBe(true);
    expect(dropVerdict(['t-1'], 'epic:e-1', tasksById)).toBe(true);
    expect(dropVerdict(['t-1'], 'epic:none', tasksById)).toBe(true);
    expect(dropVerdict(['t-1', 'unknown'], 'milestone:e-1', tasksById)).toBe(
      true
    );
  });

  test('a group that stands for nothing to move to says so', () => {
    expect(dropVerdict(['t-1'], 'assignee:agent', tasksById)).toBe(
      'Drop on a status or a milestone'
    );
    expect(dropVerdict(['t-1'], 'all', tasksById)).toBe(
      'Drop on a status or a milestone'
    );
  });

  test('containers never move, and a container cannot hold itself', () => {
    expect(dropVerdict(['t-1', 'e-1'], 'status:done', tasksById)).toBe(
      'Projects and milestones stay where they are'
    );
    expect(
      dropVerdict(['x-9'], 'epic:x-9', new Map<string, TaskListItem>())
    ).toBe('A task cannot hold itself');
  });
});

describe('presetTabs', () => {
  const counts: TaskStatusCounts = {
    buckets: {
      'need-you': 2,
      failed: 1,
      working: 3,
      review: 4,
      landing: 5,
      ready: 6,
      draft: 7,
      blocked: 8,
    },
    open: 36,
    landed: 9,
    total: 45,
  };

  test('every preset in order, counted from the buckets and the extras, the current one marked', () => {
    const tabs = presetTabs(counts, {
      current: 'review',
      mine: 11,
      starred: 12,
      hrefFor: (preset) => `#/issues/${preset}`,
    });
    expect(tabs.map((t) => [t.id, t.label, t.count, t.current])).toEqual([
      ['all', 'All', undefined, false],
      ['mine', 'Mine', 11, false],
      ['needs-you', 'Needs you', 2, false],
      ['failed', 'Failed', 1, false],
      ['moving', 'Moving', 3, false],
      ['review', 'Review', 4, true],
      ['ready', 'Ready', 6, false],
      ['landing', 'Landing', 5, false],
      ['landed', 'Landed', 9, false],
      ['starred', 'Starred', 12, false],
    ]);
    expect(tabs.map((t) => t.href)).toEqual(
      tabs.map((t) => `#/issues/${t.id}`)
    );
  });

  test('an explicit needs-you count wins over the bucket; no hrefFor gives no links', () => {
    const tabs = presetTabs(counts, {
      current: 'all',
      mine: 0,
      starred: 0,
      needsYou: 7,
    });
    expect(tabs.find((t) => t.id === 'needs-you')?.count).toBe(7);
    expect(tabs.find((t) => t.id === 'all')?.current).toBe(true);
    expect(tabs.every((t) => t.href === undefined)).toBe(true);
  });
});

describe('filterChips', () => {
  test('one chip per clause, in set order, the values in their reading labels', () => {
    const chips = filterChips({
      clauses: [
        { facet: 'status', op: 'is', values: ['in-progress', 'review'] },
        { facet: 'priority', op: 'is', values: ['urgent'] },
        { facet: 'assignee', op: 'is', values: ['human:wyat', 'none'] },
      ],
      join: 'and',
    });
    expect(chips).toEqual([
      {
        id: 'status:0',
        index: 0,
        facet: 'status',
        op: 'is',
        field: 'Status',
        summary: 'In Progress, Review',
        removeLabel: 'Remove status filter',
      },
      {
        id: 'priority:1',
        index: 1,
        facet: 'priority',
        op: 'is',
        field: 'Priority',
        summary: 'Urgent',
        removeLabel: 'Remove priority filter',
      },
      {
        id: 'assignee:2',
        index: 2,
        facet: 'assignee',
        op: 'is',
        field: 'Assignee',
        summary: 'wyat, Unassigned',
        removeLabel: 'Remove assignee filter',
      },
    ]);
  });

  test('an operator other than "is" goes into the summary, after the chip\'s own "is"', () => {
    const chips = filterChips({
      clauses: [
        { facet: 'status', op: 'is not', values: ['landed'] },
        { facet: 'labels', op: 'includes', values: ['ui', 'api'] },
        { facet: 'created', op: 'after', values: ['2026-09-01'] },
        { facet: 'updated', op: 'before', values: ['2026-10-01'] },
      ],
      join: 'or',
    });
    expect(chips.map((c) => [c.field, c.summary])).toEqual([
      ['Status', 'not Landed'],
      ['Labels', 'ui, api'],
      ['Created', 'after Sep 1'],
      ['Updated', 'before Oct 1'],
    ]);
    expect(chips.map((c) => c.removeLabel)).toEqual([
      'Remove status filter',
      'Remove labels filter',
      'Remove created filter',
      'Remove updated filter',
    ]);
  });

  test('an epic reads by its title; one the window does not know is flagged', () => {
    const titles = new Map([['e-1', 'Payments']]);
    const known = filterChips(
      {
        clauses: [{ facet: 'epic', op: 'is', values: ['e-1', 'none'] }],
        join: 'and',
      },
      { epicTitleById: titles }
    );
    expect(known[0].summary).toBe('Payments, No epic');
    expect(known[0].unknown).toBeUndefined();
    const gone = filterChips(
      { clauses: [{ facet: 'epic', op: 'is', values: ['e-9'] }], join: 'and' },
      { epicTitleById: titles }
    );
    expect(gone[0]).toMatchObject({ summary: 'e-9', unknown: true });
    // Without titles nothing can be judged unknown.
    const blind = filterChips({
      clauses: [{ facet: 'epic', op: 'is', values: ['e-9'] }],
      join: 'and',
    });
    expect(blind[0].unknown).toBeUndefined();
  });

  test('the run facet and the empty set', () => {
    expect(filterChips({ clauses: [], join: 'and' })).toEqual([]);
    const chips = filterChips({
      clauses: [{ facet: 'run', op: 'is', values: ['running', 'none'] }],
      join: 'and',
    });
    expect(chips[0]).toMatchObject({
      field: 'Run state',
      summary: 'Working, No live run',
      removeLabel: 'Remove run state filter',
    });
  });
});
