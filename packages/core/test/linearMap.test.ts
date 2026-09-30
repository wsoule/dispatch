import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_STATUS_MAP,
  externalId,
  linearExternal,
  parseExternal,
  parseLinearExternal,
  priorityFromLinear,
  priorityToLinear,
  resolveConflict,
  resolveWorkflowState,
} from '../src/linearMap.js';
import type {
  LinearIssue,
  LinearLabel,
  LinearWorkflowState,
} from '../src/linearMap.js';
import type { Priority } from '../src/types.js';
import { PRIORITIES } from '../src/types.js';

const STATES: LinearWorkflowState[] = [
  { id: 's-backlog', name: 'Backlog', type: 'draft' },
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
    estimate: null,
    dueDate: null,
    assigneeId: null,
    creatorId: null,
    cycle: null,
    projectId: null,
    projectMilestoneId: null,
    parentId: null,
    childIds: [],
    relations: [],
    attachments: [],
    truncated: [],
    ...overrides,
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

describe('linearExternal / parseLinearExternal', () => {
  it('names the record kind, so a push knows which API to call', () => {
    for (const entity of [
      'issue',
      'project',
      'milestone',
      'initiative',
    ] as const) {
      const value = linearExternal({ entity, id: 'abc' });
      expect(parseLinearExternal(value)).toEqual({ entity, id: 'abc' });
    }
    expect(linearExternal({ entity: 'issue', id: 'abc' })).toBe('linear:abc');
  });

  it('keeps container links out of the issue-only parser', () => {
    expect(parseExternal('linear-project:abc')).toBeNull();
    expect(parseLinearExternal('github-pr:41')).toBeNull();
    expect(parseLinearExternal('linear-project:')).toBeNull();
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
    expect(resolveWorkflowState('review', DEFAULT_STATUS_MAP, STATES)?.id).toBe(
      's-review'
    );
  });

  it('also matches a state type, so a map written against types works', () => {
    expect(
      resolveWorkflowState('landed', { landed: 'completed' }, STATES)?.id
    ).toBe('s-done');
  });

  it('returns null for an unmapped status rather than guessing', () => {
    expect(
      resolveWorkflowState('triaged', DEFAULT_STATUS_MAP, STATES)
    ).toBeNull();
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
