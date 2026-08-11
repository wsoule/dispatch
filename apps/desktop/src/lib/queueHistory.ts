import type { MergeQueueEntry } from '@dispatch/client';

/**
 * The Landing view's read model over merge-queue HISTORY — the terminal entries, as opposed
 * to `mergeQueueView.ts`, which models the live queue.
 *
 * History is one flat list of merged and failed entries, newest first. Rendered as-is it lies:
 * a section titled "Recently landed" full of red FAILED rows says the opposite of what
 * happened. These helpers split the list into the three stories it actually contains.
 */

/** What only the run list knows about a history entry's run: whether a human (or the queue
 * itself, on a later attempt) has since reviewed it. */
export interface HistoryRunFacts {
  id: string;
  reviewedAt?: string;
}

export interface QueueHistoryGroups {
  /** Successful merges only — the entries a "Landed" heading can honestly claim. */
  landed: MergeQueueEntry[];
  /** Failed attempts still worth a headline row: the run's latest attempt, and the run has
   * not been reviewed or merged some other way since. Each is actionable — retry or look. */
  failed: MergeQueueEntry[];
  /** Failed attempts that are history in the pejorative sense: the run was reviewed/merged
   * anyway, or a newer attempt for the same run exists. Shown only behind a disclosure. */
  stale: MergeQueueEntry[];
}

/**
 * Split queue history (newest first, as the server sends it) into landed / failed / stale.
 *
 * A failed attempt is stale when its failure no longer describes the run's present:
 * - the run's `reviewedAt` is set — it was merged, discarded, or PR'd despite the failure, or
 *   a later queue attempt landed it (a queue merge sets `reviewedAt` too);
 * - a newer history entry exists for the same run — that attempt, whatever its outcome, is
 *   the one that describes the run now;
 * - the run is back in the live queue (`queuedRunIds`) — the pending attempt is the story,
 *   and without this rule clicking a failed row's Retry would leave the red headline up as
 *   if the retry never took.
 * A run absent from `runs` stays live: an empty or still-loading run list must not silently
 * reclassify every failure as stale.
 */
export function groupQueueHistory(
  history: readonly MergeQueueEntry[],
  runs: readonly HistoryRunFacts[],
  queuedRunIds: ReadonlySet<string> = new Set()
): QueueHistoryGroups {
  const reviewed = new Set(
    runs.filter((r) => r.reviewedAt !== undefined).map((r) => r.id)
  );

  const landed: MergeQueueEntry[] = [];
  const failed: MergeQueueEntry[] = [];
  const stale: MergeQueueEntry[] = [];
  // runIds already seen while walking newest→oldest — anything after the first
  // sighting is a superseded attempt.
  const seen = new Set<string>();

  for (const entry of history) {
    const superseded = seen.has(entry.runId);
    seen.add(entry.runId);
    if (entry.state === 'merged') {
      landed.push(entry);
    } else if (
      superseded ||
      reviewed.has(entry.runId) ||
      queuedRunIds.has(entry.runId)
    ) {
      stale.push(entry);
    } else {
      failed.push(entry);
    }
  }

  return { landed, failed, stale };
}

/**
 * Runs whose LATEST queue attempt failed — the set the Inbox's needs-review rows check to
 * carry a "verify failed" badge. Latest is what matters: a run that failed once and then
 * merged on retry is fine, and badging it would re-tell the stale story the grouping above
 * exists to bury.
 */
export function latestAttemptFailedRunIds(
  history: readonly MergeQueueEntry[]
): Set<string> {
  const latest = new Map<string, MergeQueueEntry>();
  // Newest first — the first entry seen per run is its latest attempt.
  for (const entry of history) {
    if (!latest.has(entry.runId)) latest.set(entry.runId, entry);
  }
  const out = new Set<string>();
  for (const [runId, entry] of latest) {
    if (entry.state === 'failed') out.add(runId);
  }
  return out;
}
