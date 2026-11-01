import {
  isDoneStatus,
  isOutstanding,
  parseLinearExternal,
} from '@dispatch-foo/core';
import type {
  LinearConfig,
  StatusModel,
  TaskKind,
  TaskListItem,
  TaskMeta,
} from '@dispatch-foo/core';

import type { LinearExportScope, LinearSyncState } from './state.js';
import { accountedAt } from './state.js';

/** Why an unlinked task has no Linear record, in precedence order. */
type LinearUnlinkedReason =
  | 'failed'
  | 'at-capacity'
  | 'queued'
  | 'moved-out'
  | 'pull-only'
  | 'held-back'
  | 'pending';

const REASONS: readonly LinearUnlinkedReason[] = [
  'failed',
  'at-capacity',
  'queued',
  'moved-out',
  'pull-only',
  'held-back',
  'pending',
];

interface LinearUnlinkedTask {
  id: string;
  title: string;
  kind: TaskKind;
  status: string;
  finished: boolean;
  archived: boolean;
  reason: LinearUnlinkedReason;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  retryAt: string | null;
}

/** Which tasks have a Linear record, and why each of the rest does not. */
export interface LinearCoverage {
  /** Tasks that may sync: every task but derived ones. */
  total: number;
  linked: number;
  notLinked: number;
  excluded: { derived: number };
  byEntity: {
    issue: number;
    project: number;
    milestone: number;
    initiative: number;
  };
  counts: Record<LinearUnlinkedReason, number>;
  /** Failed first, then by reason, then by title. */
  unlinked: LinearUnlinkedTask[];
}

/** The cheap subset of LinearCoverage that status() carries. */
export interface LinearCoverageCounts {
  total: number;
  linked: number;
  notLinked: number;
  heldBack: number;
  queued: number;
  /** Creates that failed, the issue limit included. */
  failed: number;
  excluded: number;
}

/** How many tasks each export scope would send, for the confirm step. */
export interface LinearExportPreview {
  open: number;
  all: number;
  allArchiveFinished: number;
  /** Finished tasks 'all' sends, which arrive as closed issues. */
  finished: number;
  /** Archived tasks only 'all-archive-finished' sends. */
  archived: number;
  /** Derived tasks, which no scope sends. */
  derived: number;
  /** Tasks 'all' sends that are not plain tasks (projects, milestones,
   *  initiatives), so most take no issue slot. */
  containers: number;
}

interface CoverageOptions {
  direction: LinearConfig['direction'];
  model: StatusModel;
}

function zeroCounts(): Record<LinearUnlinkedReason, number> {
  return {
    failed: 0,
    'at-capacity': 0,
    queued: 0,
    'moved-out': 0,
    'pull-only': 0,
    'held-back': 0,
    pending: 0,
  };
}

// Why an unlinked task is unlinked: its queue entry first, then a move out
// of the linked teams, a pull-only link, and last whether it was held back.
function unlinkedReason(
  meta: TaskMeta,
  state: LinearSyncState,
  direction: LinearConfig['direction'],
  movedOut: ReadonlySet<string>
): LinearUnlinkedReason {
  const entry = state.pushQueue[meta.id];
  if (entry !== undefined) {
    if (entry.lastErrorKind === 'usage-limit') return 'at-capacity';
    return entry.lastError === null ? 'queued' : 'failed';
  }
  if (movedOut.has(meta.id)) return 'moved-out';
  if (direction === 'pull') return 'pull-only';
  const at = accountedAt(state, meta.id);
  if (at !== undefined && !isOutstanding(meta.updated, at)) return 'held-back';
  return 'pending';
}

// One walk over the board: each task linked, excluded or given its reason.
function walk(
  items: readonly TaskListItem[],
  state: LinearSyncState,
  { direction }: CoverageOptions,
  each: (meta: TaskMeta, reason: LinearUnlinkedReason) => void
): Omit<LinearCoverage, 'unlinked'> {
  const movedOut = new Set(Object.values(state.movedOut));
  const out: Omit<LinearCoverage, 'unlinked'> = {
    total: 0,
    linked: 0,
    notLinked: 0,
    excluded: { derived: 0 },
    byEntity: { issue: 0, project: 0, milestone: 0, initiative: 0 },
    counts: zeroCounts(),
  };
  for (const { meta } of items) {
    if (meta.derivedFrom !== undefined) {
      out.excluded.derived++;
      continue;
    }
    out.total++;
    const ref = parseLinearExternal(meta.external);
    if (ref !== null) {
      out.linked++;
      out.byEntity[ref.entity]++;
      continue;
    }
    out.notLinked++;
    const reason = unlinkedReason(meta, state, direction, movedOut);
    out.counts[reason]++;
    each(meta, reason);
  }
  return out;
}

/** Every task's Linear coverage, with the unlinked ones listed. */
export function linearCoverage(
  items: readonly TaskListItem[],
  state: LinearSyncState,
  opts: CoverageOptions
): LinearCoverage {
  const unlinked: LinearUnlinkedTask[] = [];
  const totals = walk(items, state, opts, (meta, reason) => {
    const entry = state.pushQueue[meta.id];
    unlinked.push({
      id: meta.id,
      title: meta.title,
      kind: meta.kind,
      status: meta.status,
      finished: isDoneStatus(meta.status, opts.model),
      archived: meta.archivedAt !== undefined,
      reason,
      attempts: entry?.attempts ?? 0,
      lastError: entry?.lastError ?? null,
      lastAttemptAt: entry?.lastAttemptAt ?? null,
      retryAt: entry?.retryAt ?? null,
    });
  });
  unlinked.sort((a, b) => {
    const byReason = REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason);
    return byReason !== 0 ? byReason : a.title.localeCompare(b.title);
  });
  return { ...totals, unlinked };
}

/** The coverage counts alone, without building the unlinked list. */
export function coverageCounts(
  items: readonly TaskListItem[],
  state: LinearSyncState,
  opts: CoverageOptions
): LinearCoverageCounts {
  const c = walk(items, state, opts, () => undefined);
  return {
    total: c.total,
    linked: c.linked,
    notLinked: c.notLinked,
    heldBack: c.counts['held-back'],
    queued: c.counts.queued,
    failed: c.counts.failed + c.counts['at-capacity'],
    excluded: c.excluded.derived,
  };
}

/** What an export of `scope` sends, and which of those arrive archived. */
export interface ExportCandidates {
  taskIds: string[];
  archiveOnArrival: string[];
}

/**
 * The unlinked tasks an export scope sends. None is derived, and none whose
 * issue moved out of the linked teams (it would be created twice). 'open'
 * leaves out finished tasks; only 'all-archive-finished' takes archived ones,
 * and there finished and archived tasks arrive archived.
 */
export function exportCandidates(
  items: readonly TaskListItem[],
  scope: LinearExportScope,
  model: StatusModel,
  state: Pick<LinearSyncState, 'movedOut'>
): ExportCandidates {
  const out: ExportCandidates = { taskIds: [], archiveOnArrival: [] };
  const movedOut = new Set(Object.values(state.movedOut));
  for (const { meta } of items) {
    if (meta.derivedFrom !== undefined) continue;
    if (parseLinearExternal(meta.external) !== null) continue;
    if (movedOut.has(meta.id)) continue;
    const archived = meta.archivedAt !== undefined;
    const finished = isDoneStatus(meta.status, model);
    if (archived && scope !== 'all-archive-finished') continue;
    if (finished && scope === 'open') continue;
    out.taskIds.push(meta.id);
    if (scope === 'all-archive-finished' && (finished || archived)) {
      out.archiveOnArrival.push(meta.id);
    }
  }
  return out;
}

/** Each export scope's size, from one walk over the board. */
export function exportPreview(
  items: readonly TaskListItem[],
  model: StatusModel,
  state: Pick<LinearSyncState, 'movedOut'>
): LinearExportPreview {
  const movedOut = new Set(Object.values(state.movedOut));
  const out: LinearExportPreview = {
    open: 0,
    all: 0,
    allArchiveFinished: 0,
    finished: 0,
    archived: 0,
    derived: 0,
    containers: 0,
  };
  for (const { meta } of items) {
    if (parseLinearExternal(meta.external) !== null) continue;
    if (meta.derivedFrom !== undefined) {
      out.derived++;
      continue;
    }
    if (movedOut.has(meta.id)) continue;
    out.allArchiveFinished++;
    if (meta.archivedAt !== undefined) {
      out.archived++;
      continue;
    }
    out.all++;
    if (meta.kind !== 'task') out.containers++;
    if (isDoneStatus(meta.status, model)) out.finished++;
    else out.open++;
  }
  return out;
}
