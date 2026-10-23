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

/**
 * Every task wait between two milestones, as [blocker, blocked] pairs keyed
 * `${from}\u0000${to}`: each non-canceled row of a non-archived milestone group, and each of
 * its blockedBy entries whose blocker is a non-canceled row of a different milestone (a
 * repeated entry counts twice). Canceled work blocks nothing (the board's blocked rule and the
 * Tasks chart drop it too), so it never draws a line. `milestoneMap` counts these and the
 * dependency chart lists them behind each line, so the two always agree.
 */
export function milestoneWaits(
  groups: readonly ListGroup[],
  model: StatusModel = activeStatusModel()
): Map<string, [string, string][]> {
  const milestoneOf = new Map<string, string>();
  const live: [string, TaskListItem][] = [];
  for (const group of groups) {
    if (group.epicId === null || group.archived) continue;
    for (const { doc } of group.rows) {
      if (isCanceledStatus(doc.meta.status, model)) continue;
      milestoneOf.set(doc.meta.id, group.epicId);
      live.push([group.epicId, doc]);
    }
  }
  const pairs = new Map<string, [string, string][]>();
  for (const [to, doc] of live) {
    for (const blocker of doc.meta.blockedBy) {
      const from = milestoneOf.get(blocker);
      if (from === undefined || from === to) continue;
      const key = `${from}\u0000${to}`;
      const list = pairs.get(key);
      if (list === undefined) pairs.set(key, [[blocker, doc.meta.id]]);
      else list.push([blocker, doc.meta.id]);
    }
  }
  return pairs;
}

/** The milestone map from the list's milestone groups; loose tasks are not nodes, and
 * waits on or from canceled tasks are not counted (see `milestoneWaits`). */
export function milestoneMap(
  groups: readonly ListGroup[],
  ctx: { model?: StatusModel } = {}
): MilestoneMap {
  const childrenOf = new Map<string, TaskListItem[]>();
  for (const group of groups) {
    if (group.epicId === null || group.archived) continue;
    childrenOf.set(
      group.epicId,
      group.rows.map((row) => row.doc)
    );
  }

  // Counted per blocking task, so "3" means three waits cross the line.
  const counts = new Map<string, number>();
  for (const [key, pairs] of milestoneWaits(groups, ctx.model)) {
    counts.set(key, pairs.length);
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
