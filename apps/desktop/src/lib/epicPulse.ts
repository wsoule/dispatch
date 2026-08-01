import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';

import type { FeedState } from './feedState';
import { deriveFeedState } from './feedState';

/**
 * The one-line "what is happening in this epic right now", shown beside its progress bar.
 *
 * The ordering is the whole point and is deliberately not a count of everything: it reports the
 * single most actionable fact. Something needing a human beats something running, which beats
 * something merely startable. A header that read "3 need you · 2 running · 4 ready" makes the
 * reader do the triage; this does it for them.
 */

export interface EpicPulse {
  /** The tone the label should take, or null when there is nothing going on. */
  state: FeedState | null;
  label: string;
}

export function deriveEpicPulse(
  tasks: TaskDoc[],
  latestRunByTaskId: ReadonlyMap<string, RunMeta>,
  readyIds: ReadonlySet<string>
): EpicPulse {
  let needsYou = 0;
  let running = 0;
  let review = 0;

  for (const task of tasks) {
    const run = latestRunByTaskId.get(task.meta.id);
    if (run === undefined) continue;
    const state = deriveFeedState(run);
    // Waiting and failed both mean "a human is the blocker", which is the same ask from the
    // reader's point of view even though the fix differs — so they share one counter.
    if (state === 'waiting' || state === 'failed') needsYou += 1;
    else if (state === 'working' || state === 'landing') running += 1;
    else if (state === 'review') review += 1;
  }

  const ready = tasks.filter((t) => readyIds.has(t.meta.id)).length;

  if (needsYou > 0) {
    return { state: 'waiting', label: `${needsYou} need you` };
  }
  if (running > 0) {
    return { state: 'working', label: `${running} running` };
  }
  if (review > 0) {
    return { state: 'review', label: `${review} to review` };
  }
  if (ready > 0) {
    return { state: 'ready', label: `${ready} ready` };
  }
  return { state: null, label: 'nothing running' };
}
