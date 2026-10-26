import type {
  GraphEdgeData,
  GraphLayout,
  GraphLayoutOptions,
  GraphNodeData,
} from '@dispatch/ui';
import { layoutGraph } from '@dispatch/ui';

// The Graph destination lays its drawing out in the renderer, and the framed
// dagre layout is the costliest step of building the page model: most of the
// cold buildGraphPage time at the draw limits. The same drawing is asked for
// again and again: opening or closing the task drawer re-renders the view
// with the boxes unchanged, and switching the highlight never moves a box.
// layoutGraph is a pure function of its input (no DOM, no clock, no
// randomness), so the last few layouts are kept by that exact input: any
// change to a box (its text, tone, tags, cluster) or to an edge (kind,
// weight) is a different key and is laid out afresh, so a stale layout is
// never served. Ported from the planner's lib/adapters/graph-layout-cache.ts
// (Better-Tracker), where the server kept it between requests.

/** Layouts kept, most recently used last; the oldest goes first. */
export const LAYOUT_CACHE_SIZE = 24;

const cache = new Map<string, GraphLayout>();

/**
 * layoutGraph(nodes, edges, options), reusing the layout of an identical
 * earlier call. The returned layout is shared between callers: hand it to
 * the graph as is and never change it.
 */
export function cachedLayoutGraph(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  options: GraphLayoutOptions = {}
): GraphLayout {
  const key = JSON.stringify([nodes, edges, options]);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh its place so the layouts in use are the last to go.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const layout = layoutGraph(nodes, edges, options);
  cache.set(key, layout);
  while (cache.size > LAYOUT_CACHE_SIZE) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return layout;
}

/** Empties the cache (tests, and a timing run that wants a cold layout). */
export function clearLayoutCache(): void {
  cache.clear();
}
