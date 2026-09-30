import type { RunMeta } from '@dispatch/client';

import type { FlightNodeState } from './flightPlan';

// How long the rest of a plan takes: every unfinished node is weighted by what a run
// usually takes here, the critical path is the heaviest chain of blockers, and the ETA is
// that chain or the whole remaining load spread over the slots, whichever is longer.

/** What a run is assumed to take before the project has finished enough of its own. */
export const DEFAULT_RUN_MS = 20 * 60_000;
/** Finished runs needed before their median replaces the default. */
const MIN_SAMPLES = 3;
/** Only the most recent finished runs speak for the project's current pace. */
const MAX_SAMPLES = 50;
// A sample outside this window is a stall, a restart or a clock oddity, not a run's length.
const MIN_SAMPLE_MS = 10_000;
const MAX_SAMPLE_MS = 6 * 60 * 60_000;
/** A running node always has at least this share of a median left. */
const RUNNING_FLOOR = 0.1;

export interface RunPace {
  /** The median length of a finished run, or `DEFAULT_RUN_MS`. */
  medianMs: number;
  /** Runs the median came from; 0 when it is the default. */
  samples: number;
}

/**
 * The median length of this project's recent finished agent runs. A run's `updatedAt`
 * is its finish time only until someone reviews, archives or opens a PR for it (each
 * stamps it again), so those runs are left out rather than read as hours long.
 */
export function runPace(runs: readonly RunMeta[]): RunPace {
  const durations: { at: string; ms: number }[] = [];
  for (const run of runs) {
    if (run.state !== 'finished') continue;
    if ((run.kind ?? 'execute') !== 'execute') continue;
    if (
      run.reviewedAt !== undefined ||
      run.prUrl !== undefined ||
      run.archivedAt !== undefined
    ) {
      continue;
    }
    const ms = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
    if (!Number.isFinite(ms) || ms < MIN_SAMPLE_MS || ms > MAX_SAMPLE_MS) {
      continue;
    }
    durations.push({ at: run.createdAt, ms });
  }
  if (durations.length < MIN_SAMPLES) {
    return { medianMs: DEFAULT_RUN_MS, samples: 0 };
  }
  const recent = durations
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_SAMPLES)
    .map((d) => d.ms)
    .sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  const median =
    recent.length % 2 === 1
      ? (recent[mid] ?? DEFAULT_RUN_MS)
      : ((recent[mid - 1] ?? 0) + (recent[mid] ?? 0)) / 2;
  return { medianMs: median, samples: recent.length };
}

export interface PathNode {
  id: string;
  wave: number;
  blockedBy: readonly string[];
  state: FlightNodeState;
  /** When its live run started (epoch ms), for a running node. */
  startedAt?: number;
}

/**
 * What is left of one node, in ms: nothing once it landed or reached review (its
 * dependents can already start), the unspent part of a median while an agent is on it,
 * a whole median otherwise.
 */
function remainingMs(node: PathNode, medianMs: number, now: number): number {
  switch (node.state) {
    case 'done':
    case 'review':
      return 0;
    case 'running': {
      const elapsed =
        node.startedAt === undefined ? 0 : Math.max(0, now - node.startedAt);
      return Math.max(medianMs - elapsed, medianMs * RUNNING_FLOOR);
    }
    default:
      return medianMs;
  }
}

export interface CriticalPath {
  /** Unfinished nodes on the heaviest chain, blockers first. */
  ids: string[];
  /** `from>to` keys of the chain's edges. */
  edges: ReadonlySet<string>;
  /** The chain's remaining time. */
  ms: number;
  /** Every unfinished node's remaining time, summed. */
  workMs: number;
}

/** The key `CriticalPath.edges` uses for one edge. */
export function edgeKey(from: string, to: string): string {
  return `${from}>${to}`;
}

/**
 * The longest remaining chain through the plan, weighting each node by `remainingMs`.
 * Only edges from an earlier wave count, so a hand-made cycle can never loop the walk.
 * Ties go to the node listed first, which keeps the answer stable across renders.
 */
export function criticalPath(
  nodes: readonly PathNode[],
  medianMs: number,
  now: number
): CriticalPath {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.wave - b.n.wave || a.i - b.i);
  const best = new Map<string, number>();
  const via = new Map<string, string>();
  let workMs = 0;
  let end: string | null = null;
  let endScore = 0;
  for (const { n } of order) {
    const own = remainingMs(n, medianMs, now);
    workMs += own;
    let bestBlocker: string | null = null;
    let bestScore = 0;
    for (const blocker of n.blockedBy) {
      const b = byId.get(blocker);
      if (b === undefined || blocker === n.id || b.wave >= n.wave) continue;
      const score = best.get(blocker) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestBlocker = blocker;
      }
    }
    // A finished (or in-review) node already released its dependents, so no chain runs
    // through it.
    const total = own === 0 ? 0 : own + bestScore;
    best.set(n.id, total);
    if (own > 0 && bestBlocker !== null) via.set(n.id, bestBlocker);
    if (total > endScore) {
      endScore = total;
      end = n.id;
    }
  }

  const ids: string[] = [];
  for (let id = end; id !== null; id = via.get(id) ?? null) ids.push(id);
  ids.reverse();
  const edges = new Set<string>();
  for (let i = 1; i < ids.length; i++) {
    const from = ids[i - 1];
    const to = ids[i];
    if (from !== undefined && to !== undefined) edges.add(edgeKey(from, to));
  }
  return { ids, edges, ms: endScore, workMs };
}

/**
 * How long until everything lands: the critical path, or the remaining load over the
 * agent slots when that is longer. Null when no session is fanning out — nothing will
 * start on its own, so there is no finish to promise.
 */
export function etaMs(path: CriticalPath, slots: number | null): number | null {
  if (slots === null || slots <= 0) return null;
  return Math.max(path.ms, path.workMs / slots);
}

/** `~1h 40m`, `~25m`, `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const h = hours % 24;
    return h === 0 ? `~${days}d` : `~${days}d ${h}h`;
  }
  return rest === 0 ? `~${hours}h` : `~${hours}h ${rest}m`;
}

/** The wall-clock finish: `4:10 PM` today, `Thu 4:10 PM` within a week, else a date. */
export function formatEta(at: number, now: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  const today = new Date(now);
  if (when.toDateString() === today.toDateString()) return time;
  if (at - now < 6 * 86_400_000) {
    const day = when.toLocaleDateString('en-US', { weekday: 'short' });
    return `${day} ${time}`;
  }
  return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
