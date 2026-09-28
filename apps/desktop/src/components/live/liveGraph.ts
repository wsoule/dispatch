import type { EpicProgress } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import { canonicalKind, isContainerKind } from '@dispatch/core/browser';

import { type FlightScope, flightScope } from '../flightplan/flightScope';

// The Live view's selection: which containers have work in motion right now, one band
// each, in the order the eye should take them, plus a Loose work band for agents running
// outside every container. Pure over the caches the app already holds.

/** The Loose work band's key. */
export const LOOSE_BAND = '__loose';

/**
 * Why a band is on screen:
 * - `fanout`: its container has an active or paused fan-out session;
 * - `activity`: no session, but a child is running, landing or waiting on a review;
 * - `loose`: running or landing tasks that belong to no container.
 */
type LiveBandKind = 'fanout' | 'activity' | 'loose';

export interface LiveBandSpec {
  key: string;
  kind: LiveBandKind;
  /** The band's container; null for Loose work. */
  container: TaskListItem | null;
  /** The container's active or paused fan-out, else null. */
  progress: EpicProgress | null;
  scope: FlightScope;
}

/** A set of task ids: a `Set`, or the keys of a map keyed by task id. */
interface IdSet {
  has: (id: string) => boolean;
  keys: () => Iterable<string>;
}

export interface LiveSelectionInput {
  taskById: ReadonlyMap<string, TaskListItem>;
  children: ReadonlyMap<string, readonly TaskListItem[]>;
  /** Fan-outs whose session is active or paused. */
  sessions: readonly EpicProgress[];
  /** Tasks an agent is on: a live run, or a dispatch whose run has not shown up yet. */
  flying: IdSet;
  /** Tasks whose run sits in the merge queue. */
  landing: IdSet;
  /** Tasks whose finished run waits on a review. */
  reviewPending: IdSet;
}

function byCreatedThenId(a: TaskListItem, b: TaskListItem): number {
  const x = a.meta;
  const y = b.meta;
  if (x.created !== y.created) return x.created < y.created ? -1 : 1;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

// A session nested under another live, plan-wide one: the outer plan already draws its
// work (as a milestone band), so it gets no band of its own. Only container kinds nest —
// a parent issue is one node of its container's plan, its sub-issues its own.
function nestedInLivePlan(
  id: string,
  live: ReadonlyMap<string, EpicProgress>,
  taskById: ReadonlyMap<string, TaskListItem>
): boolean {
  const task = taskById.get(id);
  if (task === undefined || !isContainerKind(task.meta.kind)) return false;
  const seen = new Set([id]);
  let parent = task.meta.parent;
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const node = taskById.get(parent);
    if (node === undefined || !isContainerKind(node.meta.kind)) return false;
    const session = live.get(parent)?.session;
    if (session !== null && session !== undefined && session.scope !== 'direct')
      return true;
    parent = node.meta.parent;
  }
  return false;
}

// A container's direct work, no sub-plans.
function directScope(
  container: TaskListItem,
  children: ReadonlyMap<string, readonly TaskListItem[]>
): FlightScope {
  return {
    nodes: (children.get(container.meta.id) ?? [])
      .filter((c) => !isContainerKind(c.meta.kind))
      .sort(byCreatedThenId),
    bands: null,
    bandOf: new Map(),
  };
}

// What an activity band draws: the container's own plan, except that a project or
// initiative draws only its direct work — one running task under it should not pull in
// every milestone below.
function activityScope(
  container: TaskListItem,
  children: ReadonlyMap<string, readonly TaskListItem[]>
): FlightScope {
  const kind = canonicalKind(container.meta.kind);
  return kind === 'project' || kind === 'initiative'
    ? directScope(container, children)
    : flightScope(container, children);
}

/**
 * The bands to draw, unordered (see `orderLiveBands`). Every live fan-out gets one, drawing
 * what it covers (its container's Flight Plan scope, or only the direct work of a session
 * from before plan-wide fan-outs), unless a live plan-wide fan-out above it already covers
 * it. Then each task in motion that no band holds yet (running, starting, landing,
 * or waiting on a review) brings in its parent container's band. Running and landing tasks
 * with no parent go to Loose work. A task sits in one band only.
 */
export function selectLiveBands(input: LiveSelectionInput): LiveBandSpec[] {
  const { taskById, children } = input;
  const live = new Map<string, EpicProgress>();
  for (const progress of input.sessions) {
    if (taskById.has(progress.epicId)) live.set(progress.epicId, progress);
  }

  const bands: LiveBandSpec[] = [];
  const keys = new Set<string>();
  const claimed = new Set<string>();
  const add = (spec: LiveBandSpec) => {
    bands.push(spec);
    keys.add(spec.key);
    for (const task of spec.scope.nodes) claimed.add(task.meta.id);
  };

  for (const [id, progress] of live) {
    const container = taskById.get(id);
    if (container === undefined || nestedInLivePlan(id, live, taskById)) {
      continue;
    }
    add({
      key: id,
      kind: 'fanout',
      container,
      progress,
      scope:
        progress.session?.scope === 'direct'
          ? directScope(container, children)
          : flightScope(container, children),
    });
  }

  const moving = new Set<string>();
  for (const set of [input.flying, input.landing, input.reviewPending]) {
    for (const id of set.keys()) moving.add(id);
  }
  const loose: TaskListItem[] = [];
  for (const id of [...moving].sort()) {
    if (claimed.has(id)) continue;
    const task = taskById.get(id);
    if (task === undefined || isContainerKind(task.meta.kind)) continue;
    const parentId = task.meta.parent;
    const parent = parentId === null ? undefined : taskById.get(parentId);
    if (parent === undefined) {
      // Loose work is what an agent is doing or landing; a review waits in the Cockpit.
      if (input.flying.has(id) || input.landing.has(id)) loose.push(task);
      claimed.add(id);
      continue;
    }
    if (keys.has(parent.meta.id)) continue;
    add({
      key: parent.meta.id,
      kind: 'activity',
      container: parent,
      progress: null,
      scope: activityScope(parent, children),
    });
  }

  if (loose.length > 0) {
    add({
      key: LOOSE_BAND,
      kind: 'loose',
      container: null,
      progress: null,
      scope: {
        nodes: loose.sort(byCreatedThenId),
        bands: null,
        bandOf: new Map(),
      },
    });
  }
  return bands;
}

/** How much a band has moving, for its place in the order. */
export interface LiveBandActivity {
  /** Nodes an agent is on. */
  running: number;
  /** Nodes an active fan-out will start as slots free. */
  queued: number;
  /** The band's own fan-out, or null. */
  session: 'active' | 'paused' | null;
}

/** 0 running, 1 an active fan-out (queued work first), 2 paused, 3 anything else
 * (landing or waiting on a review). */
function activityTier(activity: LiveBandActivity): number {
  if (activity.running > 0) return 0;
  if (activity.session === 'active') return 1;
  if (activity.session === 'paused') return 2;
  return 3;
}

const KIND_ORDER: Record<LiveBandKind, number> = {
  fanout: 0,
  activity: 1,
  loose: 2,
};

/**
 * Bands by activity: running first, then active fan-outs (the more queued the sooner),
 * then paused ones, then the rest. Within a tier fan-outs lead, Loose work trails, and
 * titles keep the order steady while counts tick.
 */
export function orderLiveBands<
  T extends { spec: LiveBandSpec; activity: LiveBandActivity },
>(bands: readonly T[]): T[] {
  const title = (spec: LiveBandSpec) => spec.container?.meta.title ?? '';
  return [...bands].sort((a, b) => {
    const tier = activityTier(a.activity) - activityTier(b.activity);
    if (tier !== 0) return tier;
    if (
      activityTier(a.activity) === 1 &&
      a.activity.queued !== b.activity.queued
    )
      return b.activity.queued - a.activity.queued;
    const kind = KIND_ORDER[a.spec.kind] - KIND_ORDER[b.spec.kind];
    if (kind !== 0) return kind;
    const byTitle = title(a.spec).localeCompare(title(b.spec));
    if (byTitle !== 0) return byTitle;
    return a.spec.key < b.spec.key ? -1 : a.spec.key > b.spec.key ? 1 : 0;
  });
}

/** A container ready to fan out, for the empty state. */
export interface ReadyContainer {
  container: TaskListItem;
  /** Direct work a fan-out would start now. */
  ready: number;
  /** Its direct work, finished or not. */
  total: number;
}

export interface ReadyContainerInput {
  taskById: ReadonlyMap<string, TaskListItem>;
  children: ReadonlyMap<string, readonly TaskListItem[]>;
  /** Unstarted and unblocked (the app's ready set). */
  readyIds: ReadonlySet<string>;
  /** The person a task belongs to when a fan-out may not start it, else null. */
  holderOf: (task: TaskListItem) => string | null;
  /** Containers with a live fan-out, left out: they are already going. */
  liveIds: ReadonlySet<string>;
  limit: number;
}

/**
 * The milestones and parent issues with the most work a fan-out would start right now —
 * ready, no teammate's, and nothing only a person starts (critical risk, or a task derived
 * from a review: the Flight Plan's `queued` rule). Projects and initiatives are left out:
 * their milestones say the same thing more precisely. Most ready first, then by title.
 */
export function readyContainers(input: ReadyContainerInput): ReadyContainer[] {
  const counts = new Map<string, number>();
  for (const id of input.readyIds) {
    const task = input.taskById.get(id);
    if (task === undefined || isContainerKind(task.meta.kind)) continue;
    if (
      task.meta.archivedAt !== undefined ||
      task.meta.risk === 'critical' ||
      task.meta.derivedFrom !== undefined ||
      input.holderOf(task) !== null
    ) {
      continue;
    }
    const parent = task.meta.parent;
    if (parent === null || input.liveIds.has(parent)) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const out: ReadyContainer[] = [];
  for (const [id, ready] of counts) {
    const container = input.taskById.get(id);
    if (container === undefined || container.meta.archivedAt !== undefined) {
      continue;
    }
    const kind = canonicalKind(container.meta.kind);
    if (kind === 'project' || kind === 'initiative') continue;
    const total = (input.children.get(id) ?? []).filter(
      (c) => !isContainerKind(c.meta.kind)
    ).length;
    out.push({ container, ready, total });
  }
  return out
    .sort(
      (a, b) =>
        b.ready - a.ready ||
        a.container.meta.title.localeCompare(b.container.meta.title)
    )
    .slice(0, input.limit);
}
