import type { TaskListItem } from '@dispatch-foo/core/browser';

import type { DagTask } from './dagLayout';
import type { ListGroup } from './listGrouping';

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
