import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';

import { deriveFeedState, isInFlightState, isUrgentState } from './feedState';

/**
 * Whether a milestone is in trouble, and why.
 *
 * The mockup showed a target date and an on-track/at-risk verdict against it. Milestones here
 * have no date — `TaskMeta.milestone` is a free-form name, deliberately so a project needs no
 * setup to use them — so schedule risk cannot be computed and is not faked.
 *
 * What *is* real is derivable from run state: a milestone whose tasks are sitting frozen on an
 * approval, or whose agents keep failing, is genuinely stalled regardless of any date. That is
 * the only signal used, and the reason always names the specific count, because "at risk" with
 * no reason attached is just anxiety.
 */

type MilestoneHealth = 'stalled' | 'active' | 'idle' | 'complete';

export interface MilestoneStatus {
  health: MilestoneHealth;
  /** A specific sentence when stalled, else null. */
  reason: string | null;
  waiting: number;
  failed: number;
  working: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function deriveMilestoneStatus(
  tasks: TaskDoc[],
  latestRunByTaskId: ReadonlyMap<string, RunMeta>,
  allClosed: boolean
): MilestoneStatus {
  let waiting = 0;
  let failed = 0;
  let working = 0;

  for (const task of tasks) {
    const run = latestRunByTaskId.get(task.meta.id);
    if (run === undefined) continue;
    const state = deriveFeedState(run);
    if (state === null) continue;
    if (state === 'failed') failed += 1;
    else if (state !== 'review' && isUrgentState(state)) waiting += 1;
    else if (isInFlightState(state)) working += 1;
  }

  if (allClosed) {
    return { health: 'complete', reason: null, waiting, failed, working };
  }

  if (waiting > 0 || failed > 0) {
    // Name both causes when both are present — they call for different actions, so collapsing
    // them into one number would hide half the work.
    const causes: string[] = [];
    if (waiting > 0)
      causes.push(
        `${plural(waiting, 'task is', 'tasks are')} frozen waiting on you`
      );
    if (failed > 0) causes.push(`${plural(failed, 'has', 'have')} failed`);
    return {
      health: 'stalled',
      reason: `${causes.join(' and ')}.`,
      waiting,
      failed,
      working,
    };
  }

  return {
    health: working > 0 ? 'active' : 'idle',
    reason: null,
    waiting,
    failed,
    working,
  };
}

export const MILESTONE_HEALTH_LABEL: Record<MilestoneHealth, string> = {
  stalled: 'Stalled',
  active: 'In progress',
  idle: 'Not started',
  complete: 'Complete',
};
