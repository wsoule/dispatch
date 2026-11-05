import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { edgeKey } from './criticalPath';
import { FlightCanvas, type FlightEdgeView } from './FlightCanvas';
import styles from './FlightCanvas.module.css';
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

// The declarations of FlightCanvas.module.css's `.edges` rule, comments dropped.
function edgesRule(): string {
  const css = readFileSync(
    join(import.meta.dir, 'FlightCanvas.module.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('\n.edges {');
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
}

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
    // bun loads a CSS module as an empty map (every class undefined), so the rendered
    // class alone proves nothing: the source must put `.edges` on the <svg>, the sheet's
    // `.edges` must hold the layer, and the rendered class is what the module names.
    const source = readFileSync(
      join(import.meta.dir, 'FlightCanvas.tsx'),
      'utf8'
    );
    expect(source).toMatch(/<svg\b[^<]*className=\{styles\.edges\}/);
    expect(edgesRule()).toContain('will-change: transform');
    expect(drawn(null).edgeLayer?.getAttribute('class') ?? '').toBe(
      styles.edges ?? ''
    );
  });

  test('a window draws only what reaches into it, and always the focused node', () => {
    const near = drawn({ x0: 0, y0: 0, x1: 1200, y1: 900 }, 'n-39-9');
    expect(near.nodes.length).toBeLessThan(100);
    expect(near.nodes).toContain('n-0-0');
    expect(near.nodes).toContain('n-39-9');
    expect(near.edges).toBeLessThan(100);
  });
});

describe('FlightCanvas edges', () => {
  test('each edge carries its EdgeTone on data-edge and a status tone only when toned', () => {
    const tones = ['idle', 'active', 'flowing', 'satisfied', 'landed'] as const;
    const toned: FlightEdgeView[] = tones.map((tone, i) => ({
      key: `edge-${tone}`,
      d: `M0 ${i * 10} L100 ${i * 10}`,
      tone,
      critical: i === 0,
    }));
    const { container } = render(
      <FlightCanvas
        layout={layout}
        nodes={[]}
        edges={toned}
        waves={[]}
        bands={null}
        focusedId={null}
        onActivate={() => {}}
      />
    );
    expect(
      Array.from(
        container.querySelectorAll('[data-slot=flight-edge]'),
        (path) => [
          path.getAttribute('data-edge'),
          path.getAttribute('data-tone'),
        ]
      )
    ).toEqual([
      ['idle', null],
      ['active', 'info'],
      ['flowing', 'info'],
      ['satisfied', 'success'],
      ['landed', null],
    ]);
    // The critical path's highlighter is drawn first, under the edges.
    const paths = container.querySelectorAll('path');
    expect(paths[0]?.getAttribute('data-slot')).toBe('flight-critical');
    expect(paths).toHaveLength(6);
  });

  test('the current wave says Now in the in-progress tone', () => {
    const { container } = render(
      <FlightCanvas
        layout={layout}
        nodes={[]}
        edges={[]}
        waves={[
          {
            wave: 0,
            x: 0,
            width: 240,
            total: 4,
            done: 4,
            running: 0,
            current: false,
          },
          {
            wave: 1,
            x: 280,
            width: 240,
            total: 3,
            done: 1,
            running: 1,
            current: true,
          },
        ]}
        bands={null}
        focusedId={null}
        onActivate={() => {}}
      />
    );
    const heads = container.querySelectorAll('[data-slot=flight-wave-head]');
    expect(Array.from(heads, (head) => head.textContent)).toEqual([
      'Wave 14/4',
      'Wave 21/3Now',
    ]);
    const now = heads[1]?.querySelector('.toneText');
    expect(now?.getAttribute('data-tone')).toBe('info');
    expect(now?.textContent).toBe('Now');
  });
});
