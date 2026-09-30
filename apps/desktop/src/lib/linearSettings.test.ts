import { ApiError } from '@dispatch/client';
import type {
  LinearIssueLink,
  LinearStatus,
  LinearSyncSummary,
  LinearWebhookStatus,
} from '@dispatch/client';
import { describe, expect, it, test } from 'bun:test';

import {
  describeFetchFailure,
  describeLinearDelivery,
  formatLinearProgress,
  formatSyncCounts,
  isLinearConfigured,
  linearKeySourceNote,
  pushToLinearError,
  resolveLinearLink,
  STATUS_ROLE_ROWS,
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

describe('formatSyncCounts', () => {
  test('an all-zero summary reads as nothing changed', () => {
    expect(formatSyncCounts(summary({}))).toBe('Nothing changed');
  });

  test('omits zero-valued counts and joins the rest', () => {
    expect(
      formatSyncCounts(summary({ pulled: 3, pushed: 1, conflicts: 2 }))
    ).toBe('3 pulled · 1 pushed · 2 conflict(s) resolved');
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
      '1 pulled · 2 pushed · 3 created locally · 4 created in Linear · 5 conflict(s) resolved'
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

describe('pushToLinearError', () => {
  test('reports the first error when the push failed', () => {
    expect(pushToLinearError(summary({ errors: ['team not found'] }))).toBe(
      'team not found'
    );
  });

  // A pull-only project skips the push entirely and still returns a clean summary.
  test('reports a skipped push rather than claiming success', () => {
    expect(pushToLinearError(summary({}))).toContain('Nothing was pushed');
  });

  test('reports a rate-limited pass that pushed nothing', () => {
    expect(pushToLinearError(summary({ rateLimited: true }))).toContain(
      'Nothing was pushed'
    );
  });

  test('null when an issue was created in Linear', () => {
    expect(pushToLinearError(summary({ createdIssues: 1 }))).toBeNull();
  });

  test('null when an existing issue was updated', () => {
    expect(pushToLinearError(summary({ pushed: 1 }))).toBeNull();
  });
});

describe('linearKeySourceNote', () => {
  test('says nothing when the project has its own key', () => {
    expect(linearKeySourceNote('project')).toBeNull();
  });

  test('names the environment variable when that is what resolved', () => {
    expect(linearKeySourceNote('env')).toContain('LINEAR_API_KEY');
  });

  // The env note carries two remedies: override per-project (connect here), or stop using the
  // env key entirely (unset + restart) — pin the second so it can't quietly drop again.
  test('gives the restart remedy for stopping the environment key entirely', () => {
    expect(linearKeySourceNote('env')).toContain('restart Dispatch');
  });

  test('explains that a shared key can be overridden per project', () => {
    const note = linearKeySourceNote('global');
    expect(note).not.toBeNull();
    expect(note).toContain('this project');
  });

  test('falls back to the first-connection copy when there is no key', () => {
    expect(linearKeySourceNote(null)).toContain('Paste a Linear API key');
  });
});

describe('describeFetchFailure', () => {
  // The real client throws ApiError('<server prose>', <status>) — the message never contains
  // the status digits, so these must be built the way the client actually builds them.
  it('reads a 401 as a rejected key rather than a missing one', () => {
    expect(
      describeFetchFailure(new ApiError('Authentication required', 401))
    ).toContain('rejected');
  });

  it('reads a 409 as no key configured', () => {
    expect(
      describeFetchFailure(new ApiError('no Linear API key configured', 409))
    ).toContain('No Linear API key');
  });

  it('passes an unrecognised failure through rather than inventing a cause', () => {
    expect(describeFetchFailure(new Error('socket hang up'))).toContain(
      'socket hang up'
    );
  });

  // A 502 from Linear itself is neither of the two named cases and must not be
  // mislabelled as one.
  it('passes an unnamed status through with its message', () => {
    expect(describeFetchFailure(new ApiError('upstream boom', 502))).toContain(
      'upstream boom'
    );
  });
});

describe('describeLinearDelivery', () => {
  function hook(overrides: Partial<LinearWebhookStatus>): LinearStatus {
    return status({
      webhook: {
        state: 'polling',
        url: null,
        lastDeliveryAt: null,
        error: null,
        pollSec: 30,
        ...overrides,
      },
    });
  }

  test('says changes are live when a webhook delivers them', () => {
    expect(
      describeLinearDelivery(hook({ state: 'active', pollSec: 300 }))
    ).toBe(
      'Live: Linear delivers changes as they happen. Polling every 300s as a safety net.'
    );
  });

  test('points at the missing public origin when it can only poll', () => {
    expect(describeLinearDelivery(hook({}))).toContain('--public-origin');
  });

  test('names a failed registration', () => {
    expect(
      describeLinearDelivery(
        hook({ state: 'error', url: 'https://x', error: 'admin required' })
      )
    ).toBe('Polling every 30s: registering a webhook failed (admin required).');
  });

  test('falls back to the interval for a daemon that reports no webhook', () => {
    expect(describeLinearDelivery(status({ intervalSec: 60 }))).toBe(
      'Polling every 60s.'
    );
  });
});

describe('formatLinearProgress', () => {
  test('counts up while the total is unknown, and against it once known', () => {
    expect(
      formatLinearProgress({ phase: 'issues', done: 1200, total: null })
    ).toBe('Fetching issues… 1,200');
    expect(
      formatLinearProgress({ phase: 'applying', done: 250, total: 2000 })
    ).toBe('Writing tasks… 250 of 2,000');
  });
});

describe('STATUS_ROLE_ROWS', () => {
  test('lists every lifecycle role once', () => {
    expect(STATUS_ROLE_ROWS.map((r) => r.key).sort()).toEqual([
      'dispatched',
      'dropped',
      'landed',
      'landing',
      'ready',
      'review',
    ]);
  });
});

describe('resolveLinearLink for containers', () => {
  test('resolves a linked project the same way as an issue', () => {
    const links: Record<string, LinearIssueLink> = {
      'proj-1': {
        identifier: 'Checkout',
        url: 'https://linear.app/x/project/p',
      },
    };
    expect(resolveLinearLink('linear-project:proj-1', links)).toEqual(
      links['proj-1']
    );
  });
});
