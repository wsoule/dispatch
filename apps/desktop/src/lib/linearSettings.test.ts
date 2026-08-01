import type {
  LinearIssueLink,
  LinearStatus,
  LinearSyncSummary,
  LinearWorkflowState,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  formatSyncCounts,
  isLinearConfigured,
  NO_LINEAR_STATE,
  resolveLinearLink,
  resolveMappedStateId,
  statusMapCompleteness,
} from './linearSettings';

// Builds a minimal LinearStatus, only the fields a given test varies.
function status(overrides: Partial<LinearStatus>): LinearStatus {
  return {
    enabled: false,
    connected: false,
    keySource: null,
    teamId: null,
    direction: 'both',
    intervalSec: 60,
    statusMap: {},
    cursor: null,
    bootstrappedAt: null,
    lastSyncAt: null,
    lastError: null,
    lastSummary: null,
    syncing: false,
    ...overrides,
  };
}

function summary(overrides: Partial<LinearSyncSummary>): LinearSyncSummary {
  return {
    at: '2026-01-01T00:00:00.000Z',
    pulled: 0,
    pushed: 0,
    created: 0,
    createdIssues: 0,
    conflicts: 0,
    errors: [],
    rateLimited: false,
    ...overrides,
  };
}

const states: LinearWorkflowState[] = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog' },
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-done', name: 'Done', type: 'completed' },
];

describe('isLinearConfigured', () => {
  test('null status is not configured', () => {
    expect(isLinearConfigured(null)).toBe(false);
  });

  test('disconnected is not configured even with a team', () => {
    expect(
      isLinearConfigured(status({ connected: false, teamId: 'team-1' }))
    ).toBe(false);
  });

  test('connected with no team is not configured', () => {
    expect(isLinearConfigured(status({ connected: true, teamId: null }))).toBe(
      false
    );
  });

  test('connected with a blank team id is not configured', () => {
    expect(isLinearConfigured(status({ connected: true, teamId: '  ' }))).toBe(
      false
    );
  });

  test('connected with a team is configured', () => {
    expect(
      isLinearConfigured(status({ connected: true, teamId: 'team-1' }))
    ).toBe(true);
  });
});

describe('resolveMappedStateId', () => {
  test('undefined resolves to the unmapped sentinel', () => {
    expect(resolveMappedStateId(undefined, states)).toBe(NO_LINEAR_STATE);
  });

  test('an empty/whitespace name resolves to the unmapped sentinel', () => {
    expect(resolveMappedStateId('  ', states)).toBe(NO_LINEAR_STATE);
  });

  test('matches a state name case-insensitively', () => {
    expect(resolveMappedStateId('done', states)).toBe('s-done');
  });

  test('a name from a different team (no longer a real state) resolves to unmapped', () => {
    expect(resolveMappedStateId('In Review', states)).toBe(NO_LINEAR_STATE);
  });
});

describe('statusMapCompleteness', () => {
  test('counts mapped vs unmapped statuses', () => {
    const result = statusMapCompleteness(
      ['backlog', 'todo', 'done', 'cancelled'],
      { backlog: 'Backlog', todo: 'Todo', done: 'Stale Name' },
      states
    );
    expect(result).toEqual({
      mapped: 2,
      total: 4,
      unmapped: ['done', 'cancelled'],
    });
  });

  test('every status mapped', () => {
    const result = statusMapCompleteness(
      ['backlog', 'todo'],
      { backlog: 'Backlog', todo: 'Todo' },
      states
    );
    expect(result).toEqual({ mapped: 2, total: 2, unmapped: [] });
  });
});

describe('formatSyncCounts', () => {
  test('an all-zero summary reads as nothing changed', () => {
    expect(formatSyncCounts(summary({}))).toBe('Nothing changed');
  });

  test('omits zero-valued counts and joins the rest', () => {
    expect(
      formatSyncCounts(summary({ pulled: 3, pushed: 1, conflicts: 2 }))
    ).toBe('3 pulled · 1 pushed · 2 conflict(s) kept local');
  });

  test('reports every count when all are non-zero', () => {
    expect(
      formatSyncCounts(
        summary({
          pulled: 1,
          pushed: 2,
          created: 3,
          createdIssues: 4,
          conflicts: 5,
        })
      )
    ).toBe(
      '1 pulled · 2 pushed · 3 created locally · 4 created in Linear · 5 conflict(s) kept local'
    );
  });
});

describe('resolveLinearLink', () => {
  const links: Record<string, LinearIssueLink> = {
    'uuid-1': {
      identifier: 'ENG-123',
      url: 'https://linear.app/x/issue/ENG-123',
    },
  };

  test('null for an unlinked task', () => {
    expect(resolveLinearLink(null, links)).toBeNull();
  });

  test('null for a non-Linear external value', () => {
    expect(resolveLinearLink('jira:ABC-1', links)).toBeNull();
  });

  test('resolves a linked uuid present in the map', () => {
    expect(resolveLinearLink('linear:uuid-1', links)).toEqual({
      identifier: 'ENG-123',
      url: 'https://linear.app/x/issue/ENG-123',
    });
  });

  test('null for a linked uuid the map has no entry for yet', () => {
    expect(resolveLinearLink('linear:uuid-2', links)).toBeNull();
  });
});
