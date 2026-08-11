import type { RepoPr, RunMeta } from '@dispatch/client';

import type { ReviewTarget } from '../../lib/reviewTarget';

export interface ReviewQueueItem {
  /** What this row opens — a local run's diff, or a GitHub PR. */
  target: ReviewTarget;
  /** What the row shows: the task title for a run, the PR title otherwise. */
  title: string;
  /** True when this one is waiting on GitHub rather than on a local diff. */
  isPr: boolean;
  /** Sort key, newest first. */
  updatedAt: string;
  /** Present for a run-backed row — turns/cost and the send-back path. */
  run?: RunMeta;
  /** Present for any row with GitHub status to render. */
  pr?: RepoPr;
}

/**
 * Whether a run still owes a human a look. Not just `finished`: a run
 * force-failed by boot reconciliation can have completed all its work on the
 * branch and never reach that state, which left it invisible here. A session id
 * stands in for "the agent actually got going", separating that case from one
 * that never started. Cancels stay out — a human stopped those on purpose.
 */
function needsHumanLook(run: RunMeta): boolean {
  if (run.reviewedAt !== undefined) return false;
  if (run.state === 'finished' || run.state === 'interrupted-dirty') {
    return true;
  }
  return run.state === 'failed' && (run.sessionId ?? '') !== '';
}

/**
 * Runs awaiting review plus every open repo PR, newest first. A
 * dispatch-opened PR arrives via both sources; the run-backed row
 * wins, since only it reaches send-back.
 *
 * Execute runs only: a review or verify agent's own RunMeta is finished
 * and never gets `reviewedAt`, so it would sit here forever under the
 * title of the work it reviewed. Absent `kind` still means execute.
 */
export function buildReviewQueue(
  runs: RunMeta[],
  repoPrs: RepoPr[] = []
): ReviewQueueItem[] {
  const prByUrl = new Map(repoPrs.map((pr) => [pr.url, pr]));
  const items: ReviewQueueItem[] = [];
  const claimedUrls = new Set<string>();

  for (const run of runs) {
    if ((run.kind ?? 'execute') !== 'execute') continue;
    if (run.archivedAt !== undefined) continue;
    const isPr = run.prUrl !== undefined;
    if (!isPr && !needsHumanLook(run)) continue;
    if (run.prUrl !== undefined) claimedUrls.add(run.prUrl);
    items.push({
      target: { kind: 'run', runId: run.id },
      title: run.taskTitle,
      isPr,
      updatedAt: run.updatedAt,
      run,
      ...(run.prUrl !== undefined && prByUrl.has(run.prUrl)
        ? { pr: prByUrl.get(run.prUrl) }
        : {}),
    });
  }

  for (const pr of repoPrs) {
    if (claimedUrls.has(pr.url)) continue;
    items.push({
      target: { kind: 'pr', number: pr.number },
      title: pr.title,
      isPr: true,
      updatedAt: pr.updatedAt,
      pr,
    });
  }

  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
