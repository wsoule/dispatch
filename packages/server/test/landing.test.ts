import { describe, expect, test } from 'bun:test';

import {
  buildLandingSnapshot,
  computeGate,
  type GateStatus,
  groupForGate,
  type LandingWorktree,
} from '../src/landing.js';
import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  MergeQueueSnapshot,
} from '../src/orchestrator/mergeQueue.js';
import type { PrCheckSummary, RepoPr } from '../src/orchestrator/pr.js';
import type { RunMeta } from '../src/orchestrator/types.js';

// Builds a PrCheckSummary with sane zeroed defaults, overridable per field —
// mirrors pr-checks.test.ts's own summarizeChecks fixtures.
function c(overrides: Partial<PrCheckSummary> = {}): PrCheckSummary {
  return { passed: 0, failed: 0, pending: 0, total: 0, runs: [], ...overrides };
}

// A green, mergeable, open PR by default — every computeGate test overrides
// only the field its precedence rule cares about.
function pr(overrides: Partial<RepoPr> = {}): RepoPr {
  return {
    number: 1,
    title: 'Some PR',
    url: 'https://github.com/acme/repo/pull/1',
    headRefName: 'feature',
    baseRefName: 'main',
    author: 'alice',
    isDraft: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
    headRefOid: 'abc123',
    state: 'OPEN',
    isCrossRepository: false,
    headRepositoryOwner: 'acme',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: c(),
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    ...overrides,
  };
}

// A queue entry/position pair in the shape computeGate's `queue` input takes.
function q(
  state: MergeQueueEntryState,
  position = 1
): { position: number; entry: MergeQueueEntry } {
  return {
    position,
    entry: {
      runId: 'r-1',
      taskId: 't-1',
      taskTitle: 'Task 1',
      state,
      enqueuedAt: '2026-08-01T00:00:00.000Z',
    },
  };
}

describe('computeGate', () => {
  const cases: Array<[string, Parameters<typeof computeGate>[0], GateStatus]> =
    [
      ['queue merging', { queue: q('merging') }, 'merging'],
      ['queue rebasing', { queue: q('rebasing') }, 'merging'],
      ['queue verifying', { queue: q('verifying') }, 'verifying'],
      ['queue failed/blocked', { queue: q('blocked-environment') }, 'blocked'],
      ['pr conflicts', { pr: pr({ mergeable: 'CONFLICTING' }) }, 'conflicts'],
      ['pr draft', { pr: pr({ isDraft: true }) }, 'draft'],
      [
        'failing checks',
        { pr: pr({ checks: c({ failed: 1 }) }) },
        'waiting-checks',
      ],
      [
        'pending checks',
        { pr: pr({ checks: c({ pending: 2 }) }) },
        'waiting-checks',
      ],
      [
        'changes requested',
        { pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }) },
        'waiting-review',
      ],
      [
        'review required',
        { pr: pr({ reviewDecision: 'REVIEW_REQUIRED' }) },
        'waiting-review',
      ],
      [
        'queued but green',
        { pr: pr({}), queue: q('queued', 3) },
        'queue-position',
      ],
      ['green, not queued', { pr: pr({}) }, 'ready'],
      ['nothing known', {}, 'none'],
    ];

  test.each(cases)('%s', (_name, input, expected) => {
    expect(computeGate(input).status).toBe(expected);
  });

  test('failing checks detail names the count', () => {
    expect(computeGate({ pr: pr({ checks: c({ failed: 1 }) }) }).detail).toBe(
      '1 check failing'
    );
  });

  test('pending checks detail names the running count', () => {
    expect(computeGate({ pr: pr({ checks: c({ pending: 2 }) }) }).detail).toBe(
      'waiting on CI · 2 running'
    );
  });

  test('changes-requested detail', () => {
    expect(
      computeGate({ pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }) }).detail
    ).toBe('changes requested');
  });

  test('queued but green detail names the position', () => {
    expect(computeGate({ pr: pr({}), queue: q('queued', 3) }).detail).toBe(
      '#3 in queue'
    );
  });

  test('rebasing detail matches merging', () => {
    expect(computeGate({ queue: q('rebasing') }).detail).toBe('merging now');
  });

  test('waiting-blockers queue state maps to queue-position with a blockers detail', () => {
    const gate = computeGate({ queue: q('waiting-blockers') });
    expect(gate).toEqual({
      status: 'queue-position',
      detail: 'waiting on blockers',
    });
  });

  // Precedence: a queue entry actively merging/verifying/blocked outranks
  // every PR-derived signal, even a PR reporting conflicts.
  test('queue merging outranks pr conflicts', () => {
    const gate = computeGate({
      pr: pr({ mergeable: 'CONFLICTING' }),
      queue: q('merging'),
    });
    expect(gate.status).toBe('merging');
  });

  test('failing checks outrank pending checks', () => {
    const gate = computeGate({
      pr: pr({ checks: c({ failed: 1, pending: 2 }) }),
    });
    expect(gate.status).toBe('waiting-checks');
    expect(gate.detail).toBe('1 check failing');
  });
});

describe('groupForGate', () => {
  test('conflicts is needs-you', () => {
    expect(groupForGate({ status: 'conflicts', detail: '' })).toBe('needs-you');
  });

  test('failing checks is needs-you, pending checks is waiting-github', () => {
    const failingPr = pr({ checks: c({ failed: 1 }) });
    expect(
      groupForGate({ status: 'waiting-checks', detail: '' }, failingPr)
    ).toBe('needs-you');
    const pendingPr = pr({ checks: c({ pending: 1 }) });
    expect(
      groupForGate({ status: 'waiting-checks', detail: '' }, pendingPr)
    ).toBe('waiting-github');
  });

  test('changes-requested is needs-you, review-required is waiting-github', () => {
    const changesPr = pr({ reviewDecision: 'CHANGES_REQUESTED' });
    expect(
      groupForGate({ status: 'waiting-review', detail: '' }, changesPr)
    ).toBe('needs-you');
    const reviewPr = pr({ reviewDecision: 'REVIEW_REQUIRED' });
    expect(
      groupForGate({ status: 'waiting-review', detail: '' }, reviewPr)
    ).toBe('waiting-github');
  });

  test('queue-position/verifying/merging/blocked are in-queue', () => {
    for (const status of [
      'queue-position',
      'verifying',
      'merging',
      'blocked',
    ] as const) {
      expect(groupForGate({ status, detail: '' })).toBe('in-queue');
    }
  });

  test('draft is waiting-github', () => {
    expect(groupForGate({ status: 'draft', detail: '' })).toBe(
      'waiting-github'
    );
  });

  test('ready and none are open', () => {
    expect(groupForGate({ status: 'ready', detail: '' })).toBe('open');
    expect(groupForGate({ status: 'none', detail: '' })).toBe('open');
  });
});

// Minimal RunMeta builder — only the fields buildLandingSnapshot actually
// reads need real values; everything else is fixed filler.
function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Task 1',
    executor: 'fake',
    state: 'finished',
    branch: 'run/r-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt-r-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function entry(overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    runId: 'r-1',
    taskId: 't-1',
    taskTitle: 'Task 1',
    state: 'queued',
    enqueuedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<MergeQueueSnapshot> = {}
): MergeQueueSnapshot {
  return { entries: [], history: [], ...overrides };
}

const NOW = '2026-08-10T12:00:00.000Z';
const NO_WORKTREES = new Map<number, LandingWorktree>();

describe('buildLandingSnapshot', () => {
  test('a run whose prUrl matches an open PR produces one run-pr row carrying both pr and queue', () => {
    const meta = run({ prUrl: 'https://github.com/acme/repo/pull/5' });
    const openPr = pr({
      number: 5,
      url: 'https://github.com/acme/repo/pull/5',
      title: 'PR Five',
    });
    const result = buildLandingSnapshot({
      runs: [meta],
      queue: snapshot({ entries: [entry()] }),
      openPrs: [openPr],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.kind).toBe('run-pr');
    expect(row.id).toBe('run-r-1');
    expect(row.title).toBe('PR Five');
    expect(row.taskId).toBe('t-1');
    expect(row.runId).toBe('r-1');
    expect(row.pr?.number).toBe(5);
    expect(row.queue?.position).toBe(1);
  });

  test('a queue entry whose run has no prUrl produces a queue-local row with no pr', () => {
    const result = buildLandingSnapshot({
      runs: [run()],
      queue: snapshot({ entries: [entry()] }),
      openPrs: [],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.kind).toBe('queue-local');
    expect(row.pr).toBeUndefined();
    expect(row.title).toBe('Task 1');
    expect(row.queue?.position).toBe(1);
  });

  test('a terminal unreviewed run with no prUrl and no queue entry still produces a queue-local row', () => {
    const result = buildLandingSnapshot({
      runs: [run()],
      queue: snapshot(),
      openPrs: [],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].kind).toBe('queue-local');
    expect(result.rows[0].queue).toBeUndefined();
  });

  test('a live (non-terminal) run with no queue entry produces no row', () => {
    const result = buildLandingSnapshot({
      runs: [run({ state: 'running' })],
      queue: snapshot(),
      openPrs: [],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows).toHaveLength(0);
  });

  test('an open PR with no matching run produces a pr row', () => {
    const openPr = pr({
      number: 9,
      url: 'https://github.com/acme/repo/pull/9',
      title: 'PR Nine',
    });
    const result = buildLandingSnapshot({
      runs: [],
      queue: snapshot(),
      openPrs: [openPr],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.kind).toBe('pr');
    expect(row.id).toBe('pr-9');
    expect(row.taskId).toBeUndefined();
    expect(row.runId).toBeUndefined();
  });

  test('a run whose PR merged before the poller flipped reviewedAt renders once, only in landed', () => {
    // Poller-lag window: reviewedAt still unset, but the PR is already gone
    // from openPrs and shows up in mergedPrs instead.
    const meta = run({ prUrl: 'https://github.com/acme/repo/pull/12' });
    const mergedPr = pr({
      number: 12,
      url: 'https://github.com/acme/repo/pull/12',
      title: 'Just merged',
      state: 'MERGED',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    const result = buildLandingSnapshot({
      runs: [meta],
      queue: snapshot(),
      openPrs: [],
      mergedPrs: [mergedPr],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.landed).toHaveLength(1);
    expect(result.landed[0]).toMatchObject({
      id: 'landed-pr-12',
      via: 'pr',
      prNumber: 12,
    });
  });

  test('a reviewed run produces no row', () => {
    const meta = run({
      reviewedAt: '2026-08-01T01:00:00.000Z',
      reviewAction: 'merge',
    });
    const result = buildLandingSnapshot({
      runs: [meta],
      queue: snapshot(),
      openPrs: [],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows).toHaveLength(0);
  });

  test('rows sort by group rank, then queue position, then updatedAt desc', () => {
    // needs-you: a PR with conflicts.
    const conflictPr = pr({
      number: 1,
      url: 'https://github.com/acme/repo/pull/1',
      updatedAt: '2026-08-05T00:00:00.000Z',
      mergeable: 'CONFLICTING',
    });
    // in-queue: two queue-local rows at different positions.
    const runA = run({
      id: 'r-a',
      taskId: 't-a',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const runB = run({
      id: 'r-b',
      taskId: 't-b',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    const entryA = entry({ runId: 'r-a', taskId: 't-a' });
    const entryB = entry({ runId: 'r-b', taskId: 't-b' });
    // open: a plain green PR.
    const openPr = pr({
      number: 2,
      url: 'https://github.com/acme/repo/pull/2',
      updatedAt: '2026-08-09T00:00:00.000Z',
    });
    const result = buildLandingSnapshot({
      runs: [runA, runB],
      // entryB enqueued before entryA, so entryB is position 1.
      queue: snapshot({ entries: [entryB, entryA] }),
      openPrs: [conflictPr, openPr],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.rows.map((r) => r.id)).toEqual([
      'pr-1',
      'run-r-b',
      'run-r-a',
      'pr-2',
    ]);
  });

  test('landed unions merged queue history with mergedPrs, deduping a PR a history entry already covers', () => {
    const mergedMeta = run({
      id: 'r-merged',
      taskId: 't-merged',
      taskTitle: 'Merged via PR',
      prUrl: 'https://github.com/acme/repo/pull/7',
      mergeCommit: 'deadbeef',
      reviewedAt: '2026-08-03T00:00:00.000Z',
      reviewAction: 'pr',
    });
    const localMergedMeta = run({
      id: 'r-local',
      taskId: 't-local',
      taskTitle: 'Merged locally',
      mergeCommit: 'cafebabe',
      reviewedAt: '2026-08-04T00:00:00.000Z',
      reviewAction: 'merge',
    });
    const historyEntryPr = entry({
      runId: 'r-merged',
      taskId: 't-merged',
      taskTitle: 'Merged via PR',
      state: 'merged',
      finishedAt: '2026-08-03T00:00:00.000Z',
    });
    const historyEntryLocal = entry({
      runId: 'r-local',
      taskId: 't-local',
      taskTitle: 'Merged locally',
      state: 'merged',
      finishedAt: '2026-08-04T00:00:00.000Z',
    });
    // A merged PR the history already covers (#7) — its own row should be
    // dropped in favor of the history entry.
    const coveredPr = pr({
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
      title: 'Merged via PR',
      state: 'MERGED',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    // A merged PR dispatch never opened a run for at all.
    const uncoveredPr = pr({
      number: 8,
      url: 'https://github.com/acme/repo/pull/8',
      title: 'Someone else merged this',
      state: 'MERGED',
      updatedAt: '2026-08-05T00:00:00.000Z',
    });
    const result = buildLandingSnapshot({
      runs: [mergedMeta, localMergedMeta],
      queue: snapshot({ history: [historyEntryLocal, historyEntryPr] }),
      openPrs: [],
      mergedPrs: [coveredPr, uncoveredPr],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.landed.map((l) => l.id)).toEqual([
      'landed-pr-8',
      'landed-run-r-local',
      'landed-run-r-merged',
    ]);
    const prRow = result.landed.find((l) => l.id === 'landed-run-r-merged')!;
    expect(prRow.via).toBe('pr');
    expect(prRow.prNumber).toBe(7);
    expect(prRow.mergeCommit).toBe('deadbeef');
    const localRow = result.landed.find((l) => l.id === 'landed-run-r-local')!;
    expect(localRow.via).toBe('local');
    expect(localRow.mergeCommit).toBe('cafebabe');
  });

  test('a failed queue-history entry is not landed', () => {
    const meta = run({
      id: 'r-failed',
      reviewedAt: undefined,
    });
    const result = buildLandingSnapshot({
      runs: [meta],
      queue: snapshot({
        history: [
          entry({
            runId: 'r-failed',
            state: 'failed',
            finishedAt: NOW,
            reason: 'boom',
          }),
        ],
      }),
      openPrs: [],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.landed).toHaveLength(0);
  });

  test('generatedAt is the injected now, verbatim', () => {
    const result = buildLandingSnapshot({
      runs: [],
      queue: snapshot(),
      openPrs: [],
      mergedPrs: [],
      worktrees: NO_WORKTREES,
      now: NOW,
    });
    expect(result.generatedAt).toBe(NOW);
  });
});
