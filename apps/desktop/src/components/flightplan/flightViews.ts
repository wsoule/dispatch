import type { StatusModel } from '@dispatch-foo/core/browser';
import {
  claimConflictsWithWrites,
  PRIORITY_ORDER,
} from '@dispatch-foo/core/browser';
import type {
  EpicProgressChild,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';

import { assigneeRef } from '../../lib/taskDisplay';
import { type CriticalPath, edgeKey } from './criticalPath';
import type { EdgeTone, FlightEdgeView, FlightWaveView } from './FlightCanvas';
import type { FlightLayout } from './flightLayout';
import type { FlightNodeView } from './FlightNodeCard';
import type { FlightNode, FlightNodeState, FlightPlan } from './flightPlan';
import { nodeSentence } from './flightSentences';

// Turns the plan (states), the layout (positions) and the critical path into the flat,
// primitive-only views the canvas draws, so each memoized card and edge re-renders only
// when its own values move.

/** A queued node's place in its session's fill order, and the slots free right now. */
export interface QueueSlot {
  position: number;
  free: number;
}

/**
 * Each queued node's place in line under the fan-out session that owns it (`node.owner`),
 * in the server's fill order (priority, then age). `concurrencyOf` answers for an owner
 * with an active session and null otherwise; queued nodes under no active session get no
 * place, and a teammate's node is never queued.
 */
export function queuePositions(
  nodes: readonly FlightNode[],
  concurrencyOf: (ownerId: string) => number | null
): Map<string, QueueSlot> {
  const byOwner = new Map<string, FlightNode[]>();
  for (const node of nodes) {
    if (node.owner === null) continue;
    const bucket = byOwner.get(node.owner);
    if (bucket === undefined) byOwner.set(node.owner, [node]);
    else bucket.push(node);
  }
  const out = new Map<string, QueueSlot>();
  for (const [owner, group] of byOwner) {
    const concurrency = concurrencyOf(owner);
    if (concurrency === null) continue;
    const running = group.filter((n) => n.state === 'running').length;
    const free = Math.max(0, concurrency - running);
    const queued = group
      .filter((n) => n.state === 'queued')
      .sort(
        (a, b) =>
          PRIORITY_ORDER[a.task.meta.priority] -
            PRIORITY_ORDER[b.task.meta.priority] ||
          a.task.meta.created.localeCompare(b.task.meta.created)
      );
    queued.forEach((n, position) =>
      out.set(n.task.meta.id, { position, free })
    );
  }
  return out;
}

export interface NodeViewContext {
  model: StatusModel;
  refFor: (id: string) => string;
  latestRunByTaskId: ReadonlyMap<string, RunMeta>;
  /** Task ids with a live run the caches have seen. */
  live: ReadonlySet<string>;
  /** Dispatches sent from here whose run has not shown up yet, by task id → when sent. */
  pending: ReadonlyMap<string, number>;
  /** Whether a node's owning fan-out (`node.owner`) is filling slots right now. */
  sessionActive: (ownerId: string) => boolean;
  /** The server's reading of a node inside its parent's fan-out. */
  phaseOf: (taskId: string) => EpicProgressChild | undefined;
  /** Live runs' claimed files, for spotting a queued node parked behind one. */
  liveClaims: readonly { taskId: string; claims: string[] }[];
  /** Tasks whose run is in the merge queue, with the entry's state. */
  landingByTaskId: ReadonlyMap<string, MergeQueueEntryState>;
  personName: (assignee: string) => string | null;
}

// A person, never an agent, shows in a card's corner.
function ownerOf(assignee: string): string | null {
  return assigneeRef(assignee)?.kind === 'human' ? assignee : null;
}

/** The cards to draw, in plan order. */
export function flightNodeViews(
  plan: FlightPlan,
  layout: FlightLayout,
  path: CriticalPath,
  queue: ReadonlyMap<string, QueueSlot>,
  ctx: NodeViewContext
): FlightNodeView[] {
  const critical = new Set(path.ids);
  const out: FlightNodeView[] = [];
  for (const node of plan.nodes) {
    const meta = node.task.meta;
    const box = layout.boxes.get(meta.id);
    if (box === undefined) continue;
    const run = ctx.latestRunByTaskId.get(meta.id);
    // A dispatch still on its way has no run of its own yet — an older one is not it.
    const pendingAt = ctx.live.has(meta.id)
      ? undefined
      : ctx.pending.get(meta.id);
    const liveRun = pendingAt === undefined ? run : undefined;
    const sessionActive = node.owner !== null && ctx.sessionActive(node.owner);
    const slot = queue.get(meta.id) ?? null;
    let parkedBehind: string | null = null;
    if (
      sessionActive &&
      node.state === 'queued' &&
      slot !== null &&
      slot.position < slot.free
    ) {
      parkedBehind =
        ctx.liveClaims.find((c) =>
          claimConflictsWithWrites(c.claims, meta.writes)
        )?.taskId ?? null;
    }
    const sentence = nodeSentence({
      node,
      refFor: ctx.refFor,
      sessionActive,
      queue: slot,
      parkedBehind,
      run: node.state === 'running' ? liveRun : run,
      phase: ctx.phaseOf(meta.id),
      personName: ctx.personName(node.holder ?? meta.assignee),
      model: ctx.model,
    });
    const running = node.state === 'running';
    out.push({
      id: meta.id,
      refLabel: ctx.refFor(meta.id),
      title: meta.title,
      state: node.state,
      glyphStatus: meta.status,
      sentence: sentence.text,
      tone: sentence.tone,
      owner: node.holder ?? ownerOf(meta.assignee),
      startedAt: running
        ? (pendingAt ??
          (liveRun === undefined ? null : Date.parse(liveRun.createdAt)))
        : null,
      runId: running ? (liveRun?.id ?? null) : null,
      costUsd:
        (running || node.state === 'done' || node.state === 'review') &&
        run?.costUsd !== undefined
          ? run.costUsd
          : null,
      landing: ctx.landingByTaskId.get(meta.id) ?? null,
      critical: critical.has(meta.id),
      x: box.x,
      y: box.y,
    });
  }
  return out;
}

const EDGE_TONE: Record<FlightNodeState, EdgeTone> = {
  done: 'landed',
  review: 'satisfied',
  running: 'flowing',
  teammate: 'active',
  queued: 'idle',
  blocked: 'idle',
};

/** The edges to draw, each toned by its blocker's state. */
export function flightEdgeViews(
  plan: FlightPlan,
  layout: FlightLayout,
  path: CriticalPath
): FlightEdgeView[] {
  const stateOf = new Map(plan.nodes.map((n) => [n.task.meta.id, n.state]));
  return layout.edges.map((edge) => {
    const key = edgeKey(edge.from, edge.to);
    return {
      key,
      d: edge.d,
      tone: EDGE_TONE[stateOf.get(edge.from) ?? 'blocked'],
      critical: path.edges.has(key),
    };
  });
}

/** One head per wave column, with its tally. */
export function flightWaveViews(
  plan: FlightPlan,
  layout: FlightLayout
): FlightWaveView[] {
  return layout.columns.map((column) => {
    const wave = plan.waves[column.wave];
    return {
      wave: column.wave,
      x: column.x,
      width: column.width,
      total: wave?.total ?? 0,
      done: wave?.done ?? 0,
      running: wave?.running ?? 0,
      current: plan.currentWave === column.wave,
    };
  });
}
