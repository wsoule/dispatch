import type { GraphEdgeData, GraphNodeData } from '@dispatch/ui';
import { layoutGraph } from '@dispatch/ui';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  cachedLayoutGraph,
  clearLayoutCache,
  LAYOUT_CACHE_SIZE,
} from './graphLayoutCache';

// The graph's layout cache: the same drawing is laid out once and reused
// (the task drawer opening and closing, a highlight switch); any change to
// a box or an edge is laid out afresh.

const NODES: GraphNodeData[] = [
  {
    id: 'a',
    label: 'Schema rollout',
    sublabel: 'DATA-45 · Iris',
    tone: 'default',
    status: 'open',
  },
  {
    id: 'b',
    label: 'Report builder',
    sublabel: 'DATA-75 · Kai',
    tone: 'warning',
    status: 'open',
  },
  {
    id: 'c',
    label: 'Go / no-go',
    sublabel: 'GRO-40 · Uma',
    tone: 'default',
    status: 'open',
  },
];
const EDGES: GraphEdgeData[] = [
  { from: 'a', to: 'b', kind: 'default' },
  { from: 'b', to: 'c', kind: 'risk', weight: 2 },
];

afterEach(() => {
  clearLayoutCache();
});

describe('cachedLayoutGraph', () => {
  test('is layoutGraph, and the same input reuses the same layout', () => {
    const first = cachedLayoutGraph(NODES, EDGES, { direction: 'LR' });
    expect(first).toEqual(layoutGraph(NODES, EDGES, { direction: 'LR' }));
    // An equal input built afresh (a new render) is a hit.
    const again = cachedLayoutGraph(
      NODES.map((n) => ({ ...n })),
      EDGES.map((e) => ({ ...e })),
      { direction: 'LR' }
    );
    expect(again).toBe(first);
  });

  test('a changed box, edge or option is laid out afresh', () => {
    const first = cachedLayoutGraph(NODES, EDGES, { direction: 'LR' });
    const renamed = cachedLayoutGraph(
      NODES.map((n) =>
        n.id === 'a' ? { ...n, label: 'Schema rollout, the overdue one' } : n
      ),
      EDGES,
      { direction: 'LR' }
    );
    expect(renamed).not.toBe(first);
    expect(
      renamed.nodes.find((n) => n.id === 'a')?.labelLines.join(' ')
    ).toContain('overdue');
    const rekinded = cachedLayoutGraph(
      NODES,
      EDGES.map((e) => ({ ...e, kind: 'cycle' as const })),
      { direction: 'LR' }
    );
    expect(rekinded).not.toBe(first);
    expect(rekinded.edges.every((e) => e.kind === 'cycle')).toBe(true);
    expect(cachedLayoutGraph(NODES, EDGES, { direction: 'TB' })).not.toBe(
      first
    );
    // A tag changed (the Dispatch overlay adding "Needs you") is another
    // drawing too: the chip changes the box's width.
    expect(
      cachedLayoutGraph(
        NODES.map((n) => (n.id === 'b' ? { ...n, tags: ['Needs you'] } : n)),
        EDGES,
        { direction: 'LR' }
      )
    ).not.toBe(first);
    // The first input is still kept.
    expect(cachedLayoutGraph(NODES, EDGES, { direction: 'LR' })).toBe(first);
  });

  // Every scope but a chain is laid out in frames (`clusters`, the page's
  // projects and milestones): the frames are part of the input, so a frame
  // renamed, re-nested, muted or a box moved to another frame is laid out
  // afresh, and the same frames rebuilt for a new render are a hit.
  test('frames are part of the key', () => {
    const framed = NODES.map((n) => ({
      ...n,
      cluster: n.id === 'c' ? 'p2' : 'p1',
    }));
    const clusters = [
      { id: 'p1', label: 'Atlas billing migration' },
      { id: 'p2', label: 'Harbor API v3' },
    ];
    const first = cachedLayoutGraph(framed, EDGES, {
      direction: 'LR',
      clusters,
    });
    expect(first.clustered).toBe(true);
    expect(first.groups.map((g) => g.id)).toEqual(['p1', 'p2']);
    expect(
      cachedLayoutGraph(
        framed.map((n) => ({ ...n })),
        EDGES.map((e) => ({ ...e })),
        { direction: 'LR', clusters: clusters.map((c) => ({ ...c })) }
      )
    ).toBe(first);
    const variants = [
      // A frame renamed (its title sets the frame's width).
      clusters.map((c) =>
        c.id === 'p2' ? { ...c, label: 'Harbor API v3, the long name' } : c
      ),
      // One frame nested in the other.
      clusters.map((c) => (c.id === 'p2' ? { ...c, parent: 'p1' } : c)),
      // A paused project's dashed frame.
      clusters.map((c) => (c.id === 'p2' ? { ...c, muted: true } : c)),
    ];
    for (const changed of variants) {
      const layout = cachedLayoutGraph(framed, EDGES, {
        direction: 'LR',
        clusters: changed,
      });
      expect(layout).not.toBe(first);
      expect(layout).toEqual(
        layoutGraph(framed, EDGES, { direction: 'LR', clusters: changed })
      );
    }
    // A box moved to the other frame.
    const moved = cachedLayoutGraph(
      framed.map((n) => (n.id === 'b' ? { ...n, cluster: 'p2' } : n)),
      EDGES,
      { direction: 'LR', clusters }
    );
    expect(moved).not.toBe(first);
    // Without frames at all (a chain) is another drawing too.
    expect(cachedLayoutGraph(framed, EDGES, { direction: 'LR' })).not.toBe(
      first
    );
  });

  test('keeps only the most recently used layouts', () => {
    expect(LAYOUT_CACHE_SIZE).toBe(24);
    const first = cachedLayoutGraph(NODES, EDGES);
    for (let i = 0; i < LAYOUT_CACHE_SIZE; i += 1) {
      cachedLayoutGraph(
        NODES.map((n) => ({ ...n, label: `${n.label} ${i}` })),
        EDGES
      );
    }
    // The oldest went to make room.
    expect(cachedLayoutGraph(NODES, EDGES)).not.toBe(first);
  });

  test('a use refreshes a layout’s place, so the one in use is kept', () => {
    const first = cachedLayoutGraph(NODES, EDGES);
    for (let i = 0; i < LAYOUT_CACHE_SIZE - 1; i += 1) {
      cachedLayoutGraph(
        NODES.map((n) => ({ ...n, label: `${n.label} ${i}` })),
        EDGES
      );
    }
    // Used again just before the cache fills: the oldest other goes instead.
    expect(cachedLayoutGraph(NODES, EDGES)).toBe(first);
    cachedLayoutGraph(
      NODES.map((n) => ({ ...n, label: `${n.label} last` })),
      EDGES
    );
    expect(cachedLayoutGraph(NODES, EDGES)).toBe(first);
    // clearLayoutCache forgets everything.
    clearLayoutCache();
    expect(cachedLayoutGraph(NODES, EDGES)).not.toBe(first);
  });
});
