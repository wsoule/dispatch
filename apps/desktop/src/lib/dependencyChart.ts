import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  isCanceledStatus,
  isCompletedStatus,
} from '@dispatch-foo/core/browser';

import type { ListGroup } from './listGrouping';
import { milestoneWaits } from './milestoneMap';
import { activeStatusModel } from './statusModel';
import type { TaskBucket } from './taskStatus';

/** Where a task stands, as the chart colours it. */
export type ChartState =
  | 'landed'
  | 'ready'
  | 'working'
  | 'review'
  | 'landing'
  | 'need-you'
  | 'failed'
  | 'blocked'
  | 'draft';

export interface ChartTask {
  id: string;
  title: string;
  status: string;
  doc: TaskListItem;
  /** The milestone group's epicId, or null for the 'No milestone' group. */
  milestoneId: string | null;
  /** That group's label ('No milestone' for loose tasks). */
  milestoneTitle: string;
  state: ChartState;
}

export interface ChartModel {
  /** Every non-canceled task row in the non-archived groups, including the 'No milestone'
   * group. */
  tasks: ReadonlyMap<string, ChartTask>;
  /** Task ids in group order then row order: the layout's model order. */
  order: readonly string[];
  /** [blocker, blocked] for every blockedBy link whose two ends are both in tasks; no
   * self-loops, de-duplicated, in order of the blocked task then its blockedBy order. */
  edges: readonly (readonly [string, string])[];
  /** Each task's blockers in the chart; every task id has an entry, possibly empty. */
  blockersOf: ReadonlyMap<string, readonly string[]>;
  /** Each task's dependents in the chart; every task id has an entry, possibly empty. */
  dependentsOf: ReadonlyMap<string, readonly string[]>;
  /** blockedBy ids that are not in tasks (filtered out of this view, archived, canceled, or
   * dangling), per task; only tasks with at least one appear. */
  hiddenBlockersOf: ReadonlyMap<string, readonly string[]>;
  /** Tasks with at least one edge either way. */
  linked: ReadonlySet<string>;
  /** Tasks that are not linked and not landed, in order. */
  unlinkedOpen: readonly string[];
  /** The longest run of not-landed tasks where each waits on the one before (following edges
   * blocker → blocked), as ids from first blocker to last dependent. Ties go to the chain
   * whose first task comes earliest in order. Cycle-safe: exact when the open tasks form no
   * cycle, a best effort that never repeats a task when they do. [] when no edge joins two
   * open tasks. */
  longestChain: readonly string[];
  /** state 'ready', in order. */
  readyNow: readonly string[];
  /** state 'working' | 'review' | 'landing', in order. */
  inProgress: readonly string[];
  /** state 'need-you' | 'failed', in order. */
  needsYou: readonly string[];
  /** Task pairs behind each milestone-to-milestone wait, keyed `${from}\u0000${to}` like
   * milestoneMap's edges and counted by its rule, so a pair list's length is that edge's
   * count. Pairs are [blocker, blocked]; waits on or from canceled tasks are left out, as
   * milestoneMap leaves them out, so both ends are always in tasks. */
  milestonePairs: ReadonlyMap<string, readonly (readonly [string, string])[]>;
}

/**
 * The state a task is drawn in: 'landed' when its status is completed, else its bucket, and
 * 'draft' when the bucket is null (a container-kind row, say). Canceled tasks never reach
 * here — `dependencyChart` leaves them out.
 */
export function chartStateOf(
  doc: TaskListItem,
  bucket: TaskBucket | null,
  model?: StatusModel
): ChartState {
  if (isCompletedStatus(doc.meta.status, model ?? activeStatusModel())) {
    return 'landed';
  }
  return bucket ?? 'draft';
}

/**
 * The longest run of open tasks where each waits on the one before, following dependents
 * from blocker to blocked. An iterative depth-first search settles, for every open task, the
 * longest run starting at it: one more than its longest settled dependent's, fixed when its
 * search finishes. A dependent still on the search stack closes a cycle and is skipped, which
 * leaves the rest a DAG — so the result is exact for acyclic work, still terminates on a
 * cycle, and costs O(V+E). Searches start at open tasks with no open blocker first, so a
 * cycle is entered where outside work feeds it and the run keeps that lead-in; tasks reachable
 * only inside a cycle start after, in model order. In a DAG the start order changes nothing.
 * Ties keep the earlier dependent and, across starts, the start earliest in order. Shorter
 * than two tasks is no chain: [].
 */
function longestOpenChain(
  order: readonly string[],
  blockersOf: ReadonlyMap<string, readonly string[]>,
  dependentsOf: ReadonlyMap<string, readonly string[]>,
  isOpen: (id: string) => boolean
): string[] {
  const runFrom = new Map<string, number>();
  const next = new Map<string, string>();
  const onStack = new Set<string>();
  const sources = order.filter(
    (id) => isOpen(id) && !(blockersOf.get(id) ?? []).some(isOpen)
  );
  for (const root of [...sources, ...order]) {
    if (!isOpen(root) || runFrom.has(root)) continue;
    const stack = [{ id: root, child: 0 }];
    onStack.add(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const dependents = dependentsOf.get(frame.id) ?? [];
      if (frame.child < dependents.length) {
        const dependent = dependents[frame.child++];
        if (
          isOpen(dependent) &&
          !onStack.has(dependent) &&
          !runFrom.has(dependent)
        ) {
          onStack.add(dependent);
          stack.push({ id: dependent, child: 0 });
        }
        continue;
      }
      let best = 1;
      for (const dependent of dependents) {
        const run = runFrom.get(dependent);
        if (run === undefined || run + 1 <= best) continue;
        best = run + 1;
        next.set(frame.id, dependent);
      }
      runFrom.set(frame.id, best);
      onStack.delete(frame.id);
      stack.pop();
    }
  }

  let start: string | undefined;
  let longest = 1;
  for (const id of order) {
    const run = runFrom.get(id) ?? 0;
    if (run > longest) {
      longest = run;
      start = id;
    }
  }
  const chain: string[] = [];
  for (let at = start; at !== undefined; at = next.get(at)) chain.push(at);
  return chain;
}

/**
 * Builds the chart model from the list's groups: one node per non-canceled task (archived
 * groups skipped, loose tasks kept), the blockedBy links between them, the links that point
 * out of the view, and the summaries the chart's side panel reads — the longest open chain,
 * what can start now, what is moving and what needs you.
 */
export function dependencyChart(
  groups: readonly ListGroup[],
  ctx: {
    bucketOf: (doc: TaskListItem) => TaskBucket | null;
    model?: StatusModel;
  }
): ChartModel {
  const model = ctx.model ?? activeStatusModel();
  const tasks = new Map<string, ChartTask>();
  const order: string[] = [];
  // Every id met so far, canceled or not: a repeated id keeps its first row, even when that
  // row is canceled and so left out.
  const met = new Set<string>();
  for (const group of groups) {
    if (group.archived) continue;
    for (const { doc } of group.rows) {
      const { id, title, status } = doc.meta;
      if (met.has(id)) continue;
      met.add(id);
      if (isCanceledStatus(status, model)) continue;
      tasks.set(id, {
        id,
        title,
        status,
        doc,
        milestoneId: group.epicId,
        milestoneTitle: group.label,
        state: chartStateOf(doc, ctx.bucketOf(doc), model),
      });
      order.push(id);
    }
  }

  const edges: [string, string][] = [];
  const blockersOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  const hiddenBlockersOf = new Map<string, string[]>();
  for (const id of order) dependentsOf.set(id, []);
  for (const task of tasks.values()) {
    const blockers: string[] = [];
    const hidden: string[] = [];
    const seen = new Set<string>();
    for (const blocker of task.doc.meta.blockedBy) {
      if (blocker === task.id || seen.has(blocker)) continue;
      seen.add(blocker);
      if (!tasks.has(blocker)) {
        hidden.push(blocker);
        continue;
      }
      blockers.push(blocker);
      dependentsOf.get(blocker)?.push(task.id);
      edges.push([blocker, task.id]);
    }
    blockersOf.set(task.id, blockers);
    if (hidden.length > 0) hiddenBlockersOf.set(task.id, hidden);
  }

  // Built in model order so iterating it walks tasks the way the layout does.
  const linked = new Set(
    order.filter(
      (id) =>
        (blockersOf.get(id) ?? []).length > 0 ||
        (dependentsOf.get(id) ?? []).length > 0
    )
  );
  const rows = [...tasks.values()];
  const inStates = (states: readonly ChartState[]) =>
    rows.filter((t) => states.includes(t.state)).map((t) => t.id);
  const isOpen = (id: string) => tasks.get(id)?.state !== 'landed';

  return {
    tasks,
    order,
    edges,
    blockersOf,
    dependentsOf,
    hiddenBlockersOf,
    linked,
    unlinkedOpen: order.filter((id) => !linked.has(id) && isOpen(id)),
    longestChain: longestOpenChain(order, blockersOf, dependentsOf, isOpen),
    readyNow: inStates(['ready']),
    inProgress: inStates(['working', 'review', 'landing']),
    needsYou: inStates(['need-you', 'failed']),
    milestonePairs: milestoneWaits(groups, model),
  };
}

/**
 * Everything transitively upstream ('up', via blockersOf) or downstream ('down', via
 * dependentsOf) of `id`, nearest first; `id` itself only when a cycle leads back to it. A
 * breadth-first walk with a visited set, so it is iterative and stops on cycles.
 */
export function traceChart(
  model: ChartModel,
  id: string,
  dir: 'up' | 'down'
): Set<string> {
  const step = dir === 'up' ? model.blockersOf : model.dependentsOf;
  const reached = new Set<string>();
  const queue = [...(step.get(id) ?? [])];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    if (reached.has(at)) continue;
    reached.add(at);
    for (const near of step.get(at) ?? []) {
      if (!reached.has(near)) queue.push(near);
    }
  }
  return reached;
}

/**
 * The task ids the Tasks chart draws, in order: linked tasks, plus unlinkedOpen when
 * `showUnlinked` — or every task when nothing is linked at all, so a project without links
 * still shows its tasks — minus landed tasks when `hideLanded`.
 */
export function drawnTasks(
  model: ChartModel,
  opts: { hideLanded: boolean; showUnlinked: boolean }
): string[] {
  const unlinkedOpen = new Set(model.unlinkedOpen);
  const everything = model.linked.size === 0;
  return model.order.filter((id) => {
    if (opts.hideLanded && model.tasks.get(id)?.state === 'landed') {
      return false;
    }
    return (
      everything ||
      model.linked.has(id) ||
      (opts.showUnlinked && unlinkedOpen.has(id))
    );
  });
}
