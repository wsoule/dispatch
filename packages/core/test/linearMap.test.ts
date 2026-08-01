import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_STATUS_MAP,
  externalId,
  issueFromTask,
  parseExternal,
  priorityFromLinear,
  priorityToLinear,
  resolveConflict,
  resolveWorkflowState,
  statusFromState,
  taskCreateFromIssue,
  taskPatchFromIssue,
} from '../src/linearMap.js';
import type {
  LinearIssue,
  LinearLabel,
  LinearWorkflowState,
} from '../src/linearMap.js';
import type { Priority, TaskDoc } from '../src/types.js';
import { PRIORITIES, STATUSES } from '../src/types.js';

const STATES: LinearWorkflowState[] = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog' },
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-progress', name: 'In Progress', type: 'started' },
  { id: 's-review', name: 'In Review', type: 'started' },
  { id: 's-done', name: 'Done', type: 'completed' },
  { id: 's-cancelled', name: 'Canceled', type: 'canceled' },
];

const LABELS: LinearLabel[] = [
  { id: 'l-bug', name: 'Bug' },
  { id: 'l-web', name: 'web' },
];

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: '1f0a6a6e-0000-4000-8000-000000000001',
    identifier: 'HYD-40',
    title: 'Speed up initial page load',
    description: 'The PR review page blocks on a serial fetch.',
    priority: 2,
    url: 'https://linear.app/acme/issue/HYD-40',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    archivedAt: null,
    state: STATES[2],
    labels: [LABELS[1]],
    team: { id: 'team-1', key: 'HYD' },
    ...overrides,
  };
}

function task(overrides: Partial<TaskDoc['meta']> = {}): TaskDoc {
  return {
    meta: {
      id: 't-abc123',
      title: 'Speed up initial page load',
      status: 'in-progress',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: ['web'],
      priority: 'high',
      assignee: 'none',
      created: '2026-07-01T00:00:00.000Z',
      updated: '2026-07-03T00:00:00.000Z',
      external: null,
      selfReview: true,
      ...overrides,
    },
    body: '\n## Description\n\nThe PR review page blocks on a serial fetch.\n\n## Activity\n',
  };
}

describe('externalId / parseExternal', () => {
  it('joins on the issue UUID, not the display identifier', () => {
    expect(externalId(issue())).toBe(
      'linear:1f0a6a6e-0000-4000-8000-000000000001'
    );
  });

  it('round-trips', () => {
    expect(parseExternal(externalId(issue()))).toBe(issue().id);
  });

  it('ignores values that name another system, or none', () => {
    expect(parseExternal('jira:ENG-1')).toBeNull();
    expect(parseExternal('linear:')).toBeNull();
    expect(parseExternal(null)).toBeNull();
  });
});

describe('priority mapping', () => {
  it('round-trips every dispatch priority', () => {
    for (const priority of PRIORITIES) {
      expect(priorityFromLinear(priorityToLinear(priority))).toBe(priority);
    }
  });

  it('uses Linear’s scale where 1 is most urgent and 0 means unset', () => {
    const expected: Record<Priority, number> = {
      urgent: 1,
      high: 2,
      medium: 3,
      low: 4,
      none: 0,
    };
    for (const [priority, value] of Object.entries(expected)) {
      expect(priorityToLinear(priority as Priority)).toBe(value);
    }
  });

  it('falls back to none for a value outside 0-4', () => {
    expect(priorityFromLinear(9)).toBe('none');
  });
});

describe('resolveWorkflowState', () => {
  it('matches the configured value against state names', () => {
    expect(
      resolveWorkflowState('in-review', DEFAULT_STATUS_MAP, STATES)?.id
    ).toBe('s-review');
  });

  it('also matches a state type, so a map written against types works', () => {
    expect(
      resolveWorkflowState('done', { done: 'completed' }, STATES)?.id
    ).toBe('s-done');
  });

  it('returns null for an unmapped status rather than guessing', () => {
    expect(
      resolveWorkflowState('triaged', DEFAULT_STATUS_MAP, STATES)
    ).toBeNull();
  });
});

describe('statusFromState', () => {
  it('inverts the configured map', () => {
    expect(
      statusFromState(STATES[4], DEFAULT_STATUS_MAP, STATUSES, 'todo')
    ).toBe('done');
  });

  it('falls back to the state type when the name is unmapped', () => {
    const renamed = { id: 's-x', name: 'Shipped', type: 'completed' };
    expect(statusFromState(renamed, {}, STATUSES, 'todo')).toBe('done');
  });

  it('falls back to the caller’s status when the type is unknown too', () => {
    const weird = { id: 's-x', name: 'Parked', type: 'hibernating' };
    expect(statusFromState(weird, {}, STATUSES, 'backlog')).toBe('backlog');
  });

  it('never writes a status the project does not define', () => {
    const custom = ['open', 'shut'];
    expect(statusFromState(STATES[4], DEFAULT_STATUS_MAP, custom, 'open')).toBe(
      'open'
    );
  });

  it('falls back when the issue has no state at all', () => {
    expect(statusFromState(null, DEFAULT_STATUS_MAP, STATUSES, 'todo')).toBe(
      'todo'
    );
  });
});

describe('taskCreateFromIssue', () => {
  it('maps title, status, description, labels and priority', () => {
    expect(
      taskCreateFromIssue(issue(), {
        statusMap: DEFAULT_STATUS_MAP,
        statuses: STATUSES,
        fallbackStatus: 'todo',
      })
    ).toEqual({
      title: 'Speed up initial page load',
      status: 'in-progress',
      description: 'The PR review page blocks on a serial fetch.',
      labels: ['web'],
      priority: 'high',
    });
  });

  it('treats a null description as empty', () => {
    const created = taskCreateFromIssue(issue({ description: null }), {
      statusMap: DEFAULT_STATUS_MAP,
      statuses: STATUSES,
      fallbackStatus: 'todo',
    });
    expect(created.description).toBe('');
  });
});

describe('taskPatchFromIssue', () => {
  it('produces the same field set as a patch over an existing task', () => {
    expect(
      taskPatchFromIssue(issue({ priority: 1, state: STATES[5] }), {
        statusMap: DEFAULT_STATUS_MAP,
        statuses: STATUSES,
        fallbackStatus: 'todo',
      })
    ).toEqual({
      title: 'Speed up initial page load',
      status: 'cancelled',
      description: 'The PR review page blocks on a serial fetch.',
      labels: ['web'],
      priority: 'urgent',
    });
  });
});

describe('issueFromTask', () => {
  it('maps title, description, priority, state and known labels', () => {
    expect(
      issueFromTask(task(), {
        teamId: 'team-1',
        statusMap: DEFAULT_STATUS_MAP,
        states: STATES,
        labels: LABELS,
        description: 'The PR review page blocks on a serial fetch.',
      })
    ).toEqual({
      teamId: 'team-1',
      title: 'Speed up initial page load',
      description: 'The PR review page blocks on a serial fetch.',
      priority: 2,
      stateId: 's-progress',
      labelIds: ['l-web'],
    });
  });

  it('drops labels the workspace does not define rather than creating them', () => {
    const input = issueFromTask(task({ labels: ['web', 'nonexistent'] }), {
      teamId: 'team-1',
      statusMap: DEFAULT_STATUS_MAP,
      states: STATES,
      labels: LABELS,
      description: '',
    });
    expect(input.labelIds).toEqual(['l-web']);
  });

  it('omits stateId when the status maps to nothing, leaving the issue alone', () => {
    const input = issueFromTask(task({ status: 'triaged' }), {
      teamId: 'team-1',
      statusMap: DEFAULT_STATUS_MAP,
      states: STATES,
      labels: LABELS,
      description: '',
    });
    expect(input.stateId).toBeUndefined();
    expect(input.title).toBe('Speed up initial page load');
  });
});

describe('resolveConflict', () => {
  it('picks local when the task was edited more recently', () => {
    expect(
      resolveConflict('2026-07-03T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
    ).toBe('local');
  });

  it('picks remote when the issue was edited more recently', () => {
    expect(
      resolveConflict('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
    ).toBe('remote');
  });

  it('writes nothing on a tie', () => {
    expect(
      resolveConflict('2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
    ).toBe('none');
  });

  it('writes nothing when a timestamp cannot be parsed', () => {
    expect(resolveConflict('not a date', '2026-07-02T00:00:00.000Z')).toBe(
      'none'
    );
  });
});
