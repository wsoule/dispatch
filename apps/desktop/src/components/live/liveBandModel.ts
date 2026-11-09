import type {
  DependentStart,
  StatusModel,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import { fanoutCoverers } from '@dispatch-foo/core/browser';
import type { MergeQueueEntryState, MilestoneProgress } from '@dispatch/client';

import { dagTaskFromDoc, dagWaves } from '../../lib/dagLayout';
import {
  buildFlightPlan,
  type FlightPlan,
  viewerHolderOf,
} from '../flightplan/flightPlan';
import { flightStructureKey } from '../flightplan/flightStructure';
import type { LiveBandActivity, LiveBandSpec } from './liveGraph';

// One Live band's model: its container's Flight Plan (the same `buildFlightPlan` the full
// view reads, so the two never disagree on a node), plus the tallies the band header and
// the page header add up. The band's chart lays the work out itself.

/** What every band reads, built once per render of the view. */
export interface LiveShared {
  model: StatusModel;
  taskById: ReadonlyMap<string, TaskListItem>;
  /** Ids with children: such a node fans out on its own plan. */
  containerIds: ReadonlySet<string>;
  /** Tasks an agent is on, dispatches still starting included. */
  flying: ReadonlySet<string>;
  /** This window's own ref, or null until known. */
  me: string | null;
  /** The daemon's own human, whom the legacy bare `human` means. */
  local: string | null;
  /** Active or paused fan-outs by container id. */
  sessions: ReadonlyMap<string, MilestoneProgress>;
  /** Tasks with a run branch a dependent can stack on (`tasksWithRunBranch`). */
  withRunBranch: ReadonlySet<string>;
  /** Tasks whose latest run has ended (`tasksWithFinishedRun`). */
  withFinishedRun: ReadonlySet<string>;
  /** The project's `orchestrator.startDependents`; undefined before config loads. */
  startDependents?: DependentStart;
  /** Tasks whose run sits in the merge queue. */
  landing: ReadonlyMap<string, MergeQueueEntryState>;
}

interface LiveBandStats {
  running: number;
  /** Queued under an active fan-out: starts as a slot frees. */
  queued: number;
  /** A teammate's, which no fan-out starts. */
  teammate: number;
  /** Blocked behind at least one teammate's task. */
  waitingOnTeammate: number;
  /** In the merge queue. */
  landing: number;
  done: number;
  total: number;
  /** Agents on work a live fan-out owns, against those fan-outs' slots (null: none). */
  slots: { used: number; total: number | null };
}

export interface LiveBandModel {
  spec: LiveBandSpec;
  plan: FlightPlan;
  /** Whether the plan has waves worth showing (Loose work's are only a pile). */
  showWaves: boolean;
  activity: LiveBandActivity;
  stats: LiveBandStats;
}

interface CachedWaves {
  structure: string;
  waves: ReadonlyMap<string, number>;
}

/** Per-band waves kept across rebuilds, so a status change never recomputes them. */
export type LiveGeometryCache = Map<string, CachedWaves>;

/**
 * The fan-out that would start `task`: the nearest covering container with a live session
 * (a session from before plan-wide fan-outs covers only its direct children), else its
 * parent. The server's rule, as the full Flight Plan reads it.
 */
function fanoutOwner(
  task: TaskListItem,
  taskById: ReadonlyMap<string, TaskListItem>,
  sessions: ReadonlyMap<string, MilestoneProgress>
): string | null {
  if (sessions.size > 0) {
    for (const id of fanoutCoverers(task, (x) => taskById.get(x))) {
      const session = sessions.get(id)?.session;
      if (session === null || session === undefined) continue;
      if (id === task.meta.parent || session.scope !== 'direct') return id;
    }
  }
  return task.meta.parent;
}

/**
 * Builds one band. `cache` (held by the view) keeps its waves while the band's structure
 * stays the same.
 */
export function buildLiveBand(
  spec: LiveBandSpec,
  shared: LiveShared,
  options: { cache?: LiveGeometryCache } = {}
): LiveBandModel {
  const { nodes } = spec.scope;
  const structure = flightStructureKey(
    nodes.map((t) => ({
      id: t.meta.id,
      created: t.meta.created,
      blockedBy: t.meta.blockedBy,
      band: spec.scope.bandOf.get(t.meta.id) ?? null,
    })),
    spec.scope.bands?.map((b) => b.key) ?? null
  );
  const cached = options.cache?.get(spec.key);
  const waves =
    cached?.structure === structure
      ? cached.waves
      : dagWaves(nodes.map(dagTaskFromDoc));

  const ownerById = new Map<string, string | null>();
  const liveOwners = new Set<string>();
  for (const task of nodes) {
    const owner = fanoutOwner(task, shared.taskById, shared.sessions);
    ownerById.set(task.meta.id, owner);
    if (owner !== null && shared.sessions.has(owner)) liveOwners.add(owner);
  }
  let concurrency: number | null = null;
  for (const owner of liveOwners) {
    const session = shared.sessions.get(owner)?.session;
    if (session !== null && session !== undefined) {
      concurrency = (concurrency ?? 0) + session.concurrency;
    }
  }
  const plan = buildFlightPlan(nodes, {
    liveTaskIds: shared.flying,
    model: shared.model,
    concurrency,
    containerIds: shared.containerIds,
    waves,
    me: shared.me,
    local: shared.local,
    ownerOf: (task) => ownerById.get(task.meta.id) ?? task.meta.parent,
    startedByOf: (owner) =>
      shared.sessions.get(owner)?.session?.startedBy ?? null,
    withRunBranch: shared.withRunBranch,
    withFinishedRun: shared.withFinishedRun,
    startDependents: shared.startDependents,
    lookup: (id) => shared.taskById.get(id),
  });

  options.cache?.set(spec.key, { structure, waves });

  // A blocker in a teammate's hands: not this window's, and (in the band) not one its
  // own fan-out starts — in a teammate's fan-out, the plan reads holders from its starter.
  const nodeById = new Map(plan.nodes.map((n) => [n.task.meta.id, n]));
  const teammateOf = viewerHolderOf(shared.me, shared.local);
  const held = (id: string): boolean => {
    const task = shared.taskById.get(id);
    if (task === undefined || teammateOf(task) === null) return false;
    const node = nodeById.get(id);
    return node === undefined || node.holder !== null;
  };
  const stats: LiveBandStats = {
    running: plan.running,
    queued: 0,
    teammate: 0,
    waitingOnTeammate: 0,
    landing: 0,
    done: plan.done,
    total: plan.total,
    slots: { used: 0, total: concurrency },
  };
  for (const node of plan.nodes) {
    const owner = ownerById.get(node.task.meta.id) ?? null;
    const session =
      owner === null ? undefined : shared.sessions.get(owner)?.session;
    if (node.state === 'running' && session !== null && session !== undefined)
      stats.slots.used++;
    if (node.state === 'queued' && session?.state === 'active') stats.queued++;
    if (node.state === 'teammate') stats.teammate++;
    if (node.state === 'blocked' && node.waitingOn.some(held))
      stats.waitingOnTeammate++;
    if (shared.landing.has(node.task.meta.id)) stats.landing++;
  }

  const own = spec.progress?.session?.state;
  return {
    spec,
    plan,
    showWaves: spec.kind !== 'loose',
    activity: {
      running: plan.running,
      queued: stats.queued,
      session: own === 'active' || own === 'paused' ? own : null,
    },
    stats,
  };
}

/** Every band added up, for the page header. */
export interface LiveTotals {
  /** Agents on fan-out work, against every live fan-out's slots. */
  slots: { used: number; total: number };
  running: number;
  queued: number;
  waitingOnTeammate: number;
  landing: number;
}

export function liveTotals(
  bands: readonly LiveBandModel[],
  sessions: readonly MilestoneProgress[]
): LiveTotals {
  const totals: LiveTotals = {
    slots: { used: 0, total: 0 },
    running: 0,
    queued: 0,
    waitingOnTeammate: 0,
    landing: 0,
  };
  for (const progress of sessions) {
    const session = progress.session;
    if (session?.state === 'active' || session?.state === 'paused') {
      totals.slots.total += session.concurrency;
    }
  }
  for (const band of bands) {
    totals.slots.used += band.stats.slots.used;
    totals.running += band.stats.running;
    totals.queued += band.stats.queued;
    totals.waitingOnTeammate += band.stats.waitingOnTeammate;
    totals.landing += band.stats.landing;
  }
  return totals;
}
