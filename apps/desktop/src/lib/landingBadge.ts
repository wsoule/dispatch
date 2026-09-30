import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  MergeQueueSnapshot,
} from '@dispatch/client';

// Landing is a run fact, not a status: a task is landing while one of its runs sits in the
// merge queue. Rows, cards, Cockpit rows and Flight Plan nodes read it from the cached queue
// snapshot, so a project whose statuses have no landing role still shows it.

/** Each task's entry still in the queue, keyed by task id, in queue order. */
export function landingEntryByTaskId(
  mergeQueue: MergeQueueSnapshot | null
): ReadonlyMap<string, MergeQueueEntry> {
  const out = new Map<string, MergeQueueEntry>();
  for (const entry of mergeQueue?.entries ?? []) {
    if (entry.state === 'merged' || entry.state === 'failed') continue;
    if (!out.has(entry.taskId)) out.set(entry.taskId, entry);
  }
  return out;
}

/** Where a task's queue entry stands, keyed by task id — only entries still in the queue. */
export function landingStateByTaskId(
  mergeQueue: MergeQueueSnapshot | null
): ReadonlyMap<string, MergeQueueEntryState> {
  const out = new Map<string, MergeQueueEntryState>();
  for (const [taskId, entry] of landingEntryByTaskId(mergeQueue)) {
    out.set(taskId, entry.state);
  }
  return out;
}

const STEP: Record<MergeQueueEntryState, string> = {
  queued: 'queued',
  'waiting-blockers': 'waiting on its blockers',
  'blocked-environment': 'held until the checkout is clean',
  'waiting-github': 'waiting on GitHub',
  rebasing: 'rebasing',
  verifying: 'verifying',
  merging: 'merging',
  merged: 'merged',
  failed: 'failed',
};

/** The queue step in words: `verifying`, `waiting on GitHub`. */
export function landingStepLabel(state: MergeQueueEntryState): string {
  return STEP[state];
}

/** The badge's tooltip: `Landing · verifying`. */
export function landingBadgeTitle(state: MergeQueueEntryState): string {
  return `Landing · ${STEP[state]}`;
}
