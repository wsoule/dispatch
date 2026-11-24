import type { RunMeta, RunState } from '@dispatch/client';

import type { Tone } from './theme';

const LIVE: ReadonlySet<RunState> = new Set([
  'provisioning',
  'running',
  'awaiting-approval',
]);

export const isLive = (run: RunMeta): boolean => LIVE.has(run.state);

/** Finished and not yet merged, discarded or sent as a PR: the review queue,
 *  by the same rule the desktop app uses for a finished run. */
export const awaitsReview = (run: RunMeta): boolean =>
  run.state === 'finished' && run.reviewedAt === undefined;

export function stateText(run: RunMeta): string {
  switch (run.state) {
    case 'provisioning':
      return 'Starting';
    case 'running':
      return run.lastStep?.text ?? 'Working';
    case 'awaiting-approval':
      return 'Waiting for you';
    case 'finished':
      return run.reviewedAt === undefined
        ? 'Ready to review'
        : run.reviewAction === 'discard'
          ? 'Discarded'
          : run.reviewAction === 'pr'
            ? 'Sent as a PR'
            : 'Merged';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted-dirty':
      return 'Interrupted';
  }
}

/** Live runs first, then the newest. */
export function byRecency(a: RunMeta, b: RunMeta): number {
  const live = Number(isLive(b)) - Number(isLive(a));
  return live !== 0 ? live : b.updatedAt.localeCompare(a.updatedAt);
}

export interface RunStatus {
  label: string;
  tone: Tone;
}

/** A run's state as a one-word chip, in the desktop's status colours: amber
 *  waits on you, blue is live, green is ready to review, red failed, gray
 *  is over. */
export function runStatus(run: RunMeta): RunStatus {
  switch (run.state) {
    case 'provisioning':
      return { label: 'Starting', tone: 'blue' };
    case 'running':
      return { label: 'Live', tone: 'blue' };
    case 'awaiting-approval':
      return { label: 'Needs you', tone: 'amber' };
    case 'finished':
      if (run.reviewedAt === undefined)
        return { label: 'Review', tone: 'green' };
      return {
        label:
          run.reviewAction === 'discard'
            ? 'Discarded'
            : run.reviewAction === 'pr'
              ? 'PR'
              : 'Merged',
        tone: 'gray',
      };
    case 'failed':
      return { label: 'Failed', tone: 'red' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'gray' };
    case 'interrupted-dirty':
      return { label: 'Interrupted', tone: 'amber' };
  }
}
