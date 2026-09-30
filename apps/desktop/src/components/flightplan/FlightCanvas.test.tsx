import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { edgeKey } from './criticalPath';
import { FlightCanvas, type FlightEdgeView } from './FlightCanvas';
import { flightLayout, type FlightLayoutInput } from './flightLayout';
import type { FlightNodeView } from './FlightNodeCard';

// 40 waves of 10: a plan several screens wide and tall.
const inputs: FlightLayoutInput[] = [];
for (let wave = 0; wave < 40; wave++) {
  for (let i = 0; i < 10; i++) {
    inputs.push({
      id: `n-${wave}-${i}`,
      created: `2026-09-01T00:00:${String(i).padStart(2, '0')}Z`,
      blockedBy: wave === 0 ? [] : [`n-${wave - 1}-${i}`],
      wave,
      band: null,
    });
  }
}
const layout = flightLayout(inputs, null);
const nodes: FlightNodeView[] = inputs.map((input) => {
  const box = layout.boxes.get(input.id);
  if (box === undefined) throw new Error(`no box for ${input.id}`);
  return {
    id: input.id,
    refLabel: input.id,
    title: input.id,
    state: 'blocked',
    glyphStatus: 'ready',
    sentence: 'waits',
    tone: 'muted',
    owner: null,
    startedAt: null,
    costUsd: null,
    critical: false,
    x: box.x,
    y: box.y,
  } as FlightNodeView;
});
const edges: FlightEdgeView[] = layout.edges.map((edge) => ({
  key: edgeKey(edge.from, edge.to),
  d: edge.d,
  tone: 'idle',
  critical: false,
}));

function drawn(
  cull: Parameters<typeof FlightCanvas>[0]['cull'],
  focusedId: string | null = null
) {
  const { container } = render(
    <FlightCanvas
      layout={layout}
      nodes={nodes}
      edges={edges}
      waves={[]}
      bands={null}
      focusedId={focusedId}
      onActivate={() => {}}
      cull={cull}
    />
  );
  return {
    nodes: Array.from(
      container.querySelectorAll('[data-slot=flight-node]'),
      (el) => el.getAttribute('data-node-id')
    ),
    edges: container.querySelectorAll('[data-slot=flight-edge]').length,
    edgeLayer: container
      .querySelector('[data-slot=flight-edge]')
      ?.closest('svg'),
  };
}

describe('FlightCanvas culling', () => {
  test('without a window every node and edge draws', () => {
    const all = drawn(null);
    expect(all.nodes).toHaveLength(400);
    expect(all.edges).toBe(390);
  });

  test('the edges are one compositing layer of their own', () => {
    // Cards culled in over the edges then never repaint the strokes (WebKit).
    expect(
      drawn(null).edgeLayer?.classList.contains('will-change-transform')
    ).toBe(true);
  });

  test('a window draws only what reaches into it, and always the focused node', () => {
    const near = drawn({ x0: 0, y0: 0, x1: 1200, y1: 900 }, 'n-39-9');
    expect(near.nodes.length).toBeLessThan(100);
    expect(near.nodes).toContain('n-0-0');
    expect(near.nodes).toContain('n-39-9');
    expect(near.edges).toBeLessThan(100);
  });
});
