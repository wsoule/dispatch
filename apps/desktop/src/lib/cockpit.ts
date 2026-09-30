import type {
  EpicProgress,
  MergeQueueEntry,
  ReadinessReading,
  RunMeta,
} from '@dispatch/client';
import type { Person, StatusModel, TaskListItem } from '@dispatch/core/browser';
import {
  canonicalAssignee,
  hasStatusRole,
  isContainer,
  isStartedStatus,
  parentIdsOf,
  PRIORITY_ORDER,
  readyTasks,
} from '@dispatch/core/browser';

import { isTerminalRunState } from './runState';
import type { TaskAttention } from './taskAttention';
import { assigneeRef } from './taskDisplay';
import type { RowGroup } from './virtualRows';

// The Cockpit's three lanes, derived purely from data the app already caches: the task
// list, the run list, the attention map and the live fan-out sessions. No fetch of its own,
// so the home view renders the moment the caches do.

export type CockpitLaneId = 'ready' | 'flight' | 'needs';

/** Left to right in the order work moves: pick it, run it, land it. */
export const COCKPIT_LANES: readonly CockpitLaneId[] = [
  'ready',
  'flight',
  'needs',
];

/** Whose work the lanes show. */
export type CockpitScope =
  | { kind: 'me' }
  | { kind: 'team' }
  | { kind: 'person'; ref: string };

/** Why a row sits in Needs you, most pressing first. */
export type NeedsReason =
  | 'waiting'
  | 'failed'
  | 'review'
  | 'in-review'
  | 'unclear';

const NEEDS_ORDER: Record<NeedsReason, number> = {
  waiting: 0,
  failed: 1,
  review: 2,
  'in-review': 3,
  unclear: 4,
};

interface ItemBase {
  /** Unique within its lane — the virtual row key. */
  key: string;
  /** The task a row opens. */
  taskId: string;
  /** The person the row belongs to (a canonical `human:` ref), or null for an agent's or
   * nobody's — what the roster groups by. */
  owner: string | null;
}

export type CockpitItem =
  | (ItemBase & { kind: 'ready'; task: TaskListItem })
  /** Dispatched from here, run not seen yet — the optimistic row. */
  | (ItemBase & { kind: 'starting'; task: TaskListItem; startedAt: number })
  | (ItemBase & {
      kind: 'run';
      run: RunMeta;
      task: TaskListItem | undefined;
      /** Sits under its container's fan-out row. */
      nested: boolean;
    })
  | (ItemBase & {
      kind: 'fanout';
      container: TaskListItem | undefined;
      progress: EpicProgress;
    })
  /** A person's started task with no live run — a teammate at work by hand. */
  | (ItemBase & { kind: 'started'; task: TaskListItem })
  /** A finished run the merge queue is landing. */
  | (ItemBase & {
      kind: 'landing';
      task: TaskListItem | undefined;
      run: RunMeta | undefined;
      /** When the entry reached its current step. */
      since: string;
    })
  | (ItemBase & {
      kind: 'needs';
      reason: NeedsReason;
      task: TaskListItem | undefined;
      run: RunMeta | undefined;
      /** When it started waiting, for oldest-first. */
      since: string;
    });

type NeedsItem = Extract<CockpitItem, { kind: 'needs' }>;

export interface CockpitLanes {
  ready: CockpitItem[];
  flight: CockpitItem[];
  needs: CockpitItem[];
}

/**
 * The per-task half of the lanes: everything that depends only on the task list and the
 * status model, so the view can hold it across scope flips, dispatches and run updates
 * and redo only the cheap filtering (`buildCockpit`) for those.
 */
export interface CockpitIndex {
  taskById: ReadonlyMap<string, TaskListItem>;
  /** Unstarted and unblocked, ranked by `compareReady`. */
  ready: readonly TaskListItem[];
  /** In the review role and not archived. */
  inReview: readonly TaskListItem[];
  /** Started, not a container, not archived — most recently updated first. */
  started: readonly TaskListItem[];
}

export interface CockpitInput {
  index: CockpitIndex;
  runs: readonly RunMeta[];
  latestRunByTaskId: ReadonlyMap<string, RunMeta>;
  attentionByTaskId: ReadonlyMap<string, TaskAttention>;
  /** Containers with an active or paused fan-out session. */
  liveEpicSessions: readonly EpicProgress[];
  readinessById: ReadonlyMap<string, ReadinessReading>;
  /** This window's own ref; null until the daemon says. */
  me: string | null;
  /** The daemon's own human (`localHuman`); null until the daemon says, or on an older
   * one. Whom a run nobody signed, or a fan-out nobody named, belongs to. */
  local: string | null;
  scope: CockpitScope;
  /** Tasks dispatched from the Cockpit whose run has not shown up yet, with when. */
  pending: ReadonlyMap<string, number>;
  /** Each task's merge-queue entry, in queue order (`landingEntryByTaskId`). */
  landing: ReadonlyMap<string, MergeQueueEntry>;
}

/** The person an assignee names — a canonical `human:` ref — or null for an agent, the
 * bare `agent`, or nobody. The legacy bare `human` means this window's own user. */
export function personOf(
  assignee: string | null | undefined,
  me: string | null
): string | null {
  if (assignee === null || assignee === undefined) return null;
  const canonical = me === null ? assignee : canonicalAssignee(assignee, me);
  const ref = assigneeRef(canonical);
  if (ref === null || ref.kind !== 'human' || ref.handle === null) return null;
  return canonical;
}

/** Whether a scope covers work owned by `owner`. `openCounts` lets the Ready lane's `me`
 * include unowned work (unassigned, or handed to the agent pool) anyone may pick up. */
export function inScope(
  owner: string | null,
  scope: CockpitScope,
  me: string | null,
  openCounts = false
): boolean {
  switch (scope.kind) {
    case 'team':
      return true;
    case 'person':
      return owner === scope.ref;
    case 'me':
      return owner === null ? openCounts : owner === me;
  }
}

// Code-unit order: ISO dates and ids sort correctly as plain strings, and this is several
// times cheaper than `localeCompare` across a 2000-task ranking.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ISO dates sort as strings; `null` sorts last.
function compareNullableIso(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

/** Ready's ranking: priority, then due date, then cycle (the earlier cycle first), then
 * age (oldest first), then id so the order is total. No due date or cycle sorts last. */
export function compareReady(a: TaskListItem, b: TaskListItem): number {
  const byPriority =
    PRIORITY_ORDER[a.meta.priority] - PRIORITY_ORDER[b.meta.priority];
  if (byPriority !== 0) return byPriority;
  const byDue = compareNullableIso(a.meta.dueDate, b.meta.dueDate);
  if (byDue !== 0) return byDue;
  const byCycle = compareNullableIso(
    a.meta.cycle?.startsAt ?? null,
    b.meta.cycle?.startsAt ?? null
  );
  if (byCycle !== 0) return byCycle;
  const byAge = compareStrings(a.meta.created, b.meta.created);
  return byAge !== 0 ? byAge : compareStrings(a.meta.id, b.meta.id);
}

/** Indexes the task list for the lanes: one pass for the review and started buckets, core's
 * `readyTasks` for the queue. Pass every task, archived included. */
export function indexCockpitTasks(
  tasks: readonly TaskListItem[],
  model: StatusModel
): CockpitIndex {
  const taskById = new Map<string, TaskListItem>();
  for (const task of tasks) taskById.set(task.meta.id, task);
  const parentIds = parentIdsOf(tasks);
  const inReview: TaskListItem[] = [];
  const started: TaskListItem[] = [];
  for (const task of tasks) {
    if (task.meta.archivedAt !== undefined) continue;
    if (hasStatusRole(task.meta.status, 'review', model)) inReview.push(task);
    if (
      !isContainer(task.meta, parentIds) &&
      isStartedStatus(task.meta.status, model)
    ) {
      started.push(task);
    }
  }
  started.sort((a, b) => compareStrings(b.meta.updated, a.meta.updated));
  return {
    taskById,
    ready: readyTasks(tasks, model).sort(compareReady),
    inReview,
    started,
  };
}

/** A row's compact age: `now`, `12m`, `4h`, `60d`. An unparseable time reads as a dash. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// A reading of 0 means the spec is a title and nothing else.
function isUnclearSpec(reading: ReadinessReading | undefined): boolean {
  return reading !== undefined && reading.level === 0;
}

/** Whether a run is still going (not finished, failed or cancelled). */
function isLive(run: RunMeta): boolean {
  return !isTerminalRunState(run.state);
}

/**
 * The three lanes. Ready is the unstarted, unblocked queue (core's `readyTasks` under the
 * project's status model) in scope, ranked by `compareReady`. In flight is every live run —
 * fan-outs first with their runs nested under them, then the rest newest first — plus
 * rows for dispatches still starting, runs the merge queue is landing (in queue order,
 * owned like a run) and people's started tasks with no run. Needs you is
 * runs waiting on a human (approval, question, blocked checkout), failed and awaiting
 * review, then tasks in the review status, then unclear specs assigned to someone. A task
 * appears in one lane only.
 */
export function buildCockpit(input: CockpitInput): CockpitLanes {
  const { me, scope, index } = input;
  const { taskById } = index;
  const claimed = new Set<string>();
  // Every assignee string resolves once per build — a few distinct values over 2000 tasks.
  const owners = new Map<string, string | null>();
  const ownerOf = (assignee: string | null | undefined): string | null => {
    if (assignee === null || assignee === undefined) return null;
    let owner = owners.get(assignee);
    if (owner === undefined) {
      owner = personOf(assignee, me);
      owners.set(assignee, owner);
    }
    return owner;
  };
  // Each live fan-out, by the tasks it covers: a run it started carries no signature.
  const sessionOf = new Map<string, EpicProgress>();
  for (const progress of input.liveEpicSessions) {
    for (const child of progress.children) {
      if (!sessionOf.has(child.id)) sessionOf.set(child.id, progress);
    }
  }
  // What nobody signed is this window's only where it is the daemon's own human (a
  // single-user daemon, or an older one that names none); elsewhere it is nobody's.
  const unsigned = input.local === null || input.local === me ? me : null;
  // A fan-out belongs to whoever started it; one that names nobody, to the daemon's human.
  const starterOf = (progress: EpicProgress): string | null => {
    const starter = progress.session?.startedBy ?? input.local;
    return starter === null ? unsigned : ownerOf(starter);
  };
  // A run belongs to whoever dispatched it, else to whoever started its fan-out.
  const runOwner = (run: RunMeta): string | null => {
    if (run.dispatchedBy !== undefined) return ownerOf(run.dispatchedBy);
    const progress = sessionOf.get(run.taskId);
    return progress === undefined ? unsigned : starterOf(progress);
  };

  // Needs you first: whatever lands here leaves the other two lanes.
  const needs: NeedsItem[] = [];
  for (const [taskId, attention] of input.attentionByTaskId) {
    const run = input.latestRunByTaskId.get(taskId);
    const task = taskById.get(taskId);
    const owner =
      run === undefined ? ownerOf(task?.meta.assignee) : runOwner(run);
    if (!inScope(owner, scope, me)) continue;
    claimed.add(taskId);
    needs.push({
      kind: 'needs',
      key: `needs:${taskId}`,
      taskId,
      owner,
      reason: attention,
      task,
      run,
      since: run?.updatedAt ?? task?.meta.updated ?? '',
    });
  }
  for (const task of index.inReview) {
    const id = task.meta.id;
    if (claimed.has(id)) continue;
    const owner = ownerOf(task.meta.assignee);
    if (owner === null || !inScope(owner, scope, me)) continue;
    claimed.add(id);
    needs.push({
      kind: 'needs',
      key: `needs:${id}`,
      taskId: id,
      owner,
      reason: 'in-review',
      task,
      run: input.latestRunByTaskId.get(id),
      since: task.meta.updated,
    });
  }

  // Ready: the unstarted, unblocked queue. A spec flagged as bare title goes to its
  // owner's Needs you instead — it wants words before it wants an agent.
  const ready: CockpitItem[] = [];
  for (const task of index.ready) {
    const id = task.meta.id;
    if (claimed.has(id) || input.pending.has(id)) continue;
    const owner = ownerOf(task.meta.assignee);
    if (!inScope(owner, scope, me, true)) continue;
    if (owner !== null && isUnclearSpec(input.readinessById.get(id))) {
      claimed.add(id);
      needs.push({
        kind: 'needs',
        key: `needs:${id}`,
        taskId: id,
        owner,
        reason: 'unclear',
        task,
        run: undefined,
        since: task.meta.updated,
      });
      continue;
    }
    ready.push({ kind: 'ready', key: id, taskId: id, owner, task });
  }
  needs.sort(
    (a, b) =>
      NEEDS_ORDER[a.reason] - NEEDS_ORDER[b.reason] ||
      compareStrings(a.since, b.since)
  );

  // In flight.
  const flight: CockpitItem[] = [];
  // A live run waiting on a human (an approval, a question) sits in Needs you only.
  const liveRuns = input.runs.filter(
    (run) => isLive(run) && !claimed.has(run.taskId)
  );
  const liveTaskIds = new Set(liveRuns.map((run) => run.taskId));
  for (const [taskId, startedAt] of input.pending) {
    const task = taskById.get(taskId);
    if (task === undefined || liveTaskIds.has(taskId)) continue;
    claimed.add(taskId);
    flight.push({
      kind: 'starting',
      key: `starting:${taskId}`,
      taskId,
      owner: me,
      task,
      startedAt,
    });
  }
  for (const progress of input.liveEpicSessions) {
    const nestedRuns = liveRuns.filter(
      (run) =>
        sessionOf.get(run.taskId) === progress &&
        inScope(runOwner(run), scope, me)
    );
    const container = taskById.get(progress.epicId);
    const owner = ownerOf(container?.meta.assignee) ?? starterOf(progress);
    if (nestedRuns.length === 0 && !inScope(owner, scope, me)) continue;
    flight.push({
      kind: 'fanout',
      key: `fanout:${progress.epicId}`,
      taskId: progress.epicId,
      owner,
      container,
      progress,
    });
    for (const run of nestedRuns) {
      claimed.add(run.taskId);
      flight.push({
        kind: 'run',
        key: `run:${run.id}`,
        taskId: run.taskId,
        owner: runOwner(run),
        run,
        task: taskById.get(run.taskId),
        nested: true,
      });
    }
  }
  const looseRuns = liveRuns
    .filter(
      (run) => !sessionOf.has(run.taskId) && inScope(runOwner(run), scope, me)
    )
    .sort((a, b) => compareStrings(b.createdAt, a.createdAt));
  for (const run of looseRuns) {
    claimed.add(run.taskId);
    flight.push({
      kind: 'run',
      key: `run:${run.id}`,
      taskId: run.taskId,
      owner: runOwner(run),
      run,
      task: taskById.get(run.taskId),
      nested: false,
    });
  }
  // A held landing already waits on its owner in Needs you (its attention claimed it).
  for (const [taskId, entry] of input.landing) {
    if (claimed.has(taskId) || liveTaskIds.has(taskId)) continue;
    const latest = input.latestRunByTaskId.get(taskId);
    const run =
      latest?.id === entry.runId
        ? latest
        : input.runs.find((r) => r.id === entry.runId);
    const task = taskById.get(taskId);
    const owner =
      run === undefined ? ownerOf(task?.meta.assignee) : runOwner(run);
    if (!inScope(owner, scope, me)) continue;
    claimed.add(taskId);
    flight.push({
      kind: 'landing',
      key: `landing:${taskId}`,
      taskId,
      owner,
      task,
      run,
      since: entry.stateSince ?? entry.enqueuedAt,
    });
  }
  for (const task of index.started) {
    const id = task.meta.id;
    if (claimed.has(id) || liveTaskIds.has(id)) continue;
    const owner = ownerOf(task.meta.assignee);
    if (owner === null || !inScope(owner, scope, me)) continue;
    flight.push({ kind: 'started', key: id, taskId: id, owner, task });
  }

  return { ready, flight, needs };
}

/** A roster group's header: one person (or the agents/nobody bucket). */
export interface RosterHeader {
  owner: string | null;
  name: string;
  person: Person | undefined;
  count: number;
}

/**
 * The roster (`g p`): one lane's items grouped by owner — you first, then everyone else by
 * name, then the unowned bucket — each group headed by its person. A nested run stays
 * under its fan-out only when both share an owner; otherwise it joins its own person.
 */
export function groupByOwner(
  items: readonly CockpitItem[],
  people: readonly Person[],
  me: string | null
): RowGroup<RosterHeader, CockpitItem>[] {
  const byOwner = new Map<string | null, CockpitItem[]>();
  for (const item of items) {
    const bucket = byOwner.get(item.owner);
    if (bucket === undefined) byOwner.set(item.owner, [item]);
    else bucket.push(item);
  }
  const personByRef = new Map(people.map((p) => [p.ref, p]));
  const nameOf = (owner: string | null) =>
    owner === null
      ? 'Agents & unassigned'
      : (personByRef.get(owner)?.name ?? assigneeRef(owner)?.handle ?? owner);
  const owners = [...byOwner.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === me) return -1;
    if (b === me) return 1;
    if (a === null) return 1;
    if (b === null) return -1;
    return nameOf(a).localeCompare(nameOf(b));
  });
  return owners.map((owner) => {
    const groupItems = byOwner.get(owner) ?? [];
    return {
      key: `owner:${owner ?? 'none'}`,
      header: {
        owner,
        name: nameOf(owner),
        person: owner === null ? undefined : personByRef.get(owner),
        count: groupItems.length,
      },
      items: groupItems,
    };
  });
}
