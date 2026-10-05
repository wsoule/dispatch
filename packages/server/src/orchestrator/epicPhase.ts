import {
  canonicalStatus,
  DEFAULT_STATUS_MODEL,
  hasStatusRole,
  isCompletedStatus,
  isDoneStatus,
  isUnstartedStatus,
} from '@dispatch-foo/core';
import type { StatusModel, TaskListItem } from '@dispatch-foo/core';

import type { FixLoopState } from './fixLoop.js';
import type { RunMeta } from './types.js';
import { runKind, TERMINAL_RUN_STATES } from './types.js';

// The pure half of the epic engine: the per-child phase, wave and spend
// derivations `EpicEngine.progress()` and its fill gate compute from data
// that lives elsewhere (task status, the run registry, fix loops, findings).
// Nothing here is stored — every value is recomputed on read so a restart
// reproduces it exactly. `epic.ts` re-exports the types so the API keeps one
// import.

/** Where a child stands inside its epic's fan-out, first match wins in
 *  `deriveChildPhase`'s order. Server-derived so the CLI and desktop agree. */
type EpicChildPhase =
  | 'draft'
  | 'waiting'
  | 'queued'
  | 'held'
  | 'working'
  | 'reviewing'
  | 'fixing'
  | 'needs-review'
  | 'capped'
  | 'failed'
  | 'blocked'
  | 'landing'
  | 'landed'
  | 'dropped';

/** What one session has spent and started, against its ceilings. */
export interface EpicSpend {
  /** Σ `RunMeta.costUsd` over the session's runs (stamped at finish). */
  settledUsd: number;
  /** Non-terminal session runs, any kind. */
  liveCount: number;
  /** `liveCount × orchestrator.runCostEstimateUsd`. */
  estimatedLiveUsd: number;
  /** Session runs of every kind — what `maxRuns` bounds. */
  runsStarted: number;
  maxSpendUsd: number | null;
  maxRuns: number | null;
}

export interface EpicProgressChild {
  id: string;
  title: string;
  status: string;
  phase: EpicChildPhase;
  wave: number;
  reason?: string;
  /** The live run, else the latest one. */
  runId?: string;
  /** The latest run's cost. */
  costUsd?: number;
  openFindings: number;
}

export interface EpicWave {
  index: number;
  total: number;
  byPhase: Partial<Record<EpicChildPhase, number>>;
}

export interface ChildPhaseInput {
  task: TaskListItem;
  liveRun: RunMeta | null;
  latestRun: RunMeta | null;
  fixLoop: FixLoopState | null;
  /** `Orchestrator.blockedFindingReason(taskId)`. */
  blockedReason: string | null;
  /** Blocker ids whose status is not yet dispatch-satisfying. */
  unsatisfiedBlockers: string[];
  /** Whether core's `dispatchableTasks` over the full set includes the task. */
  dispatchable: boolean;
  /** The teammate the task belongs to (core's `fanoutHolder`): the fan-out
   *  never starts it. Null or omitted when it may. */
  heldBy?: string | null;
  /** The project's status model; the built-in one when omitted. */
  statuses?: StatusModel;
}

export interface ChildPhase {
  phase: EpicChildPhase;
  reason?: string;
  runId?: string;
}

/** The label `FixLoop.blockTask` adds — core has no `blocked` status. */
const BLOCKED_LABEL = 'blocked';

function withRun(
  input: ChildPhaseInput,
  phase: EpicChildPhase,
  reason?: string
): ChildPhase {
  const runId = input.liveRun?.id ?? input.latestRun?.id;
  return {
    phase,
    ...(reason !== undefined ? { reason } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}

/**
 * One child's phase from the seams the engine already has — the spec's §3.3
 * table, evaluated top to bottom. Terminal statuses win over everything, a
 * ruling over a loop, a loop over a bare run, and a run over the static
 * readiness reading, so a child reads as what is happening to it now rather
 * than what its status field says.
 */
export function deriveChildPhase(input: ChildPhaseInput): ChildPhase {
  const { task, liveRun, latestRun, fixLoop } = input;
  const model = input.statuses ?? DEFAULT_STATUS_MODEL;
  const status = canonicalStatus(task.meta.status);
  const inReview = hasStatusRole(status, 'review', model);
  const inLanding = hasStatusRole(status, 'landing', model);
  if (isDoneStatus(status, model)) {
    return withRun(
      input,
      isCompletedStatus(status, model) ? 'landed' : 'dropped'
    );
  }
  if (inLanding) return withRun(input, 'landing');
  if (
    input.blockedReason !== null ||
    task.meta.labels.includes(BLOCKED_LABEL)
  ) {
    return withRun(input, 'blocked', input.blockedReason ?? undefined);
  }
  if (fixLoop?.state === 'implementing') return withRun(input, 'fixing');
  const liveKind = liveRun === null ? null : runKind(liveRun);
  if (
    fixLoop?.state === 'reviewing' ||
    liveKind === 'review' ||
    liveKind === 'verify'
  ) {
    return withRun(input, 'reviewing');
  }
  if (liveKind === 'execute') return withRun(input, 'working');
  if (fixLoop?.state === 'capped') {
    const reason =
      fixLoop.stopReason === 'rounds-exhausted'
        ? 'needs a ruling'
        : (fixLoop.stopDetail ?? fixLoop.stopReason);
    return withRun(input, 'capped', reason);
  }
  if (
    latestRun !== null &&
    (latestRun.state === 'failed' || latestRun.state === 'interrupted-dirty') &&
    !inReview &&
    !inLanding
  ) {
    return withRun(input, 'failed', latestRun.error);
  }
  if (inReview) return withRun(input, 'needs-review');
  if (isUnstartedStatus(status, model)) {
    if (task.meta.risk === 'critical') return withRun(input, 'held');
    const heldBy = input.heldBy ?? null;
    if (heldBy !== null) return withRun(input, 'held', `assigned to ${heldBy}`);
    if (input.unsatisfiedBlockers.length > 0) {
      return withRun(
        input,
        'waiting',
        `waiting on ${input.unsatisfiedBlockers.join(', ')}`
      );
    }
    if (input.dispatchable) return withRun(input, 'queued');
  }
  return withRun(input, 'draft');
}

/**
 * Each child's wave: 1 + the deepest wave among its blockers that are also
 * children of the same epic, 1 when it has none. Blockers outside the set do
 * not count. Cycle-safe — a blocker already on the current path is skipped,
 * so a hand-edited cycle yields the longest acyclic depth instead of hanging.
 */
export function deriveWaves(
  children: readonly TaskListItem[]
): Map<string, number> {
  const byId = new Map(children.map((c) => [c.meta.id, c]));
  const waves = new Map<string, number>();
  const visiting = new Set<string>();
  const waveOf = (id: string): number => {
    const known = waves.get(id);
    if (known !== undefined) return known;
    const task = byId.get(id);
    if (task === undefined) return 0;
    visiting.add(id);
    let deepest = 0;
    for (const blocker of task.meta.blockedBy) {
      if (!byId.has(blocker) || visiting.has(blocker)) continue;
      deepest = Math.max(deepest, waveOf(blocker));
    }
    visiting.delete(id);
    const wave = deepest + 1;
    waves.set(id, wave);
    return wave;
  };
  for (const child of children) waveOf(child.meta.id);
  return waves;
}

/**
 * The spend block over `runs` created at or after `startedAt` (`null` means
 * every run given). Settled cost is whatever the registry has stamped; a run
 * still live is charged `estimate` instead, so the gate bounds overshoot by
 * estimate error rather than by concurrency.
 */
export function deriveSpend(
  runs: RunMeta[],
  startedAt: string | null,
  estimate: number,
  ceilings: { maxSpendUsd: number | null; maxRuns: number | null }
): EpicSpend {
  const sessionRuns =
    startedAt === null ? runs : runs.filter((r) => r.createdAt >= startedAt);
  let settledUsd = 0;
  let liveCount = 0;
  for (const run of sessionRuns) {
    settledUsd += run.costUsd ?? 0;
    if (!TERMINAL_RUN_STATES.has(run.state)) liveCount++;
  }
  return {
    settledUsd,
    liveCount,
    estimatedLiveUsd: liveCount * estimate,
    runsStarted: sessionRuns.length,
    maxSpendUsd: ceilings.maxSpendUsd,
    maxRuns: ceilings.maxRuns,
  };
}

/** Groups children by wave and counts each phase, ascending by wave index. */
export function summarizeWaves(children: EpicProgressChild[]): EpicWave[] {
  const byWave = new Map<number, EpicWave>();
  for (const child of children) {
    let wave = byWave.get(child.wave);
    if (wave === undefined) {
      wave = { index: child.wave, total: 0, byPhase: {} };
      byWave.set(child.wave, wave);
    }
    wave.total++;
    wave.byPhase[child.phase] = (wave.byPhase[child.phase] ?? 0) + 1;
  }
  return [...byWave.values()].sort((a, b) => a.index - b.index);
}
