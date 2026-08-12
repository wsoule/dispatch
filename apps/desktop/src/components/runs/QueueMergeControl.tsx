import type {
  MergeQueueEntryState,
  MergeQueueSnapshot,
  RunMeta,
} from '@dispatch/client';
import { ListOrdered } from 'lucide-react';

import { Button } from '@/ui/button';

// Live-state label for a run currently sitting in the merge queue — 'queued' gets its own
// position-aware label built inline (see `QueueMergeControl` below), every other non-terminal
// state maps to a short present-progressive label straight off the snapshot.
const QUEUE_STATE_LABEL: Partial<Record<MergeQueueEntryState, string>> = {
  'waiting-blockers': 'Waiting on blockers…',
  // Not present-progressive like the others because nothing is progressing:
  // the queue is waiting on the person, and the entry's `reason` names the
  // file or branch to deal with.
  'blocked-environment': 'Blocked on your checkout',
  // Same non-progressive framing as 'blocked-environment': the queue is
  // waiting on GitHub (a draft, a conflict, failing/pending checks, an
  // outstanding review verdict), not on anything actively running here.
  'waiting-github': 'Waiting on GitHub',
  rebasing: 'Rebasing…',
  verifying: 'Verifying…',
  merging: 'Merging…',
};

/**
 * The "Queue merge" control: a plain button when this run has no merge-queue entry, live state
 * text (e.g. "Queued · #2", "Rebasing…") while an entry is actively in the queue, and — once a
 * past attempt has failed without the run ever becoming reviewed — the failure reason plus a
 * re-enabled button so the person can retry. Disabled (with a reason tooltip) once the run has
 * already been reviewed, mirroring the server's own 409 for that case.
 *
 * Shared by every surface that can enqueue a run's merge — today the run detail's
 * action row (RunReviewView, both the plain-diff and PR-open branches) — so one
 * place owns the run -> queue-state mapping and every surface agrees.
 */
export function QueueMergeControl({
  meta,
  mergeQueue,
  busy,
  onQueueMerge,
}: {
  meta: RunMeta;
  mergeQueue: MergeQueueSnapshot | null;
  busy: boolean;
  onQueueMerge: () => void;
}) {
  const entries = mergeQueue?.entries ?? [];
  const activeEntry = entries.find((e) => e.runId === meta.id);
  const queuePosition =
    activeEntry !== undefined ? entries.indexOf(activeEntry) + 1 : undefined;
  // A failed attempt moves out of `entries` into `history` — surfaced only when there's no
  // active entry for this run, since a fresh enqueue after a failure starts a new entry. History
  // is most-recent-first, so the run's own most recent entry (not just any past failed one) is
  // what determines whether "Failed: ..." still applies — otherwise a run that failed once and
  // later merged successfully would show a stale failure label forever.
  const latestEntry =
    activeEntry === undefined
      ? mergeQueue?.history.find((e) => e.runId === meta.id)
      : undefined;
  const failedEntry = latestEntry?.state === 'failed' ? latestEntry : undefined;
  // Live reason, not history — refreshes on every pump while still blocked.
  const blockedReason =
    activeEntry?.state === 'blocked-environment'
      ? activeEntry.reason
      : undefined;
  const alreadyReviewed = meta.reviewedAt !== undefined;
  const disabledReason = alreadyReviewed
    ? 'This run has already been reviewed'
    : undefined;

  return (
    <div className="flex items-center gap-2">
      {activeEntry !== undefined ? (
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[12px]">
          <ListOrdered className="size-3.5" />
          {activeEntry.state === 'queued'
            ? `Queued · #${queuePosition}`
            : (QUEUE_STATE_LABEL[activeEntry.state] ?? activeEntry.state)}
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || alreadyReviewed}
          title={disabledReason}
          onClick={onQueueMerge}
        >
          <ListOrdered className="size-3.5" />
          Queue merge
        </Button>
      )}
      {blockedReason !== undefined && (
        <span
          className="text-muted-foreground max-w-40 truncate text-[11px]"
          title={blockedReason}
        >
          {blockedReason}
        </span>
      )}
      {failedEntry !== undefined && (
        <span
          className="text-destructive max-w-40 truncate text-[11px]"
          title={failedEntry.reason}
        >
          Failed: {failedEntry.reason ?? 'unknown error'}
        </span>
      )}
    </div>
  );
}
