import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  RunMeta,
  RunState,
} from '@dispatch/client';

/** A notification ready to hand to `notify(title, body)` — see notifications.ts. */
export interface PendingNotification {
  title: string;
  body: string;
}

const RUN_NOTIFY_STATES: ReadonlySet<RunState> = new Set([
  'finished',
  'failed',
]);

/**
 * Pure edge-detector for run state transitions: compares the previous run-id → state
 * snapshot against the latest run list and returns a notification for every run that
 * *just* landed on 'finished' or 'failed', plus the snapshot to keep for next time.
 *
 * A run with no entry in `previous` never notifies, no matter its state — that's what
 * keeps app launch (or a project switch, which starts this hook's tracking over) from
 * firing a wave of notifications for every run that was already terminal before this
 * window started watching. `next` is rebuilt from scratch each call (not merged onto
 * `previous`), so its size always tracks the current run count rather than growing
 * unbounded across a long-lived session.
 */
export function diffRunNotifications(
  previous: ReadonlyMap<string, RunState>,
  runs: readonly RunMeta[]
): { notifications: PendingNotification[]; next: Map<string, RunState> } {
  const next = new Map<string, RunState>();
  const notifications: PendingNotification[] = [];

  for (const run of runs) {
    next.set(run.id, run.state);
    const prevState = previous.get(run.id);
    if (
      prevState !== undefined &&
      prevState !== run.state &&
      RUN_NOTIFY_STATES.has(run.state)
    ) {
      notifications.push({
        title: run.state === 'finished' ? 'Run finished' : 'Run failed',
        body: run.taskTitle,
      });
    }
  }

  return { notifications, next };
}

// 'blocked-environment' notifies alongside the two terminal states because it
// is the one queue state that needs the PERSON to do something (commit, stash,
// switch branch) before anything else can move. The bug this addresses was
// precisely that a blocked merge was silent — the entry used to fail straight
// into history and the queue looked like it had swallowed the run.
const QUEUE_NOTIFY_STATES: ReadonlySet<MergeQueueEntryState> = new Set([
  'merged',
  'failed',
  'blocked-environment',
]);

/**
 * Pure edge-detector for merge-queue entry transitions — same shape and same "first
 * sighting never notifies" rule as `diffRunNotifications` above, but for merge-queue
 * entries instead of runs. Callers must pass the *combined* active-entries + history
 * list (`[...snapshot.entries, ...snapshot.history]`): a terminal entry moves out of
 * `entries` and into `history` in the same update that flips its state, so watching
 * only `entries` would miss every merged/failed transition entirely.
 */
export function diffQueueNotifications(
  previous: ReadonlyMap<string, MergeQueueEntryState>,
  entries: readonly MergeQueueEntry[]
): {
  notifications: PendingNotification[];
  next: Map<string, MergeQueueEntryState>;
} {
  const next = new Map<string, MergeQueueEntryState>();
  const notifications: PendingNotification[] = [];

  for (const entry of entries) {
    // Re-enqueued runs appear in both entries and history; keep the first (current)
    // occurrence and skip duplicates to avoid older history entries overwriting live state.
    if (next.has(entry.runId)) continue;

    next.set(entry.runId, entry.state);
    const prevState = previous.get(entry.runId);
    if (
      prevState !== undefined &&
      prevState !== entry.state &&
      QUEUE_NOTIFY_STATES.has(entry.state)
    ) {
      if (entry.state === 'merged') {
        notifications.push({ title: 'Merged', body: entry.taskTitle });
      } else if (entry.state === 'blocked-environment') {
        notifications.push({
          title: 'Merge blocked — action needed',
          body: `${entry.taskTitle} — ${(entry.reason ?? '').slice(0, 80)}`,
        });
      } else {
        const reason = (entry.reason ?? '').slice(0, 80);
        notifications.push({
          title: 'Merge failed',
          body: `${entry.taskTitle} — ${reason}`,
        });
      }
    }
  }

  return { notifications, next };
}
