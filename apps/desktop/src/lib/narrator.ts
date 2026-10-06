import type { MergeQueueEntry, RunMeta } from '@dispatch/client';

import type { OverseerDoor } from './overseerThread';

/** One line the narrator says: deterministic, free, and never stored in the transcript. */
export interface NarratorLine {
  key: string;
  tone: 'failed' | 'review' | 'landed';
  text: string;
  door: OverseerDoor;
}

export interface NarratorInput {
  /** When the human last dismissed the digest. */
  since: string;
  runs: readonly RunMeta[];
  /** Landed and failed merges, newest last (the merge queue's history). */
  merges: readonly MergeQueueEntry[];
}

// How many titles a line names before it counts the rest.
const NAMED = 3;

function named(titles: string[]): string {
  const shown = titles.slice(0, NAMED);
  const more = titles.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

// A run is new to the human when it settled after they last looked.
function settledSince(run: RunMeta, since: string): boolean {
  return run.updatedAt > since && (run.kind ?? 'execute') === 'execute';
}

/**
 * "While you were away": what settled since `since`, most urgent first.
 * Asks are not repeated here: the stream's own door already counts them.
 */
export function awayDigest(input: NarratorInput): NarratorLine[] {
  const lines: NarratorLine[] = [];
  const recent = input.runs.filter((run) => settledSince(run, input.since));
  const failed = recent.filter(
    (run) => run.state === 'failed' || run.state === 'interrupted-dirty'
  );
  if (failed.length > 0) {
    const only = failed.length === 1 ? failed[0] : null;
    lines.push({
      key: 'failed',
      tone: 'failed',
      text:
        only !== null
          ? `✕ ${only.id} failed · ${only.taskTitle}`
          : `✕ ${failed.length} runs failed: ${named(failed.map((r) => r.taskTitle))}`,
      door: only !== null ? { taskId: only.taskId } : { preset: 'failed' },
    });
  }
  const review = recent.filter(
    (run) => run.state === 'finished' && run.reviewedAt === undefined
  );
  if (review.length > 0) {
    lines.push({
      key: 'review',
      tone: 'review',
      text: `◇ ${review.length} ready for review: ${named(review.map((r) => r.taskTitle))}`,
      door:
        review.length === 1
          ? { taskId: review[0].taskId }
          : { preset: 'review' },
    });
  }
  const landed = input.merges.filter(
    (entry) =>
      entry.state === 'merged' &&
      (entry.finishedAt ?? entry.enqueuedAt) > input.since
  );
  if (landed.length > 0) {
    lines.push({
      key: 'landed',
      tone: 'landed',
      text: `✓ ${landed.length} landed: ${named(landed.map((e) => e.taskTitle))}`,
      door: { preset: 'landed' },
    });
  }
  return lines;
}
