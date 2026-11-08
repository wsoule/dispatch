import type { RunMeta, RunState } from '@dispatch/client';

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
