import { edgeKey } from './layout';
import type { GraphEdgeData, UpstreamChain } from './types';

// "What is this waiting on, and what does it hold up?": the transitive
// blockers of a node (upstream) and the nodes that transitively wait on it
// (downstream), for the hover/focus highlight and a host's "Waits on" and
// "Holds up" lists. Pure and cycle-safe; the index is built once per edge
// list, and each walk visits every node and edge at most once.

/** The transitive waiters of one node: the same shape as UpstreamChain. */
export type DownstreamChain = UpstreamChain;

/** Edges grouped by the node that waits on them (`to`). */
export type BlockerIndex = ReadonlyMap<string, readonly GraphEdgeData[]>;

export interface BlockerIndexOptions {
  /**
   * Walk through resolved edges too. Off by default: a closed blocker no
   * longer holds anything up, so it is not part of the chain.
   */
  includeResolved?: boolean;
}

/** Indexes `edges` by waiting node so a walk never rescans the list. */
export function blockerIndex(
  edges: readonly GraphEdgeData[],
  options: BlockerIndexOptions = {}
): BlockerIndex {
  const index = new Map<string, GraphEdgeData[]>();
  for (const edge of edges) {
    if (edge.kind === 'resolved' && options.includeResolved !== true) continue;
    const list = index.get(edge.to);
    if (list === undefined) index.set(edge.to, [edge]);
    else list.push(edge);
  }
  return index;
}

/** Edges grouped by blocker (`from`): what each node holds up. */
export function waiterIndex(
  edges: readonly GraphEdgeData[],
  options: BlockerIndexOptions = {}
): BlockerIndex {
  const index = new Map<string, GraphEdgeData[]>();
  for (const edge of edges) {
    if (edge.kind === 'resolved' && options.includeResolved !== true) continue;
    const list = index.get(edge.from);
    if (list === undefined) index.set(edge.from, [edge]);
    else list.push(edge);
  }
  return index;
}

/**
 * Breadth-first walk from `id` over `index`, stepping to each edge's `end`
 * (`from` walks upstream, `to` downstream). Returns the nodes reached,
 * nearest first and never `id` itself (even when a cycle leads back to
 * it), with the keys of every edge walked.
 */
function walk(
  id: string,
  index: BlockerIndex,
  end: 'from' | 'to'
): UpstreamChain {
  const nodeIds: string[] = [];
  const edgeKeys = new Set<string>();
  const visited = new Set<string>([id]);
  const queue: string[] = [id];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const edge of index.get(current) ?? []) {
      edgeKeys.add(edgeKey(edge.from, edge.to));
      const next = edge[end];
      if (visited.has(next)) continue;
      visited.add(next);
      nodeIds.push(next);
      queue.push(next);
    }
  }
  return { id, nodeIds, edgeKeys };
}

/**
 * Breadth-first walk from `id` against the edge direction: its blockers,
 * their blockers, and so on. Returns them nearest first (never `id`
 * itself, even when a cycle leads back to it) with the keys of every edge
 * walked, so a renderer can light exactly that sub-graph.
 */
export function upstreamChain(id: string, index: BlockerIndex): UpstreamChain {
  return walk(id, index, 'from');
}

/**
 * Breadth-first walk from `id` along the edge direction, over a
 * `waiterIndex`: what it holds up, what those hold up, and so on. Nearest
 * first, cycle-safe and never `id` itself, like upstreamChain; resolved
 * edges are skipped when the index was built without them (the default).
 */
export function downstreamChain(
  id: string,
  index: BlockerIndex
): DownstreamChain {
  return walk(id, index, 'to');
}
