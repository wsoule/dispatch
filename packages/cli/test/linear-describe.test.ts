import { describe, expect, test } from 'bun:test';

import type {
  LinearCapacity,
  LinearCoverage,
  LinearStatus,
  LinearSyncSummary,
  LinearUnlinkedTask,
} from '../src/apiClient.js';
import {
  describeBulkOutcome,
  describeCapacity,
  describeCoverage,
  describeExportPreview,
  describeLinearStatus,
  describeLinearSummary,
  formatProgress,
  parsePushArgs,
} from '../src/commands/linear.js';
import { CliError } from '../src/context.js';

// A status as a daemon predating export/coverage/capacity answers it.
const OLD_STATUS: LinearStatus = {
  enabled: true,
  connected: true,
  keySource: 'project',
  teamId: 'abcdef1234567890',
  direction: 'both',
  intervalSec: 300,
  bootstrappedAt: '2026-10-01T00:00:00.000Z',
  lastSyncAt: '2026-10-25T10:00:00.000Z',
  lastError: null,
  lastSummary: null,
  syncing: false,
};

const SUMMARY: LinearSyncSummary = {
  at: '2026-10-25T10:00:00.000Z',
  pulled: 2,
  pushed: 1,
  created: 0,
  createdIssues: 3,
  conflicts: 0,
  errors: [],
  rateLimited: false,
};

function unlinked(
  id: string,
  reason: string,
  extra: Partial<LinearUnlinkedTask> = {}
): LinearUnlinkedTask {
  return {
    id,
    title: `Task ${id}`,
    kind: 'task',
    status: 'todo',
    finished: false,
    archived: false,
    reason,
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    retryAt: null,
    ...extra,
  };
}

function coverage(rows: LinearUnlinkedTask[]): LinearCoverage {
  const counts: Partial<Record<string, number>> = {};
  for (const r of rows) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
  return {
    total: 10 + rows.length,
    linked: 10,
    notLinked: rows.length,
    excluded: { derived: 0 },
    byEntity: { issue: 10, project: 0, milestone: 0, initiative: 0 },
    counts,
    unlinked: rows,
  };
}

const CAPACITY: LinearCapacity = {
  teams: [
    {
      id: 't1',
      key: 'DIS',
      name: 'Dispatch',
      active: 240,
      completed: 120,
      canceled: 23,
    },
  ],
  active: 240,
  activeScope: 'workspace',
  limit: 250,
  limitSource: 'plan',
  plan: 'free',
  limitHitAt: null,
  truncated: false,
  checkedAt: '2026-10-25T10:00:00.000Z',
};

describe('describeLinearStatus', () => {
  test('not connected says where to connect', () => {
    const lines = describeLinearStatus({ ...OLD_STATUS, connected: false });
    expect(lines).toEqual([
      "Linear isn't connected. Connect it in Settings → Linear; the key is kept for this project only.",
    ]);
  });

  test('connected but off names the key source', () => {
    const text = describeLinearStatus({
      ...OLD_STATUS,
      enabled: false,
      keySource: 'env',
    }).join('\n');
    expect(text).toContain('key from LINEAR_API_KEY');
    expect(text).toContain('sync is off');
  });

  test('pull-only, extra teams and the last pass', () => {
    const text = describeLinearStatus({
      ...OLD_STATUS,
      direction: 'pull',
      teamIds: ['abcdef1234567890', 'b', 'c'],
      lastSummary: SUMMARY,
    }).join('\n');
    expect(text).toContain(
      'Syncing from Linear only with team abcdef12 and 2 more, every 300s.'
    );
    expect(text).toContain('2 pulled · 1 pushed · 3 created in Linear');
  });

  test('an older daemon without the new fields prints no undefined', () => {
    const text = describeLinearStatus(OLD_STATUS).join('\n');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    expect(text).toContain('Last synced 2026-10-25T10:00:00.000Z.');
  });

  test('a capacity pause says it stopped creating, once', () => {
    const message =
      'Workspace is at its issue limit — archive closed issues or upgrade';
    const lines = describeLinearStatus(
      {
        ...OLD_STATUS,
        lastError: message,
        capacity: {
          limitedAt: '2026-10-25T10:00:00.000Z',
          retryAt: '2026-10-25T10:30:00.000Z',
          message,
          active: 250,
          limit: 250,
          limitSource: 'plan',
          plan: 'free',
          checkedAt: null,
        },
      },
      { now: new Date('2026-10-25T10:05:00.000Z') }
    );
    const text = lines.join('\n');
    expect(text).toContain(`Stopped creating in Linear: ${message}.`);
    expect(text).toContain('dispatch linear capacity');
    expect(lines.filter((l) => l.includes(message))).toHaveLength(1);
  });

  test('coverage counts, failures and the not-linked-yet hint', () => {
    const text = describeLinearStatus({
      ...OLD_STATUS,
      bootstrappedAt: null,
      coverage: {
        total: 40,
        linked: 30,
        notLinked: 10,
        heldBack: 6,
        queued: 2,
        failed: 2,
        excluded: 0,
      },
    }).join('\n');
    expect(text).toContain(
      '10 of 40 tasks are not in Linear; see dispatch linear coverage.'
    );
    expect(text).toContain('dispatch linear push --failed');
    expect(text).toContain('2 queued for Linear');
    expect(text).toContain('Not linked yet');
    expect(text).toContain('dispatch linear push --unlinked');
  });

  test('a running export shows its progress', () => {
    const text = describeLinearStatus({
      ...OLD_STATUS,
      syncing: true,
      running: { action: 'export', startedAt: '2026-10-25T10:00:00.000Z' },
      progress: { phase: 'creating', done: 12, total: 40, action: 'export' },
    }).join('\n');
    expect(text).toContain('An export to Linear is running');
    expect(text).toContain('Creating in Linear… 12 of 40');
  });
});

describe('describeLinearSummary', () => {
  test('a no-op pass says nothing changed', () => {
    expect(
      describeLinearSummary({
        ...SUMMARY,
        pulled: 0,
        pushed: 0,
        createdIssues: 0,
      })
    ).toEqual(['Nothing changed']);
  });

  test('collapses repeated errors and names the limit', () => {
    const text = describeLinearSummary({
      ...SUMMARY,
      usageLimited: true,
      errors: [
        'usage limit exceeded',
        'usage limit exceeded',
        'usage limit exceeded',
        'other',
      ],
    }).join('\n');
    expect(text).toContain('Error: usage limit exceeded (x3)');
    expect(text).toContain('Error: other');
    expect(text).not.toContain('Error: other (x');
    expect(text).toContain('dispatch linear archive-closed');
  });
});

describe('describeBulkOutcome', () => {
  test('an export halted at the limit says what is left', () => {
    const text = describeBulkOutcome({
      action: 'export',
      startedAt: 's',
      at: 'a',
      scope: 'all-archive-finished',
      candidates: 40,
      done: 10,
      archivedOnArrival: 4,
      remaining: 30,
      halted: 'usage-limit',
      errors: ['usage limit exceeded (x30)'],
    }).join('\n');
    expect(text).toContain('10 of 40 sent to Linear, 4 archived on arrival.');
    expect(text).toContain('30 not sent yet');
    expect(text).toContain("Linear's issue limit stopped it");
    expect(text).toContain('Error: usage limit exceeded (x30)');
  });
});

describe('describeCoverage', () => {
  const rows = [
    unlinked('t-fail', 'failed', {
      lastError: 'label refused',
      attempts: 3,
      lastAttemptAt: '2026-10-25T10:00:00.000Z',
    }),
    unlinked('t-cap', 'at-capacity'),
    ...Array.from({ length: 5 }, (_, i) => unlinked(`t-old${i}`, 'held-back')),
    unlinked('t-new', 'whatever-next'),
  ];

  test('a table with the reasons, then the hints', () => {
    const text = describeCoverage(coverage(rows)).join('\n');
    expect(text).toContain('10 of 18 tasks are in Linear (55%).');
    expect(text).toContain('label refused');
    expect(text).toContain('2026-10-25 10:00 (3 tries)');
    expect(text).toContain("Linear's issue limit");
    expect(text).toContain('predates the link');
    // An unknown reason prints raw.
    expect(text).toContain('whatever-next');
    expect(text).toContain('Push them: dispatch linear push --unlinked');
    expect(text).toContain('Retry failures: dispatch linear push --failed');
  });

  test('cuts at the limit and says how many more', () => {
    const text = describeCoverage(coverage(rows), { limit: 3 }).join('\n');
    expect(text).toContain('... and 5 more (--all lists every one)');
    expect(text).not.toContain('t-old4');
  });

  test('failedOnly lists failures only', () => {
    const text = describeCoverage(coverage(rows), { failedOnly: true }).join(
      '\n'
    );
    expect(text).toContain('t-fail');
    expect(text).toContain('t-cap');
    expect(text).not.toContain('t-old0');
    expect(text).not.toContain('Push them');
    expect(
      describeCoverage(coverage([unlinked('t-a', 'held-back')]), {
        failedOnly: true,
      })
    ).toContain('Nothing failed.');
  });
});

describe('describeCapacity', () => {
  test('a known limit shows the room left and what archiving frees', () => {
    const text = describeCapacity(CAPACITY).join('\n');
    expect(text).toContain(
      'DIS Dispatch: 240 active issues (120 completed, 23 canceled)'
    );
    expect(text).toContain(
      'Workspace: 240 of 250 active issues (free plan); room for 10.'
    );
    expect(text).toContain(
      '120 completed and 23 canceled issues could be archived'
    );
    expect(text).toContain('dispatch linear archive-closed [--canceled]');
  });

  test('an unknown limit says Linear reports none', () => {
    const text = describeCapacity({
      ...CAPACITY,
      limit: null,
      limitSource: null,
      plan: 'paid',
      teams: [],
    }).join('\n');
    expect(text).toContain(
      'Linear reports no issue limit for this workspace (paid plan)'
    );
    expect(text).not.toContain('archive-closed');
  });

  test('an unread plan never claims there is no limit', () => {
    const text = describeCapacity({
      ...CAPACITY,
      limit: null,
      limitSource: null,
      plan: 'unknown',
    }).join('\n');
    expect(text).not.toContain('no issue limit');
    expect(text).toContain(
      'Linear did not say whether this workspace has an issue limit (plan unknown)'
    );
  });
});

describe('describeExportPreview', () => {
  const preview = {
    open: 20,
    all: 30,
    allArchiveFinished: 35,
    finished: 10,
    archived: 5,
    derived: 2,
    containers: 3,
  };

  test('one scope, with the capacity warning when it will not fit', () => {
    const text = describeExportPreview(preview, 'all', CAPACITY).join('\n');
    expect(text).toContain(
      'Would send 30 tasks to Linear: 20 open, 10 finished (arriving closed).'
    );
    expect(text).toContain('3 of them are projects');
    expect(text).toContain('Room for 10 more issues in Linear');
  });

  test('archived arrivals keep no slot, so only the open tasks count', () => {
    // Room for 10: the 9 open tasks fit, and each archived arrival frees its
    // slot again as it lands.
    const roomy = { ...preview, open: 9 };
    const fits = describeExportPreview(
      roomy,
      'all-archive-finished',
      CAPACITY
    ).join('\n');
    expect(fits).not.toContain('Room for');
    // With every slot taken by open tasks, an arrival has none to land in.
    const full = describeExportPreview(
      { ...preview, open: 10 },
      'all-archive-finished',
      CAPACITY
    ).join('\n');
    expect(full).toContain('Room for 10 more issues in Linear');
  });

  test('every scope when none is named', () => {
    const text = describeExportPreview(preview, null).join('\n');
    expect(text).toContain('--unlinked             20 open tasks');
    expect(text).toContain('--archive-on-arrival   35 tasks');
  });
});

describe('formatProgress', () => {
  test('known phases read as words, an unknown one prints raw', () => {
    expect(formatProgress({ phase: 'issues', done: 1200, total: null })).toBe(
      'Fetching issues… 1,200'
    );
    expect(formatProgress({ phase: 'archiving', done: 3, total: 143 })).toBe(
      'Archiving in Linear… 3 of 143'
    );
    expect(formatProgress({ phase: 'rebalancing', done: 1, total: 2 })).toBe(
      'rebalancing… 1 of 2'
    );
  });
});

describe('parsePushArgs', () => {
  function refusal(ids: string[], opts: Parameters<typeof parsePushArgs>[1]) {
    try {
      parsePushArgs(ids, opts);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  }

  test('ids are checked and deduplicated', () => {
    expect(parsePushArgs(['t-a', 't-b', 't-a'], {})).toEqual({
      kind: 'ids',
      ids: ['t-a', 't-b'],
    });
    expect(refusal(['T-A'], {})).toBe('invalid task id: T-A');
  });

  test('export scopes', () => {
    expect(parsePushArgs([], { unlinked: true })).toEqual({
      kind: 'export',
      scope: 'open',
      dryRun: false,
    });
    expect(parsePushArgs([], { unlinked: true, scope: 'all' })).toEqual({
      kind: 'export',
      scope: 'all',
      dryRun: false,
    });
    expect(parsePushArgs([], { all: true, dryRun: true })).toEqual({
      kind: 'export',
      scope: 'all',
      dryRun: true,
    });
    for (const opts of [
      { archiveOnArrival: true },
      { all: true, archiveOnArrival: true },
      { unlinked: true, scope: 'all', archiveOnArrival: true },
    ])
      expect(parsePushArgs([], opts)).toEqual({
        kind: 'export',
        scope: 'all-archive-finished',
        dryRun: false,
      });
  });

  test('failed, forget and a bare dry run', () => {
    expect(parsePushArgs([], { failed: true })).toEqual({ kind: 'failed' });
    expect(parsePushArgs([], { forget: ['t-a', 't-a'] })).toEqual({
      kind: 'forget',
      ids: ['t-a'],
    });
    expect(parsePushArgs([], { dryRun: true })).toEqual({ kind: 'preview' });
  });

  test('refuses every bad combination', () => {
    const one =
      'push takes task ids, --unlinked, --all, --failed or --forget (one of them)';
    expect(refusal([], {})).toBe(one);
    expect(refusal(['t-a'], { all: true })).toBe(one);
    expect(refusal([], { unlinked: true, all: true })).toBe(one);
    expect(refusal([], { failed: true, forget: ['t-a'] })).toBe(one);
    expect(refusal([], { unlinked: true, scope: 'x' })).toBe(
      'invalid scope: x (expected open|all)'
    );
    expect(refusal([], { all: true, scope: 'all' })).toBe(
      '--scope goes with --unlinked'
    );
    expect(refusal([], { unlinked: true, archiveOnArrival: true })).toContain(
      'needs --scope all'
    );
    expect(refusal(['t-a'], { archiveOnArrival: true })).toContain(
      '--archive-on-arrival goes with'
    );
    expect(refusal([], { failed: true, dryRun: true })).toContain(
      '--dry-run previews an export'
    );
    expect(refusal([], { forget: ['nope'] })).toBe('invalid task id: nope');
  });
});
