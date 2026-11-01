import { ApiError } from '@dispatch/client';
import type {
  LinearBulkOutcome,
  LinearCapacity,
  LinearCoverage,
  LinearExportPreview,
  LinearIssueLink,
  LinearStatus,
  LinearSyncSummary,
  LinearUnlinkedTask,
  LinearWebhookStatus,
} from '@dispatch/client';
import { describe, expect, it, test } from 'bun:test';

import {
  archivableCount,
  capacityPaused,
  describeBulkOutcome,
  describeCapacity,
  describeFetchFailure,
  describeLinearDelivery,
  describeMigrated,
  describeUnlinkedCounts,
  exportActiveCount,
  exportScopeCount,
  formatLinearProgress,
  formatSyncCounts,
  formatUntil,
  isLinearConfigured,
  linearKeySourceNote,
  progressFor,
  pushToLinearError,
  resolveLinearLink,
  retryableTaskIds,
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

  test('reports archived issues and creates waiting to retry', () => {
    expect(formatSyncCounts(summary({ archivedIssues: 140, queued: 3 }))).toBe(
      '140 archived in Linear · 3 waiting to retry'
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

  test('names the export and archive phases', () => {
    expect(
      formatLinearProgress({
        phase: 'creating',
        done: 3,
        total: 47,
        action: 'export',
      })
    ).toBe('Creating issues… 3 of 47');
    expect(
      formatLinearProgress({
        phase: 'archiving',
        done: 10,
        total: 140,
        action: 'archive',
      })
    ).toBe('Archiving issues… 10 of 140');
  });
});

describe('progressFor', () => {
  test('a progress without an action belongs to an import', () => {
    const progress = { phase: 'issues' as const, done: 1, total: null };
    expect(progressFor(progress, 'import')).toBe(progress);
    expect(progressFor(progress, 'export')).toBeNull();
  });

  test('an export progress shows only on the export row', () => {
    const progress = {
      phase: 'creating' as const,
      done: 1,
      total: 2,
      action: 'export' as const,
    };
    expect(progressFor(progress, 'import')).toBeNull();
    expect(progressFor(progress, 'export')).toBe(progress);
    expect(progressFor(null, 'export')).toBeNull();
  });
});

function outcome(overrides: Partial<LinearBulkOutcome>): LinearBulkOutcome {
  return {
    action: 'export',
    startedAt: '2026-01-01T00:00:00.000Z',
    at: '2026-01-01T00:01:00.000Z',
    candidates: 47,
    done: 47,
    remaining: 0,
    halted: null,
    errors: [],
    ...overrides,
  };
}

describe('describeBulkOutcome', () => {
  test('null before the first run', () => {
    expect(describeBulkOutcome(null)).toBeNull();
    expect(describeBulkOutcome(undefined)).toBeNull();
  });

  test('a full export, with the issues archived on arrival', () => {
    expect(describeBulkOutcome(outcome({ archivedOnArrival: 12 }))).toBe(
      'Exported 47 of 47 · 12 archived on arrival'
    );
  });

  test('an export the issue limit stopped', () => {
    expect(
      describeBulkOutcome(
        outcome({
          candidates: 309,
          done: 262,
          remaining: 47,
          halted: 'usage-limit',
        })
      )
    ).toBe('Stopped after 262 of 309 at the issue limit');
  });

  test('a throttled archive says to run it again', () => {
    expect(
      describeBulkOutcome(
        outcome({
          action: 'archive',
          candidates: 140,
          done: 90,
          remaining: 50,
          halted: 'rate-limit',
        })
      )
    ).toBe(
      'Stopped after 90 of 140: Linear rate-limited the run; archive again for the rest'
    );
  });

  test('a retry that left some behind counts them', () => {
    expect(
      describeBulkOutcome(
        outcome({ action: 'retry', candidates: 5, done: 3, remaining: 2 })
      )
    ).toBe('Sent 3 of 5 · 2 left');
  });
});

const PREVIEW: LinearExportPreview = {
  open: 47,
  all: 309,
  allArchiveFinished: 320,
  finished: 262,
  archived: 11,
  derived: 2,
  containers: 3,
};

describe('export scope counts', () => {
  test('each scope sends its own count', () => {
    expect(exportScopeCount(PREVIEW, 'open')).toBe(47);
    expect(exportScopeCount(PREVIEW, 'all')).toBe(309);
    expect(exportScopeCount(PREVIEW, 'all-archive-finished')).toBe(320);
  });

  test('archiving finished tasks on arrival leaves only open work active', () => {
    expect(exportActiveCount(PREVIEW, 'all')).toBe(309);
    expect(exportActiveCount(PREVIEW, 'all-archive-finished')).toBe(47);
  });
});

function capacity(overrides: Partial<LinearCapacity>): LinearCapacity {
  return {
    teams: [
      {
        id: 'team-1',
        key: 'HYD',
        name: 'Hydrogen',
        active: 188,
        completed: 120,
        canceled: 20,
      },
    ],
    active: 188,
    activeScope: 'workspace',
    limit: 250,
    limitSource: 'plan',
    plan: 'free',
    limitHitAt: null,
    truncated: false,
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('describeCapacity', () => {
  test('null before anything was measured', () => {
    expect(describeCapacity(null)).toBeNull();
    expect(describeCapacity(capacity({ active: null }))).toBeNull();
  });

  test('a Free workspace against its limit', () => {
    expect(describeCapacity(capacity({}))).toBe(
      '188 of 250 active issues in the workspace on the Free plan'
    );
  });

  test('a paid workspace has no limit to count against', () => {
    expect(
      describeCapacity(
        capacity({ limit: null, limitSource: null, plan: 'paid', active: 1204 })
      )
    ).toBe(
      '1,204 active issues in the workspace on a paid plan, with no issue limit'
    );
  });

  test('an unknown plan names none, and several teams are split out', () => {
    const teams = [
      { ...capacity({}).teams[0], active: 120 },
      {
        id: 'team-2',
        key: 'OPS',
        name: 'Ops',
        active: 68,
        completed: 1,
        canceled: 0,
      },
    ];
    expect(
      describeCapacity(
        capacity({ plan: 'unknown', limit: null, limitSource: null, teams })
      )
    ).toBe('188 active issues in the workspace · HYD 120 · OPS 68');
  });
});

describe('archivableCount', () => {
  test('counts completed issues, and canceled ones only when asked', () => {
    expect(archivableCount(capacity({}), false)).toBe(120);
    expect(archivableCount(capacity({}), true)).toBe(140);
  });
});

describe('capacityPaused and formatUntil', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  test('paused only while retryAt is ahead', () => {
    const state = {
      limitedAt: null,
      retryAt: '2026-01-01T00:25:00.000Z',
      message: null,
      active: null,
      limit: null,
      limitSource: null,
      plan: 'free' as const,
      checkedAt: null,
    };
    expect(capacityPaused(state, now)).toBe(true);
    expect(capacityPaused({ ...state, retryAt: null }, now)).toBe(false);
    expect(capacityPaused(state, Date.parse('2026-01-01T01:00:00.000Z'))).toBe(
      false
    );
    expect(capacityPaused(null, now)).toBe(false);
  });

  test('reads a future time in minutes, then hours', () => {
    expect(formatUntil('2026-01-01T00:25:00.000Z', now)).toBe('in 25m');
    expect(formatUntil('2026-01-01T02:00:00.000Z', now)).toBe('in 2h');
  });
});

function unlinked(overrides: Partial<LinearUnlinkedTask>): LinearUnlinkedTask {
  return {
    id: 't-1',
    title: 'Task',
    kind: 'task',
    status: 'Todo',
    finished: false,
    archived: false,
    reason: 'pending',
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    retryAt: null,
    ...overrides,
  };
}

describe('coverage helpers', () => {
  const counts: LinearCoverage['counts'] = {
    failed: 12,
    'at-capacity': 0,
    queued: 0,
    'moved-out': 0,
    'pull-only': 0,
    'held-back': 47,
    pending: 2,
  };

  test('describeUnlinkedCounts omits empty reasons', () => {
    expect(describeUnlinkedCounts(counts)).toBe(
      '12 failed · 47 held back · 2 waiting for the next sync'
    );
  });

  test('describeUnlinkedCounts says when nothing is missing', () => {
    expect(
      describeUnlinkedCounts({
        ...counts,
        failed: 0,
        'held-back': 0,
        pending: 0,
      })
    ).toBe('Every task is in Linear.');
  });

  test('retryableTaskIds takes failed, capped and queued creates only', () => {
    const coverage: LinearCoverage = {
      total: 5,
      linked: 0,
      notLinked: 5,
      excluded: { derived: 0 },
      byEntity: { issue: 0, project: 0, milestone: 0, initiative: 0 },
      counts,
      unlinked: [
        unlinked({ id: 'a', reason: 'failed' }),
        unlinked({ id: 'b', reason: 'at-capacity' }),
        unlinked({ id: 'c', reason: 'queued' }),
        unlinked({ id: 'd', reason: 'held-back' }),
        unlinked({ id: 'e', reason: 'moved-out' }),
      ],
    };
    expect(retryableTaskIds(coverage)).toEqual(['a', 'b', 'c']);
  });
});

describe('describeMigrated', () => {
  test('says how many tasks moved onto the team’s workflow', () => {
    expect(describeMigrated(summary({ migrated: 309 }), 'Hydrogen')).toBe(
      'Moved 309 tasks onto Hydrogen’s workflow.'
    );
    expect(describeMigrated(summary({ migrated: 1 }), null)).toBe(
      'Moved 1 task onto the team’s workflow.'
    );
  });

  test('null for a pass that moved none, or a daemon that does not say', () => {
    expect(describeMigrated(summary({ migrated: 0 }), 'Hydrogen')).toBeNull();
    expect(describeMigrated(summary({}), 'Hydrogen')).toBeNull();
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
