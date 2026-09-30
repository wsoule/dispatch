import type { EpicProgress, MergeQueueEntryState } from '@dispatch/client';
import type { StatusModel, TaskListItem } from '@dispatch/core/browser';
import { fanoutCoverers } from '@dispatch/core/browser';

import { dagTaskFromDoc, dagWaves } from '../../lib/dagLayout';
import { type FlightNavIndex, flightNavIndex } from '../flightplan/flightKeys';
import {
  type FlightLayout,
  flightLayout,
  type FlightLayoutInput,
  flightStructureKey,
} from '../flightplan/flightLayout';
import {
  buildFlightPlan,
  type FlightPlan,
  viewerHolderOf,
} from '../flightplan/flightPlan';
import type { LiveBandActivity, LiveBandSpec } from './liveGraph';

// One Live band's model: its container's Flight Plan (the same `buildFlightPlan` the full
// view reads, so the two never disagree on a node), laid out with the finished leading
// waves folded to a count, plus the tallies the band header and the page header add up.

/** Loose work has no waves worth naming; its cards fill a grid this many rows tall. */
const LOOSE_ROWS = 3;

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
  sessions: ReadonlyMap<string, EpicProgress>;
  /** Tasks with a run branch a dependent can stack on (`tasksWithRunBranch`). */
  withRunBranch: ReadonlySet<string>;
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
  /** The drawn part of the plan, its columns renumbered from the first unfolded wave. */
  layout: FlightLayout;
  nav: FlightNavIndex;
  /** Drawn node ids in reading order: wave by wave, each top to bottom. */
  order: string[];
  /** A layout column's wave plus this is the plan's wave. */
  waveOffset: number;
  /** The finished leading waves, and the tasks in them: folded away unless expanded. */
  finishedWaves: { waves: number; tasks: number };
  /** Whether the columns are waves (Loose work's are only a grid). */
  showWaves: boolean;
  activity: LiveBandActivity;
  stats: LiveBandStats;
}

interface CachedGeometry {
  structure: string;
  waves: ReadonlyMap<string, number>;
  layoutKey: string;
  layout: FlightLayout;
  nav: FlightNavIndex;
}

/** Per-band geometry kept across rebuilds, so a status change never re-lays out a band. */
export type LiveGeometryCache = Map<string, CachedGeometry>;

/**
 * The fan-out that would start `task`: the nearest covering container with a live session
 * (a session from before plan-wide fan-outs covers only its direct children), else its
 * parent. The server's rule, as the full Flight Plan reads it.
 */
function fanoutOwner(
  task: TaskListItem,
  taskById: ReadonlyMap<string, TaskListItem>,
  sessions: ReadonlyMap<string, EpicProgress>
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

// Leading waves whose every node finished; the last wave always stays drawn.
function finishedLead(plan: FlightPlan): number {
  let count = 0;
  const last = plan.waves.length - 1;
  while (count < last) {
    const wave = plan.waves[count];
    if (wave === undefined || wave.done < wave.total) break;
    count++;
  }
  return count;
}

// The layout's input: every node on a grid for Loose work, else the nodes from the first
// unfolded wave on, renumbered, in the bands that still hold any.
function layoutInput(
  spec: LiveBandSpec,
  waves: ReadonlyMap<string, number>,
  offset: number
): { nodes: FlightLayoutInput[]; bands: string[] | null } {
  const { scope } = spec;
  if (spec.kind === 'loose') {
    return {
      nodes: scope.nodes.map((t, i) => ({
        id: t.meta.id,
        created: t.meta.created,
        blockedBy: t.meta.blockedBy,
        wave: Math.floor(i / LOOSE_ROWS),
        band: null,
      })),
      bands: null,
    };
  }
  const nodes: FlightLayoutInput[] = [];
  const bandsShown = new Set<string>();
  for (const t of scope.nodes) {
    const wave = waves.get(t.meta.id) ?? 0;
    if (wave < offset) continue;
    const band = scope.bandOf.get(t.meta.id) ?? null;
    if (band !== null) bandsShown.add(band);
    nodes.push({
      id: t.meta.id,
      created: t.meta.created,
      blockedBy: t.meta.blockedBy,
      wave: wave - offset,
      band,
    });
  }
  return {
    nodes,
    bands:
      scope.bands === null
        ? null
        : scope.bands.map((b) => b.key).filter((k) => bandsShown.has(k)),
  };
}

/**
 * Builds one band. `expanded` draws the finished leading waves too; `cache` (held by the
 * view) keeps waves and layout while the band's structure and fold stay the same.
 */
export function buildLiveBand(
  spec: LiveBandSpec,
  shared: LiveShared,
  options: { expanded: boolean; cache?: LiveGeometryCache }
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
    lookup: (id) => shared.taskById.get(id),
  });

  const loose = spec.kind === 'loose';
  const finished = loose ? 0 : finishedLead(plan);
  const offset = options.expanded ? 0 : finished;
  const layoutKey = `${structure}#${loose ? 'loose' : offset}`;
  let layout: FlightLayout;
  let nav: FlightNavIndex;
  if (cached?.layoutKey === layoutKey) {
    layout = cached.layout;
    nav = cached.nav;
  } else {
    const input = layoutInput(spec, waves, offset);
    layout = flightLayout(input.nodes, input.bands);
    nav = flightNavIndex(layout.boxes);
  }
  options.cache?.set(spec.key, { structure, waves, layoutKey, layout, nav });

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
  let finishedTasks = 0;
  for (let i = 0; i < finished; i++) finishedTasks += plan.waves[i]?.total ?? 0;
  return {
    spec,
    plan,
    layout,
    nav,
    order: nav.columns.flat(),
    waveOffset: offset,
    finishedWaves: { waves: finished, tasks: finishedTasks },
    showWaves: !loose,
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
  sessions: readonly EpicProgress[]
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
