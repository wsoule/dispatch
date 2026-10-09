import type { RunMeta } from '@dispatch/client';

import { landingRun } from './containerRollup';
import { mergeLadderState } from './mergeLadder';
import { isTerminalRunState } from './runState';

/**
 * Where a task's work ended up, in one word the outcome card can render:
 * - `landed`: the work is where it was going. `where` says how sure that is:
 *   on origin, in a local-only base, or `outside` when the task is complete
 *   but no merge was recorded by Dispatch (merged by hand, or done without
 *   an agent run).
 * - `merged-local`: merged into the local base but never pushed to origin.
 * - `pr-open`: a PR carries the work and has not merged yet.
 * - `land-failed`: the last merge attempt threw; `reason` says why.
 * - `run-failed`: the newest run failed and nothing landed.
 * - `ready`: the newest run finished and waits for a verdict.
 * - `dropped`: the task was canceled.
 * `null` while work is still unstarted or in flight: there is no outcome yet.
 */
export type TaskOutcome =
  | { kind: 'landed'; where: 'origin' | 'local' | 'outside'; run?: RunMeta }
  | { kind: 'merged-local'; run: RunMeta }
  | { kind: 'pr-open'; run: RunMeta }
  | { kind: 'land-failed'; run: RunMeta; reason: string }
  | { kind: 'run-failed'; run: RunMeta; reason: string | null }
  | { kind: 'ready'; run: RunMeta }
  | { kind: 'dropped' };

/** The newest run by creation time, whatever order the list arrived in. */
function newest(runs: readonly RunMeta[]): RunMeta | undefined {
  let best: RunMeta | undefined;
  for (const r of runs) {
    if (
      best === undefined ||
      Date.parse(r.createdAt) > Date.parse(best.createdAt)
    )
      best = r;
  }
  return best;
}

export function taskOutcome(input: {
  completed: boolean;
  canceled: boolean;
  runs: readonly RunMeta[];
}): TaskOutcome | null {
  const { completed, canceled, runs } = input;
  if (canceled) return { kind: 'dropped' };

  const landing = landingRun(runs);
  const ladder = mergeLadderState(landing);
  if (landing !== undefined) {
    if (ladder === 'on-origin')
      return { kind: 'landed', where: 'origin', run: landing };
    if (ladder === 'local-only')
      return { kind: 'landed', where: 'local', run: landing };
    if (ladder === 'merged-local')
      return { kind: 'merged-local', run: landing };
    if (landing.prUrl !== undefined && landing.reviewedAt === undefined)
      return { kind: 'pr-open', run: landing };
  }
  if (completed)
    return { kind: 'landed', where: 'outside', run: landing ?? newest(runs) };

  const latest = newest(runs);
  if (latest === undefined || !isTerminalRunState(latest.state)) return null;
  if (latest.reviewedAt !== undefined) return null;
  if (latest.reviewFailure?.action === 'merge')
    return {
      kind: 'land-failed',
      run: latest,
      reason: latest.reviewFailure.reason,
    };
  if (latest.state === 'failed' || latest.state === 'interrupted-dirty')
    return { kind: 'run-failed', run: latest, reason: latest.error ?? null };
  if (latest.state === 'cancelled') return null;
  return { kind: 'ready', run: latest };
}
