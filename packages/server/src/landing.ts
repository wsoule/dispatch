import type {
  MergeQueueEntry,
  MergeQueueSnapshot,
} from './orchestrator/mergeQueue.js';
// The landing feed (spec's unified PR table): a pure join of runs, the merge
// queue, and open/merged PRs into one ordered list of rows plus a landed
// history. No I/O and no wall-clock reads here — `now` is injected by the
// caller (Task 5's HTTP handler) so this module stays trivially testable and
// reusable by the desktop client (Task 8/9).
import type { RepoPr } from './orchestrator/pr.js';
import type { RunMeta } from './orchestrator/types.js';

export type GateStatus =
  | 'ready'
  | 'waiting-checks'
  | 'waiting-review'
  | 'conflicts'
  | 'draft'
  | 'queue-position'
  | 'verifying'
  | 'merging'
  | 'blocked'
  | 'none';

export interface LandingGate {
  status: GateStatus;
  detail: string;
}

export interface LandingWorktree {
  path: string;
  syncState: 'synced' | 'behind' | 'dirty-hold';
  headOid: string;
}

export interface LandingRow {
  id: string; // 'pr-<n>' | 'run-<runId>' — queue rows keep their run id
  kind: 'pr' | 'run-pr' | 'queue-local';
  title: string;
  taskId?: string;
  runId?: string;
  pr?: RepoPr;
  queue?: { position: number; entry: MergeQueueEntry };
  gate: LandingGate;
  worktree?: LandingWorktree;
}

export interface LandedRow {
  id: string;
  title: string;
  via: 'pr' | 'local';
  prNumber?: number;
  mergeCommit?: string;
  finishedAt: string;
}

export interface LandingSnapshot {
  rows: LandingRow[];
  landed: LandedRow[];
  generatedAt: string;
}

// Terminal-and-unreviewed run states — duplicated from
// orchestrator/types.ts's TERMINAL_RUN_STATES rather than importing the
// value, so this module only ever pulls types from the orchestrator layer.
const TERMINAL_RUN_STATES: ReadonlySet<RunMeta['state']> = new Set([
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
]);

// Active queue states that pre-empt every PR-derived signal: a merge already
// in flight (or about to be, mid-rebase) or a hard environment block outranks
// whatever GitHub currently reports about the PR — the queue state IS what's
// happening right now.
function queueTopGate(entry: MergeQueueEntry): LandingGate | null {
  if (entry.state === 'merging' || entry.state === 'rebasing') {
    return { status: 'merging', detail: 'merging now' };
  }
  if (entry.state === 'verifying') {
    return { status: 'verifying', detail: 'running verify pipeline' };
  }
  if (entry.state === 'blocked-environment') {
    return {
      status: 'blocked',
      detail: entry.reason ?? 'blocked on the main checkout',
    };
  }
  return null;
}

// The single precedence order for a row's action gate: queue-active states
// first (they describe what's happening right now), then the PR's own
// blockers (conflicts/draft/checks/review), then the queue's own waiting
// position, then a plain "ready", then nothing known at all. First match
// wins — see task-4-brief.md's table for the exact ordering this mirrors.
export function computeGate(input: {
  pr?: RepoPr;
  queue?: { position: number; entry: MergeQueueEntry };
}): LandingGate {
  const { pr, queue } = input;

  if (queue !== undefined) {
    const top = queueTopGate(queue.entry);
    if (top !== null) return top;
  }

  if (pr !== undefined) {
    if (pr.mergeable === 'CONFLICTING') {
      return { status: 'conflicts', detail: 'conflicts with base branch' };
    }
    if (pr.isDraft) {
      return { status: 'draft', detail: 'draft PR' };
    }
    if (pr.checks.failed > 0) {
      const n = pr.checks.failed;
      return {
        status: 'waiting-checks',
        detail: `${n} check${n === 1 ? '' : 's'} failing`,
      };
    }
    if (pr.checks.pending > 0) {
      return {
        status: 'waiting-checks',
        detail: `waiting on CI · ${pr.checks.pending} running`,
      };
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      return { status: 'waiting-review', detail: 'changes requested' };
    }
    if (pr.reviewDecision === 'REVIEW_REQUIRED') {
      return { status: 'waiting-review', detail: 'awaiting review' };
    }
  }

  if (queue !== undefined) {
    const detail =
      queue.entry.state === 'waiting-blockers'
        ? 'waiting on blockers'
        : `#${queue.position} in queue`;
    return { status: 'queue-position', detail };
  }

  if (pr !== undefined) {
    return { status: 'ready', detail: 'ready to merge' };
  }

  return { status: 'none', detail: '' };
}

export type LandingGroup = 'needs-you' | 'in-queue' | 'waiting-github' | 'open';

// Buckets a row's gate into the four sections the landing page renders,
// per task-4-brief.md's mapping. `pr` disambiguates the two gate statuses
// that cover two distinct situations each (waiting-checks: failing vs
// pending; waiting-review: changes-requested vs review-required) — the
// desktop reuses this exact function (Task 8), so the mapping lives here
// once rather than being re-derived per surface.
export function groupForGate(gate: LandingGate, pr?: RepoPr): LandingGroup {
  switch (gate.status) {
    case 'conflicts':
      return 'needs-you';
    case 'waiting-checks':
      return pr !== undefined && pr.checks.failed > 0
        ? 'needs-you'
        : 'waiting-github';
    case 'waiting-review':
      return pr?.reviewDecision === 'CHANGES_REQUESTED'
        ? 'needs-you'
        : 'waiting-github';
    case 'queue-position':
    case 'verifying':
    case 'merging':
    case 'blocked':
      return 'in-queue';
    case 'draft':
      return 'waiting-github';
    case 'ready':
    case 'none':
    default:
      return 'open';
  }
}

const GROUP_RANK: Record<LandingGroup, number> = {
  'needs-you': 0,
  'in-queue': 1,
  'waiting-github': 2,
  open: 3,
};

// Extracts a PR number from a GitHub PR URL — used to line up a run's
// `prUrl` against `mergedPrs` without importing pr.ts's own parsePrUrl (a
// runtime value), keeping this module's orchestrator imports type-only.
function prNumberFromUrl(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  return match !== undefined && match !== null ? Number(match[1]) : undefined;
}

// One queue entry, positioned 1-based within `queue.entries` — the order
// MergeQueueSnapshot itself already encodes.
function indexQueueByRunId(
  entries: MergeQueueEntry[]
): Map<string, { position: number; entry: MergeQueueEntry }> {
  const byRunId = new Map<
    string,
    { position: number; entry: MergeQueueEntry }
  >();
  entries.forEach((entry, i) => {
    byRunId.set(entry.runId, { position: i + 1, entry });
  });
  return byRunId;
}

// Joins runs, the merge queue, and open/merged PRs into the landing feed's
// row list and landed history. Pure: every timestamp comes from `now` or the
// inputs themselves, never Date.now(). See task-4-brief.md's ambiguity
// resolutions for the join/dedupe rules this implements.
export function buildLandingSnapshot(input: {
  runs: RunMeta[];
  queue: MergeQueueSnapshot;
  openPrs: RepoPr[];
  mergedPrs: RepoPr[];
  worktrees: Map<number, LandingWorktree>;
  now: string;
}): LandingSnapshot {
  const { runs, queue, openPrs, mergedPrs, worktrees, now } = input;
  const queueByRunId = indexQueueByRunId(queue.entries);
  const prByUrl = new Map(openPrs.map((pr) => [pr.url, pr]));

  // The urls of every open PR already claimed by a run-driven row, so the
  // PR-only pass below never double-lists it under kind 'pr'.
  const claimedPrUrls = new Set<string>();

  interface SortableRow {
    row: LandingRow;
    group: LandingGroup;
    queuePosition?: number;
    updatedAt: string;
  }
  const sortable: SortableRow[] = [];

  for (const run of runs) {
    // A reviewed run never produces a row — it either already landed (see
    // the `landed` history below) or was discarded, either way there is
    // nothing left to act on here.
    if (run.reviewedAt !== undefined) continue;

    const queued = queueByRunId.get(run.id);
    const isTerminal = TERMINAL_RUN_STATES.has(run.state);
    // Eligible only if it has a reviewable branch (terminal + unreviewed) or
    // is already sitting in the merge queue — a still-live run with no queue
    // entry has nothing to show yet.
    if (!isTerminal && queued === undefined) continue;

    const matchedPr =
      run.prUrl !== undefined ? prByUrl.get(run.prUrl) : undefined;
    const gate = computeGate({ pr: matchedPr, queue: queued });
    const group = groupForGate(gate, matchedPr);

    let row: LandingRow;
    if (matchedPr !== undefined) {
      claimedPrUrls.add(matchedPr.url);
      row = {
        id: `run-${run.id}`,
        kind: 'run-pr',
        title: matchedPr.title,
        taskId: run.taskId,
        runId: run.id,
        pr: matchedPr,
        queue: queued,
        gate,
        worktree: worktrees.get(matchedPr.number),
      };
    } else {
      row = {
        id: `run-${run.id}`,
        kind: 'queue-local',
        title: queued?.entry.taskTitle ?? run.taskTitle,
        taskId: run.taskId,
        runId: run.id,
        queue: queued,
        gate,
      };
    }
    sortable.push({
      row,
      group,
      queuePosition: queued?.position,
      updatedAt: matchedPr?.updatedAt ?? run.updatedAt,
    });
  }

  for (const pr of openPrs) {
    if (claimedPrUrls.has(pr.url)) continue;
    const gate = computeGate({ pr });
    sortable.push({
      row: {
        id: `pr-${pr.number}`,
        kind: 'pr',
        title: pr.title,
        pr,
        gate,
        worktree: worktrees.get(pr.number),
      },
      group: groupForGate(gate, pr),
      updatedAt: pr.updatedAt,
    });
  }

  sortable.sort((a, b) => {
    const rankDiff = GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (rankDiff !== 0) return rankDiff;
    const posDiff =
      (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity);
    if (posDiff !== 0) return posDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const rows = sortable.map((s) => s.row);

  // `landed`: merged queue-history entries (via 'pr' when the run that
  // merged had an open PR, 'local' otherwise) unioned with `mergedPrs`,
  // deduping a merged PR whose landing a history entry already covers.
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const landedNumbersFromHistory = new Set<number>();
  const landedFromHistory: LandedRow[] = [];
  for (const entry of queue.history) {
    if (entry.state !== 'merged') continue;
    const meta = runsById.get(entry.runId);
    const prNumber =
      meta?.prUrl !== undefined ? prNumberFromUrl(meta.prUrl) : undefined;
    if (prNumber !== undefined) landedNumbersFromHistory.add(prNumber);
    landedFromHistory.push({
      id: `landed-run-${entry.runId}`,
      title: meta?.taskTitle ?? entry.taskTitle,
      via: meta?.prUrl !== undefined ? 'pr' : 'local',
      prNumber,
      mergeCommit: meta?.mergeCommit,
      finishedAt: entry.finishedAt ?? entry.stateSince ?? entry.enqueuedAt,
    });
  }

  const landedFromPrs: LandedRow[] = mergedPrs
    .filter((pr) => !landedNumbersFromHistory.has(pr.number))
    .map((pr) => ({
      id: `landed-pr-${pr.number}`,
      title: pr.title,
      via: 'pr',
      prNumber: pr.number,
      finishedAt: pr.updatedAt,
    }));

  const landed = [...landedFromHistory, ...landedFromPrs].sort((a, b) =>
    b.finishedAt.localeCompare(a.finishedAt)
  );

  return { rows, landed, generatedAt: now };
}
