import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  fanoutHolder,
  fanoutScope,
  fanoutWaitingOn,
  hasStatusRole,
  isContainerKind,
  isDoneStatus,
  isUnstartedStatus,
} from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';

import { dagTaskFromDoc, dagWaves } from '../../lib/dagLayout';
import { isTerminalRunState } from '../../lib/runState';

// The Flight Plan's model: where each child of a fanned-out container stands, and the
// waves they run in. The Cockpit's mini (wave bar, slots, running count) and the full
// Flight Plan on a container's page both read this, so the two can never disagree about
// which wave a fan-out is on.

/**
 * One child's state in the plan.
 * - `done`: landed or dropped — finished either way.
 * - `running`: an agent is on it now.
 * - `teammate`: another person's, in any unfinished state; the fan-out never starts it
 *   (the server's rule, core's `fanoutHolder`), though its dependents still wait on it.
 * - `review`: the agent is done and it waits in review or landing — its dependents may
 *   already start when it has a run branch to stack on (core's
 *   `releasesFanoutDependents`).
 * - `queued`: unstarted and unblocked — next when a slot frees.
 * - `blocked`: waiting on something: a blocker, a spec (backlog), a hand dispatch
 *   (critical risk), or a failed run — or never an agent's (a derived task).
 */
export type FlightNodeState =
  | 'done'
  | 'running'
  | 'teammate'
  | 'review'
  | 'queued'
  | 'blocked';

export interface FlightNode {
  task: TaskListItem;
  state: FlightNodeState;
  /** 0-based wave (`dagWaves`). */
  wave: number;
  /** Ids of this child's blockers that still hold its dispatch, in the container or out
   * of it (`FlightPlanOptions.lookup`) — core's `fanoutWaitingOn`, the server's rule. */
  waitingOn: string[];
  /** The child is itself a container: it fans out on its own plan, never this one's. */
  subPlan: boolean;
  /** The container whose fan-out would start it (`FlightPlanOptions.ownerOf`). */
  owner: string | null;
  /** The teammate it belongs to, when it is someone else's; else null. */
  holder: string | null;
}

/** One wave's tally, for the bar. */
interface FlightWave {
  /** 0-based. */
  index: number;
  total: number;
  done: number;
  running: number;
}

export interface FlightPlan {
  nodes: FlightNode[];
  waves: FlightWave[];
  /** The 0-based wave being worked: the first with anything unfinished; null once all is. */
  currentWave: number | null;
  total: number;
  done: number;
  running: number;
  queued: number;
  /** Agent slots: runs in use against the session's concurrency (null = no session). */
  slots: { used: number; total: number | null };
}

export interface FlightPlanOptions {
  /** Task ids with a live run. */
  liveTaskIds: ReadonlySet<string>;
  model: StatusModel;
  /** The fan-out session's concurrency, or null when nothing is fanning out. */
  concurrency: number | null;
  /** Ids that are containers themselves (`parentIdsOf`); omitted treats none as one. */
  containerIds?: ReadonlySet<string>;
  /** Precomputed waves for `children` — the full view keeps them with its layout. */
  waves?: ReadonlyMap<string, number>;
  /** This window's own ref: who a fan-out not yet started would work for. Null until
   * known, when every named person reads as a teammate rather than promise a start. */
  me?: string | null;
  /** The daemon's own human, whom the legacy bare `human` means (the server's rule).
   * Null or omitted: `me`. */
  local?: string | null;
  /** The container whose fan-out would start `task`: the nearest one with a live
   * session (the server's rule). Omitted: its parent. */
  ownerOf?: (task: TaskListItem) => string | null;
  /** Who started `owner`'s live fan-out, whose tasks it may start. Null or omitted: `me`. */
  startedByOf?: (owner: string) => string | null | undefined;
  /** Tasks with a run branch a dependent can stack on (`tasksWithRunBranch`); a blocker in
   * review without one holds its dependents until done. Omitted: none. */
  withRunBranch?: ReadonlySet<string>;
  /** Blockers outside `children`, archived ones included: an unfinished one holds its
   * dependent as on the server, though never a wave. Omitted: none are known. */
  lookup?: (id: string) => TaskListItem | undefined;
}

const NONE: ReadonlySet<string> = new Set();

/** The teammate a task belongs to as this window sees it, else null: core's
 * `fanoutHolder` against `me` rather than a fan-out's starter. Hand dispatch reads this. */
export function viewerHolderOf(
  me: string | null,
  local: string | null
): (task: TaskListItem) => string | null {
  // Bare `human` stays itself while nobody is known, so it is never a teammate.
  const localHuman = local ?? me ?? 'human';
  const viewer = me ?? localHuman;
  return (task) => fanoutHolder(task.meta.assignee, viewer, localHuman);
}

/** What a live fan-out session covers (the server's rule): its container's `fanoutScope`,
 * or only the direct children of a session from before plan-wide fan-outs. */
export function sessionScope(
  epicId: string,
  scope: 'plan' | 'direct' | undefined,
  childrenOf: (id: string) => readonly TaskListItem[]
): TaskListItem[] {
  return scope === 'direct'
    ? childrenOf(epicId).filter((t) => !isContainerKind(t.meta.kind))
    : fanoutScope(epicId, childrenOf);
}

/** Tasks whose work sits on a Dispatch run branch a dependent can stack on: a terminal,
 * unreviewed run (the server's rule). */
export function tasksWithRunBranch(runs: readonly RunMeta[]): Set<string> {
  const out = new Set<string>();
  for (const run of runs) {
    if (isTerminalRunState(run.state) && run.reviewedAt === undefined) {
      out.add(run.taskId);
    }
  }
  return out;
}

// One child's state, first match wins: finished, a live run, a teammate's hands, the
// review/landing roles, then the unstarted ready/blocked split.
function stateOf(
  task: TaskListItem,
  waitingOn: readonly string[],
  subPlan: boolean,
  live: boolean,
  holder: string | null,
  model: StatusModel
): FlightNodeState {
  const status = task.meta.status;
  if (isDoneStatus(status, model)) return 'done';
  if (live) return 'running';
  if (holder !== null) return 'teammate';
  if (
    hasStatusRole(status, 'review', model) ||
    hasStatusRole(status, 'landing', model)
  ) {
    return 'review';
  }
  if (
    !subPlan &&
    waitingOn.length === 0 &&
    task.meta.risk !== 'critical' &&
    task.meta.derivedFrom === undefined &&
    isUnstartedStatus(status, model)
  ) {
    return 'queued';
  }
  return 'blocked';
}

/**
 * Where every child of a container stands, and the waves they form. Blockers outside
 * `children` never hold a wave (they are the container's inputs, not its plan), though
 * an unfinished one still holds its dependent.
 */
export function buildFlightPlan(
  children: readonly TaskListItem[],
  {
    liveTaskIds,
    model,
    concurrency,
    containerIds,
    waves: knownWaves,
    me = null,
    local = null,
    ownerOf,
    startedByOf,
    withRunBranch = NONE,
    lookup,
  }: FlightPlanOptions
): FlightPlan {
  const waveOf = knownWaves ?? dagWaves(children.map(dagTaskFromDoc));
  const byId = new Map(children.map((c) => [c.meta.id, c]));
  // Bare `human` stays itself while nobody is known, so it is never a teammate.
  const localHuman = local ?? me ?? 'human';
  const viewer = me ?? localHuman;
  const nodes: FlightNode[] = children.map((task) => {
    const id = task.meta.id;
    const subPlan = containerIds?.has(id) ?? false;
    const owner = ownerOf === undefined ? task.meta.parent : ownerOf(task);
    const starter = owner === null ? null : (startedByOf?.(owner) ?? null);
    const holderOf = (t: TaskListItem) =>
      fanoutHolder(t.meta.assignee, starter ?? viewer, localHuman);
    const holder = holderOf(task);
    const waitingOn = fanoutWaitingOn(
      task,
      (blocker) =>
        blocker === id ? undefined : (byId.get(blocker) ?? lookup?.(blocker)),
      model,
      (b) => ({
        held: holderOf(b) !== null,
        hasRunBranch: withRunBranch.has(b.meta.id),
      })
    );
    return {
      task,
      state: stateOf(
        task,
        waitingOn,
        subPlan,
        liveTaskIds.has(id),
        holder,
        model
      ),
      wave: waveOf.get(id) ?? 0,
      waitingOn,
      subPlan,
      owner,
      holder,
    };
  });

  const waveCount = nodes.reduce((max, n) => Math.max(max, n.wave + 1), 0);
  const waves: FlightWave[] = Array.from({ length: waveCount }, (_, index) => ({
    index,
    total: 0,
    done: 0,
    running: 0,
  }));
  let done = 0;
  let running = 0;
  let queued = 0;
  for (const node of nodes) {
    const wave = waves[node.wave];
    if (wave === undefined) continue;
    wave.total++;
    if (node.state === 'done') {
      wave.done++;
      done++;
    } else if (node.state === 'running') {
      wave.running++;
      running++;
    } else if (node.state === 'queued') {
      queued++;
    }
  }
  const current = waves.find((w) => w.done < w.total);
  return {
    nodes,
    waves,
    currentWave: current === undefined ? null : current.index,
    total: nodes.length,
    done,
    running,
    queued,
    slots: { used: running, total: concurrency },
  };
}
