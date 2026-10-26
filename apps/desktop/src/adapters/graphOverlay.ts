import type { RunMeta, RunState } from '@dispatch/client';
import type { GraphNodeData, GraphNodeTone } from '@dispatch/ui';

import { isTerminalRunState } from '../lib/runState';
import type { TaskBucket } from '../lib/taskStatus';
import { bucketChip, liveRunWord } from './rows';

// The Dispatch overlay on the graph's issue boxes: what the Issues list says
// about a task beside its planning facts. The list's chips (rows.ts) and the
// graph's tags read one table (`bucketChip`, `liveRunWord`), so a task reads
// "Needs you" in both places, and never "Agent working" without a live run.
// A tag is a word (ui GraphNodeTag; an unknown word draws as a neutral
// chip), so the strong claims also hue the box: Failed edges it red, Needs
// you amber, Agent working blue, each only when it outranks the box's own
// tone (an overdue box stays red under Needs you) and never on a quiet one;
// Review, Landing and Blocked are words alone (the list draws them as dot
// pills, and Blocked is what the readiness chip already says).
// Readiness is Dispatch's too: `readiness.canStart` follows the ready set
// (`readyIds`, the tasks whose blockers are all done), so "start with" never
// points at a box the daemon would not start. Containers (initiatives,
// projects, milestones) are untouched: their boxes carry the planning facts
// alone. Pure over plain data; the view memoizes it over the page model.

export interface DispatchOverlayContext {
  /** An open task's one bucket (`itemBucket`); null for finished work. */
  bucketOf(taskId: string): TaskBucket | null;
  /** The tasks whose blockers are all done (`DispatchProjectData.readyIds`). */
  readyIds: ReadonlySet<string>;
  /** Each task's live (non-terminal) run state. */
  liveRunStateByTaskId?: ReadonlyMap<string, RunState>;
  /** Each task's latest run: a host without the live map above still says
   * "Agent working" over a latest run that has not finished. */
  latestRunByTaskId?: ReadonlyMap<string, RunMeta>;
  /** Whether a box is a task (not a container): the overlay applies to it. */
  isTaskNode(id: string): boolean;
}

/** How loud each tone is: an overlay tone replaces the box's own only when
 * it ranks higher, so a red overdue box is never turned amber. */
const TONE_RANK: Readonly<Partial<Record<GraphNodeTone, number>>> = {
  default: 0,
  info: 1,
  warning: 2,
  danger: 3,
};

/** The buckets whose chip also hues the box, in the chip's own tone. */
const BOX_TONE: Readonly<Partial<Record<TaskBucket, GraphNodeTone>>> = {
  'need-you': 'warning',
  failed: 'danger',
  working: 'info',
};

/** The box tone under a bucket: the bucket's hue when it outranks the
 * box's own; the planner's tone otherwise, and always on a quiet box. */
function overlayTone(
  own: GraphNodeTone,
  bucket: TaskBucket | null
): GraphNodeTone {
  const claimed = bucket === null ? undefined : BOX_TONE[bucket];
  if (own === 'muted' || claimed === undefined) return own;
  return (TONE_RANK[claimed] ?? 0) > (TONE_RANK[own] ?? 0) ? claimed : own;
}

/** A task's live run state: the live map's entry, else its latest run's
 * state while that run has not reached a terminal state. */
function liveStateOf(
  ctx: DispatchOverlayContext,
  taskId: string
): RunState | undefined {
  const live = ctx.liveRunStateByTaskId?.get(taskId);
  if (live !== undefined) return live;
  const latest = ctx.latestRunByTaskId?.get(taskId);
  if (latest === undefined || isTerminalRunState(latest.state)) {
    return undefined;
  }
  return latest.state;
}

/**
 * The page's nodes with the overlay applied to every task box: the bucket's
 * word and a live run's quiet word after the planning tags, the bucket's hue
 * on the box when it outranks the box's own, and `readiness.canStart` from
 * the ready set. A box that is not a task is returned as the same object.
 */
export function applyDispatchOverlay(
  nodes: readonly GraphNodeData[],
  ctx: DispatchOverlayContext
): GraphNodeData[] {
  return nodes.map((node) => {
    if (!ctx.isTaskNode(node.id)) return node;
    const live = liveStateOf(ctx, node.id);
    const bucket = ctx.bucketOf(node.id);
    const chip = bucketChip(bucket, live);
    const word = liveRunWord(live);
    const tags = [...(node.tags ?? [])];
    if (chip !== undefined) tags.push(chip.label);
    if (word !== undefined) tags.push(word);
    const out: GraphNodeData = {
      ...node,
      // No chip (a started task with no run): no claim on the box either.
      tone: chip === undefined ? node.tone : overlayTone(node.tone, bucket),
    };
    if (tags.length > 0) out.tags = tags;
    if (node.readiness !== undefined) {
      out.readiness = {
        ...node.readiness,
        canStart: ctx.readyIds.has(node.id),
      };
    }
    return out;
  });
}
