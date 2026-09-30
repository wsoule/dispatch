import type { StatusModel } from '@dispatch/core/browser';
import { isDoneStatus } from '@dispatch/core/browser';

import type { DagTask } from './dagLayout';

export interface BranchRow {
  id: string;
  /** 0 is the trunk; side branches count outward from it. */
  lane: number;
  /** 0-based position from the top; blockers sit above their dependents. */
  row: number;
  /** Whether the task is one of the unfinished critical-path tasks in `path`. */
  onPath: boolean;
}

export interface BranchEdge {
  /** The blocker (edge source) task id. */
  from: string;
  /** The blocked (edge target/dependent) task id. */
  to: string;
  fromLane: number;
  toLane: number;
  fromRow: number;
  toRow: number;
}

export interface BranchPathSummary {
  /** Unfinished tasks on the critical path — `path.length`. */
  remaining: number;
  /** The whole trunk: the done chain that led into the path plus the path itself. */
  total: number;
  /** The first path task whose blockers are all done, i.e. the one to pick up now. */
  nextId: string | null;
}

export interface BranchLayout {
  rows: BranchRow[];
  edges: BranchEdge[];
  laneCount: number;
  /** The critical path's unfinished task ids, blockers first. */
  path: string[];
  pathSummary: BranchPathSummary;
}

function emptyLayout(): BranchLayout {
  return {
    rows: [],
    edges: [],
    laneCount: 0,
    path: [],
    pathSummary: { remaining: 0, total: 0, nextId: null },
  };
}

// Same tie-break as dagLayout's and core's computeStack: created date, then id, so the layout
// never depends on the order tasks were passed in.
function byCreatedThenId(a: DagTask, b: DagTask): number {
  const byCreated = a.created.localeCompare(b.created);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

interface Graph {
  byId: Map<string, DagTask>;
  /** Real blockers only: in the set, not the task itself, deduplicated. */
  blockersOf: Map<string, string[]>;
  dependentsOf: Map<string, string[]>;
}

function buildGraph(tasks: DagTask[]): Graph {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blockersOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const t of tasks) {
    const real = [
      ...new Set(t.blockedBy.filter((id) => id !== t.id && byId.has(id))),
    ];
    blockersOf.set(t.id, real);
    for (const blockerId of real) {
      const bucket = dependentsOf.get(blockerId);
      if (bucket !== undefined) bucket.push(t.id);
      else dependentsOf.set(blockerId, [t.id]);
    }
  }
  return { byId, blockersOf, dependentsOf };
}

/**
 * Row order via Kahn's algorithm with the zero-in-degree pool re-sorted by `(created, id)` on
 * every pop. When a cycle starves the pool before every task is placed, the earliest unplaced
 * task by the same key is placed anyway and draining resumes, so its dependents still fall
 * below it and only the cycle's own back-edge points upward. Every task gets exactly one row.
 */
function orderRows(tasks: DagTask[], graph: Graph): DagTask[] {
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    inDegree.set(t.id, (graph.blockersOf.get(t.id) ?? []).length);
  }

  const placed = new Set<string>();
  const queued = new Set<string>();
  const queue: DagTask[] = [];
  for (const t of tasks) {
    if (inDegree.get(t.id) === 0) {
      queue.push(t);
      queued.add(t.id);
    }
  }

  const ordered: DagTask[] = [];
  while (ordered.length < tasks.length) {
    if (queue.length === 0) {
      const next = tasks
        .filter((t) => !placed.has(t.id))
        .sort(byCreatedThenId)[0];
      queue.push(next);
      queued.add(next.id);
    }
    queue.sort(byCreatedThenId);
    const doc = queue.shift();
    if (doc === undefined) break;
    queued.delete(doc.id);
    placed.add(doc.id);
    ordered.push(doc);

    for (const dependentId of graph.dependentsOf.get(doc.id) ?? []) {
      const remaining = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, remaining);
      const dependent = graph.byId.get(dependentId);
      if (
        remaining === 0 &&
        !placed.has(dependentId) &&
        !queued.has(dependentId) &&
        dependent !== undefined
      ) {
        queue.push(dependent);
        queued.add(dependentId);
      }
    }
  }
  return ordered;
}

/**
 * Longest chain through the tasks `member` admits, following only downward edges (blocker row
 * above dependent row) so a cycle's back-edge never loops the walk. Ties — between a task's
 * blockers and between candidate chain ends — go to the earliest `(created, id)`, which keeps
 * the answer byte-identical across calls. `endsAt` restricts which tasks may end the chain.
 */
function longestChain(
  ordered: DagTask[],
  rowOf: Map<string, number>,
  graph: Graph,
  member: (t: DagTask) => boolean,
  endsAt?: DagTask[]
): string[] {
  const best = new Map<string, number>();
  const prev = new Map<string, string>();
  const earlier = (a: DagTask, b: DagTask) => byCreatedThenId(a, b) < 0;

  for (const t of ordered) {
    if (!member(t)) continue;
    const myRow = rowOf.get(t.id) ?? 0;
    let bestBlocker: DagTask | undefined;
    for (const blockerId of graph.blockersOf.get(t.id) ?? []) {
      const blocker = graph.byId.get(blockerId);
      const score = best.get(blockerId);
      if (
        blocker === undefined ||
        score === undefined ||
        (rowOf.get(blockerId) ?? 0) >= myRow
      ) {
        continue;
      }
      const currentScore =
        bestBlocker === undefined ? -1 : (best.get(bestBlocker.id) ?? -1);
      if (
        score > currentScore ||
        (score === currentScore &&
          bestBlocker !== undefined &&
          earlier(blocker, bestBlocker))
      ) {
        bestBlocker = blocker;
      }
    }
    best.set(t.id, 1 + (bestBlocker ? (best.get(bestBlocker.id) ?? 0) : 0));
    if (bestBlocker) prev.set(t.id, bestBlocker.id);
  }

  let end: DagTask | undefined;
  for (const t of endsAt ?? ordered) {
    const score = best.get(t.id);
    if (score === undefined) continue;
    const endScore = end === undefined ? -1 : (best.get(end.id) ?? -1);
    if (score > endScore || (score === endScore && end && earlier(t, end))) {
      end = t;
    }
  }
  if (end === undefined) return [];

  const chain: string[] = [];
  for (
    let id: string | undefined = end.id;
    id !== undefined;
    id = prev.get(id)
  ) {
    chain.push(id);
  }
  return chain.reverse();
}

/**
 * Git-log style lane assignment over the rows top to bottom. The trunk owns lane 0 for the
 * whole height. A side task continues its blocker's lane when it is that blocker's last
 * dependent (the branch just carries on), otherwise it forks onto the lowest lane nobody is
 * holding. A lane is held from a task's row until its last dependent is placed, so two
 * branches whose spans overlap never share one. When the whole set has no real edges
 * (`flat`), every task sits on the trunk — a flat milestone reads as a single line of
 * commits, not a comb of one-dot branches. Once any edge exists, an edge-less task is a
 * one-dot side branch instead, so lane 0 stays the critical path and the gutter never draws
 * it as a commit on that path.
 */
function assignLanes(
  ordered: DagTask[],
  rowOf: Map<string, number>,
  graph: Graph,
  trunk: Set<string>,
  flat: boolean
): Map<string, number> {
  const lastDependentRow = new Map<string, number>();
  for (const t of ordered) {
    const myRow = rowOf.get(t.id) ?? 0;
    let last: number | undefined;
    for (const dependentId of graph.dependentsOf.get(t.id) ?? []) {
      const row = rowOf.get(dependentId) ?? 0;
      if (row > myRow && (last === undefined || row > last)) last = row;
    }
    if (last !== undefined) lastDependentRow.set(t.id, last);
  }

  const laneOf = new Map<string, number>();
  // Side lanes only (1+) and who currently holds each; the trunk never enters it.
  const holder = new Map<number, string>();

  const lowestFreeLane = () => {
    let lane = 1;
    while (holder.has(lane)) lane++;
    return lane;
  };

  for (const t of ordered) {
    const myRow = rowOf.get(t.id) ?? 0;
    const blockers = graph.blockersOf.get(t.id) ?? [];

    let lane: number;
    if (trunk.has(t.id) || flat) {
      lane = 0;
    } else {
      let inherited: number | undefined;
      for (const blockerId of blockers) {
        const blockerLane = laneOf.get(blockerId);
        if (
          blockerLane !== undefined &&
          blockerLane !== 0 &&
          holder.get(blockerLane) === blockerId &&
          lastDependentRow.get(blockerId) === myRow &&
          (inherited === undefined || blockerLane < inherited)
        ) {
          inherited = blockerLane;
        }
      }
      lane = inherited ?? lowestFreeLane();
    }
    laneOf.set(t.id, lane);
    if (lane !== 0) holder.set(lane, t.id);

    // Release every blocker whose branch ends here, then this task's own lane if nothing
    // below depends on it.
    for (const blockerId of blockers) {
      const blockerLane = laneOf.get(blockerId);
      if (
        blockerLane !== undefined &&
        blockerLane !== 0 &&
        holder.get(blockerLane) === blockerId &&
        lastDependentRow.get(blockerId) === myRow
      ) {
        holder.delete(blockerLane);
      }
    }
    if (lane !== 0 && !lastDependentRow.has(t.id)) holder.delete(lane);
  }
  return laneOf;
}

/**
 * Vertical git-log layout for one milestone's tasks: the rows to draw top to bottom, which
 * lane each dot sits in, the fork/merge edges between them, and the critical path — the
 * longest chain of unfinished tasks, which is what still stands between the milestone and
 * landed. It exists so the Branches view can show a milestone's path at a glance without a
 * charting dependency: lane 0 is the trunk (the path, plus the done chain that fed it), side
 * branches fork off it, and `pathSummary` is the one-line "4 of 9 remain · next t-xxxx".
 *
 * Only real edges count — `blockedBy` ids inside the set, never the task itself — so a caller
 * that filtered a blocker out lays out without throwing. A cycle is tolerated: every task keeps
 * a row, and the path walk only follows downward edges. Identical input gives byte-identical
 * output; row order, the path and the lanes all break ties by `(created, id)`. "Done" reads
 * the project's status model by type, so a custom "Done" or "Canceled" finishes a task.
 */
export function branchLayout(
  tasks: DagTask[],
  model: StatusModel
): BranchLayout {
  if (tasks.length === 0) return emptyLayout();

  const graph = buildGraph(tasks);
  const ordered = orderRows(tasks, graph);
  const rowOf = new Map(ordered.map((t, row) => [t.id, row]));

  const isDone = (t: DagTask) => isDoneStatus(t.status, model);
  const path = longestChain(ordered, rowOf, graph, (t) => !isDone(t));

  // The done chain the path grew out of: the longest chain of finished tasks ending at one of
  // the path head's finished blockers. With nothing left to do, the trunk is the longest done
  // chain outright, so a landed milestone still draws as one line.
  const head = path.length > 0 ? graph.byId.get(path[0]) : undefined;
  const headRow = head ? (rowOf.get(head.id) ?? 0) : 0;
  const donePrefixEnds = head
    ? (graph.blockersOf.get(head.id) ?? [])
        .map((id) => graph.byId.get(id))
        .filter(
          (t): t is DagTask =>
            t !== undefined && isDone(t) && (rowOf.get(t.id) ?? 0) < headRow
        )
    : undefined;
  const donePrefix =
    head && donePrefixEnds?.length === 0
      ? []
      : longestChain(ordered, rowOf, graph, isDone, donePrefixEnds);
  const trunk = new Set([...donePrefix, ...path]);

  const flat = [...graph.blockersOf.values()].every((b) => b.length === 0);
  const laneOf = assignLanes(ordered, rowOf, graph, trunk, flat);
  const onPath = new Set(path);

  const rows: BranchRow[] = ordered.map((t, row) => ({
    id: t.id,
    lane: laneOf.get(t.id) ?? 0,
    row,
    onPath: onPath.has(t.id),
  }));

  const edges: BranchEdge[] = [];
  for (const t of ordered) {
    const blockers = [...(graph.blockersOf.get(t.id) ?? [])].sort(
      (a, b) => (rowOf.get(a) ?? 0) - (rowOf.get(b) ?? 0)
    );
    for (const blockerId of blockers) {
      edges.push({
        from: blockerId,
        to: t.id,
        fromLane: laneOf.get(blockerId) ?? 0,
        toLane: laneOf.get(t.id) ?? 0,
        fromRow: rowOf.get(blockerId) ?? 0,
        toRow: rowOf.get(t.id) ?? 0,
      });
    }
  }

  const laneCount = 1 + Math.max(0, ...rows.map((r) => r.lane));

  const nextId =
    path.find((id) =>
      (graph.blockersOf.get(id) ?? []).every((blockerId) => {
        const blocker = graph.byId.get(blockerId);
        return blocker !== undefined && isDone(blocker);
      })
    ) ?? null;

  return {
    rows,
    edges,
    laneCount,
    path,
    pathSummary: {
      remaining: path.length,
      total: trunk.size,
      nextId,
    },
  };
}
