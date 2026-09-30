import type { EpicProgress, RunMeta } from '@dispatch/client';

import type { LiveCeilings } from '../components/shell/FrameStatusStrip';

// What the fleet has spent, for the status strip and the Live view's header: settled run
// cost today, and the live fan-outs' spend against their ceilings.

/**
 * Everything spent today across these runs, summed from `RunMeta.costUsd` (stamped once a
 * run finishes, so settled spend, not an estimate). Null when nothing cost anything yet.
 */
export function spendToday(
  runs: readonly RunMeta[],
  now: number = Date.now()
): number | null {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  let total = 0;
  for (const run of runs) {
    if (run.costUsd === undefined) continue;
    if (Date.parse(run.updatedAt) >= since) total += run.costUsd;
  }
  return total > 0 ? total : null;
}

/**
 * The live fan-outs summed: how many there are, their settled spend, and their spend
 * ceilings added up (null when none set one). Null with no live fan-out.
 */
export function liveCeilingsOf(
  sessions: readonly EpicProgress[]
): LiveCeilings | null {
  if (sessions.length === 0) return null;
  let settledUsd = 0;
  let ceilingUsd: number | null = null;
  for (const progress of sessions) {
    settledUsd += progress.spend.settledUsd;
    const ceiling = progress.session?.maxSpendUsd ?? null;
    if (ceiling !== null) ceilingUsd = (ceilingUsd ?? 0) + ceiling;
  }
  return { live: sessions.length, settledUsd, ceilingUsd };
}
