import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  isCanceledStatus,
  isCompletedStatus,
} from '@dispatch-foo/core/browser';

import type { DagTask } from './dagLayout';
import type { ListGroup } from './listGrouping';
import { activeStatusModel } from './statusModel';
import type { TaskBucket } from './taskStatus';

/** A milestone-to-milestone wait: tasks in `to` wait on `count` tasks in `from`. */
interface MilestoneEdge {
  from: string;
  to: string;
  count: number;
}

export interface MilestoneMap {
  /** One node per milestone, `blockedBy` naming the milestones it waits on. */
  nodes: DagTask[];
  edges: MilestoneEdge[];
  childrenOf: ReadonlyMap<string, TaskListItem[]>;
}

/** The milestone map from the list's milestone groups; loose tasks are not nodes. */
export function milestoneMap(groups: readonly ListGroup[]): MilestoneMap {
  const milestoneOf = new Map<string, string>();
  const childrenOf = new Map<string, TaskListItem[]>();
  for (const group of groups) {
    if (group.epicId === null || group.archived) continue;
    const children = group.rows.map((row) => row.doc);
    childrenOf.set(group.epicId, children);
    for (const doc of children) milestoneOf.set(doc.meta.id, group.epicId);
  }

  // Counted per blocking task, so "3" means three waits cross the line.
  const counts = new Map<string, number>();
  for (const [to, children] of childrenOf) {
    for (const doc of children) {
      for (const blocker of doc.meta.blockedBy) {
        const from = milestoneOf.get(blocker);
        if (from === undefined || from === to) continue;
        const key = `${from}\u0000${to}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const edges: MilestoneEdge[] = [...counts].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, count };
  });

  const nodes: DagTask[] = [];
  for (const group of groups) {
    if (group.epicId === null || group.archived) continue;
    const id = group.epicId;
    nodes.push({
      id,
      title: group.label,
      status: '',
      created: String(nodes.length).padStart(6, '0'),
      blockedBy: edges.filter((e) => e.to === id).map((e) => e.from),
    });
  }
  return { nodes, edges, childrenOf };
}

/** A milestone's tasks by where they stand, in the order its progress bar draws them. */
export interface MilestoneMix {
  landed: number;
  landing: number;
  review: number;
  working: number;
  needYou: number;
  failed: number;
  ready: number;
  /** Drafts, blocked tasks and anything else not yet startable. */
  waiting: number;
}

export const MIX_ORDER: readonly (keyof MilestoneMix)[] = [
  'landed',
  'landing',
  'review',
  'working',
  'needYou',
  'failed',
  'ready',
  'waiting',
];

// Open work most urgent first: what needs you, what broke, then what is moving.
const URGENCY: readonly (keyof MilestoneMix)[] = [
  'needYou',
  'failed',
  'working',
  'review',
  'landing',
  'ready',
  'waiting',
];

const MIX_OF: Record<TaskBucket, keyof MilestoneMix> = {
  'need-you': 'needYou',
  failed: 'failed',
  working: 'working',
  review: 'review',
  landing: 'landing',
  ready: 'ready',
  draft: 'waiting',
  blocked: 'waiting',
};

/**
 * A milestone's mix for the map's node body, its open tasks most urgent first (list order
 * within a state), and the first ready one as what to start next.
 */
export function milestoneMix(
  children: readonly TaskListItem[],
  ctx: {
    bucketOf: (doc: TaskListItem) => TaskBucket | null;
    model?: StatusModel;
  }
): { mix: MilestoneMix; open: TaskListItem[]; next: TaskListItem | null } {
  const model = ctx.model ?? activeStatusModel();
  const mix: MilestoneMix = {
    landed: 0,
    landing: 0,
    review: 0,
    working: 0,
    needYou: 0,
    failed: 0,
    ready: 0,
    waiting: 0,
  };
  const ranked: { doc: TaskListItem; rank: number }[] = [];
  for (const doc of children) {
    if (isCanceledStatus(doc.meta.status, model)) continue;
    if (isCompletedStatus(doc.meta.status, model)) {
      mix.landed++;
      continue;
    }
    const bucket = ctx.bucketOf(doc);
    const key = bucket === null ? 'waiting' : MIX_OF[bucket];
    mix[key]++;
    ranked.push({ doc, rank: URGENCY.indexOf(key) });
  }
  // Stable, so tasks in one state keep their list order.
  const open = ranked.sort((a, b) => a.rank - b.rank).map((r) => r.doc);
  const next = ranked.find((r) => URGENCY[r.rank] === 'ready')?.doc ?? null;
  return { mix, open, next };
}
