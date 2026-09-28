import type { RunMeta } from '@dispatch/client';
import { claimConflictsWithWrites } from '@dispatch/core/browser';
import type { TaskListItem } from '@dispatch/core/browser';

import { formatUsd } from './epicSession';
import { isTerminalRunState } from './runState';

/**
 * What a bulk dispatch is actually about to do.
 *
 * The mockup framed this as "5 of 8 slots are busy, so 3 start now" — a fixed global cap. There
 * isn't one: dispatch concurrency is chosen per call (see `handleWorkEpic(epicId, { concurrency, … })`
 * and the stepper in EpicLaneHeader), not configured once for the project. So the honest preview
 * is computed against the concurrency the user is about to pick, not an imaginary ceiling.
 *
 * The rule the dialog exists to enforce: nothing is ever silently dropped. Every selected task
 * appears in the preview, either starting now or explicitly queued.
 */

type DispatchDisposition = 'starts-now' | 'queued' | 'not-ready';

interface DispatchPreviewRow {
  taskId: string;
  title: string;
  disposition: DispatchDisposition;
}

export interface DispatchPreview {
  rows: DispatchPreviewRow[];
  startsNow: number;
  queued: number;
  /** Selected tasks that cannot be dispatched at all — blocked, or already running. */
  notReady: number;
  /** How many agents are already working, which is what eats into the concurrency budget. */
  runningNow: number;
  /** One sentence stating the arithmetic, so the dialog never makes the user do it. */
  summary: string;
  /** Just the estimate and ceiling clauses of `summary` — what a paused session's raise
   * dialog prints, where "N start now" no longer applies. */
  costSummary: string;
  /** The dollar range the runs about to start (now or queued) will settle at. */
  estimateUsd: { low: number; high: number };
  /** Tasks about to run (now or queued) that declare no `writes` — the fan-out serialises
   * those, one at a time, because an undeclared write conflicts with every live claim. */
  undeclaredWrites: number;
  /** Whether even the low estimate clears the spend ceiling, so the session would pause
   * before every task has run. */
  overCeiling: boolean;
  /** Tasks about to run whose declared writes overlap a run already live on another
   * task — on a shared daemon, usually a teammate's. Surfaced as a warning, never a
   * refusal: the person dispatching decides, and nobody's live run is ever touched. */
  overlaps: DispatchOverlap[];
}

/** One task about to run into someone else's live claim. */
interface DispatchOverlap {
  taskId: string;
  taskTitle: string;
  runId: string;
  /** ActorRef of whoever dispatched the live run, when anyone did. */
  holder?: string;
}

/** The slice of a live run the overlap check reads. */
export interface LiveClaim {
  runId: string;
  taskId: string;
  claims: string[];
  dispatchedBy?: string;
}

/** The live claims in a run list: every run not yet terminal, with the files it has
 * claimed and who dispatched it. The three dispatch surfaces all hand the dialog this
 * from the same `data.runs`, so it lives here rather than in each of them. A missing list
 * reads as no live runs — the views' test fixtures build partial project data, and no
 * overlap check is better than a dialog that cannot open. */
export function liveClaimsFrom(
  runs: readonly RunMeta[] | undefined
): LiveClaim[] {
  return (runs ?? [])
    .filter((run) => !isTerminalRunState(run.state))
    .map((run) => ({
      runId: run.id,
      taskId: run.taskId,
      claims: run.claims ?? [],
      ...(run.dispatchedBy === undefined
        ? {}
        : { dispatchedBy: run.dispatchedBy }),
    }));
}

export interface BuildDispatchPreviewInput {
  /** The tasks the user selected, in the order they should start. */
  tasks: TaskListItem[];
  /** Ids that are dependency-clear and have no live run. */
  readyIds: ReadonlySet<string>;
  /** How many agents are already running for this project. */
  runningNow: number;
  /** The concurrency the user is about to dispatch with. */
  concurrency: number;
  /** The per-run midpoint the estimate range is built around (`$10` → `$5–15`). */
  runCostEstimateUsd?: number;
  /** The spend ceiling the dispatch will carry; `null` or absent means none. */
  ceilingUsd?: number | null;
  /** Runs live right now and the files each has claimed. Absent means no overlap
   * check — the raise dialog, for one, has no tasks to check. */
  liveClaims?: LiveClaim[];
}

// The estimate is a range around the midpoint — half to one-and-a-half — since a run's
// cost swings with how much the agent has to read before it can write.
const ESTIMATE_LOW_FACTOR = 0.5;
const ESTIMATE_HIGH_FACTOR = 1.5;
/** The per-run midpoint the estimate and the default spend ceiling are built around. */
export const DEFAULT_RUN_COST_USD = 10;

// `$5–15`: one dollar sign for the range, as a price tag would print it.
function usdRange(low: number, high: number): string {
  return `${formatUsd(low)}–${formatUsd(high).slice(1)}`;
}

// `~$60–$180 at $5–15 per run · ceiling $120`: the clauses that price the plan.
function costClauses(
  estimate: { low: number; high: number },
  perRun: { low: number; high: number },
  ceilingUsd: number | null
): string[] {
  const parts = [
    `~${formatUsd(estimate.low)}–${formatUsd(estimate.high)} at ${usdRange(perRun.low, perRun.high)} per run`,
  ];
  if (ceilingUsd !== null) parts.push(`ceiling ${formatUsd(ceilingUsd)}`);
  return parts;
}

function sentence(
  startsNow: number,
  queued: number,
  notReady: number,
  runningNow: number,
  concurrency: number,
  cost: string[]
): string {
  if (startsNow === 0 && queued === 0) {
    return notReady > 0
      ? 'Nothing can start. Everything is blocked or already running.'
      : 'Nothing selected.';
  }
  const parts = [
    `${runningNow} already running, ${concurrency} at a time`,
    `${startsNow} start${startsNow === 1 ? 's' : ''} now`,
  ];
  if (queued > 0) parts.push(`${queued} queue${queued === 1 ? 's' : ''}`);
  if (notReady > 0) {
    parts.push(`${notReady} cannot start yet`);
  }
  return [...parts, ...cost].join(' · ');
}

export function buildDispatchPreview(
  input: BuildDispatchPreviewInput
): DispatchPreview {
  const {
    tasks,
    readyIds,
    runningNow,
    concurrency,
    runCostEstimateUsd = DEFAULT_RUN_COST_USD,
    ceilingUsd = null,
    liveClaims = [],
  } = input;
  // A concurrency of 0 or less would silently start nothing; treat it as at least one so the
  // preview and the dispatch agree about what the button will do.
  const limit = Math.max(1, Math.round(concurrency));
  const free = Math.max(0, limit - runningNow);

  let started = 0;
  const rows: DispatchPreviewRow[] = tasks.map((task) => {
    const id = task.meta.id;
    if (!readyIds.has(id)) {
      return { taskId: id, title: task.meta.title, disposition: 'not-ready' };
    }
    if (started < free) {
      started += 1;
      return { taskId: id, title: task.meta.title, disposition: 'starts-now' };
    }
    return { taskId: id, title: task.meta.title, disposition: 'queued' };
  });

  const startsNow = rows.filter((r) => r.disposition === 'starts-now').length;
  const queued = rows.filter((r) => r.disposition === 'queued').length;
  const notReady = rows.filter((r) => r.disposition === 'not-ready').length;

  const perRun = {
    low: runCostEstimateUsd * ESTIMATE_LOW_FACTOR,
    high: runCostEstimateUsd * ESTIMATE_HIGH_FACTOR,
  };
  const runs = startsNow + queued;
  const estimateUsd = { low: runs * perRun.low, high: runs * perRun.high };
  // Only the tasks that will run get serialised, so a blocked or landed task with no
  // writes is not counted against the fan-out.
  const undeclaredWrites = tasks.filter(
    (task, i) =>
      rows[i]?.disposition !== 'not-ready' && task.meta.writes.length === 0
  ).length;
  // Same predicate the epic scheduler uses to keep its own runs apart
  // (claimConflictsWithWrites in core), so the dialog and the scheduler agree
  // on what an overlap is. A run on the task itself is not an overlap — that
  // is a redispatch, and the orchestrator resumes it rather than colliding.
  const overlaps: DispatchOverlap[] = [];
  tasks.forEach((task, i) => {
    if (rows[i]?.disposition === 'not-ready') return;
    for (const live of liveClaims) {
      if (live.taskId === task.meta.id) continue;
      if (!claimConflictsWithWrites(live.claims, task.meta.writes)) continue;
      overlaps.push({
        taskId: task.meta.id,
        taskTitle: task.meta.title,
        runId: live.runId,
        ...(live.dispatchedBy === undefined
          ? {}
          : { holder: live.dispatchedBy }),
      });
    }
  });
  const cost = costClauses(estimateUsd, perRun, ceilingUsd);

  return {
    rows,
    startsNow,
    queued,
    notReady,
    runningNow,
    summary: sentence(startsNow, queued, notReady, runningNow, limit, cost),
    costSummary: cost.join(' · '),
    estimateUsd,
    undeclaredWrites,
    overCeiling: ceilingUsd !== null && estimateUsd.low > ceilingUsd,
    overlaps,
  };
}
