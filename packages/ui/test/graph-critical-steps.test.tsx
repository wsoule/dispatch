import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { DependencyGraph } from '../src/graph/dependency-graph';
import type {
  DependencyGraphProps,
  GraphEdgeData,
  GraphLayout,
  GraphNodeData,
} from '../src/graph/types';

// Critical path on a big canvas: the path can run across the whole
// drawing, so switching to it (or arriving on it) brings step 1 into the
// frame unless a step already shows, and the step control (or [ and ])
// walks the path from step to step. The 2026-10-23 showcase review found
// 0 of 13 steps in view at the workspace issue level, and no way to them.

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (restores.length > 0) restores.pop()?.();
});

/** happy-dom lays nothing out: give the frame a size for one test. */
function sizeViewport(width: number, height: number): void {
  const proto = HTMLElement.prototype;
  const saved = {
    clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
  };
  for (const [key, size] of [
    ['clientWidth', width],
    ['clientHeight', height],
  ] as const) {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-graph-viewport') ? size : 0;
      },
    });
  }
  restores.push(() => {
    for (const key of ['clientWidth', 'clientHeight'] as const) {
      const descriptor = saved[key];
      if (descriptor === undefined) Reflect.deleteProperty(proto, key);
      else Object.defineProperty(proto, key, descriptor);
    }
  });
}

const NODES: GraphNodeData[] = [
  { id: 'a', label: 'Alpha', tone: 'default' },
  { id: 'b', label: 'Beta', tone: 'default' },
  { id: 'c', label: 'Gamma', tone: 'default' },
  { id: 'd', label: 'Delta', tone: 'default' },
];
const EDGES: GraphEdgeData[] = [
  { from: 'a', to: 'b', kind: 'default' },
  { from: 'b', to: 'c', kind: 'default' },
];

/** A host layout with the path spread over a 2,400 x 1,400 canvas: Delta
    (on no chain) at the top-left, step 1 far right, step 2 low left. */
function spreadLayout(at: Record<string, [number, number]>): GraphLayout {
  const box = (id: string, rank: number) => ({
    id,
    x: at[id]?.[0] ?? 0,
    y: at[id]?.[1] ?? 0,
    width: 180,
    height: 60,
    rank,
    labelLines: [id],
    sublabelLine: '',
  });
  return {
    width: 2400,
    height: 1400,
    direction: 'LR',
    nodes: [box('d', 0), box('a', 0), box('b', 1), box('c', 2)],
    edges: [],
    groups: [],
  };
}

const SPREAD = spreadLayout({
  d: [0, 0],
  a: [2000, 0],
  b: [0, 600],
  c: [1000, 1200],
});

function renderGraph(props: Partial<DependencyGraphProps> = {}) {
  return render(
    <DependencyGraph
      nodes={NODES}
      edges={EDGES}
      layout={SPREAD}
      ariaSummary="A path."
      emptyMessage="Nothing."
      onSelect={() => undefined}
      {...props}
    />
  );
}

function viewportOf(container: HTMLElement): HTMLElement {
  const viewport = container.querySelector<HTMLElement>(
    '[data-graph-viewport]'
  );
  if (viewport === null) throw new Error('viewport');
  return viewport;
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
  if (el === null) throw new Error(id);
  return el;
}

function stepText(container: HTMLElement): string | null {
  return (
    container.querySelector('[data-graph-steps] output')?.textContent ?? null
  );
}

function stepButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-graph-steps] button[aria-label="${name}"]`
  );
  if (button === null) throw new Error(name);
  return button;
}

describe('DependencyGraph: finding the critical path', () => {
  test('switching to Critical path scrolls the frame to step 1 when no step shows', () => {
    sizeViewport(400, 300);
    const view = renderGraph({ highlight: 'status' });
    const viewport = viewportOf(view.container);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    view.rerender(
      <DependencyGraph
        nodes={NODES}
        edges={EDGES}
        layout={SPREAD}
        ariaSummary="A path."
        emptyMessage="Nothing."
        onSelect={() => undefined}
        highlight="critical"
      />
    );
    // Alpha (step 1) in the middle of the frame: 2000 + 90 - 200.
    expect(viewport.scrollLeft).toBe(1890);
    expect(viewport.scrollTop).toBe(0);
  });

  test('a step already in the frame keeps the frame where it is', () => {
    sizeViewport(400, 300);
    const near = spreadLayout({ d: [0, 0], a: [200, 0], b: [0, 600] });
    const props = {
      nodes: NODES,
      edges: EDGES,
      layout: near,
      ariaSummary: 'A path.',
      emptyMessage: 'Nothing.',
      onSelect: () => undefined,
    };
    const view = render(<DependencyGraph {...props} highlight="risk" />);
    const viewport = viewportOf(view.container);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    view.rerender(<DependencyGraph {...props} highlight="critical" />);
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
  });

  test('arriving on Critical path with nothing to centre opens on step 1', () => {
    sizeViewport(400, 300);
    const view = renderGraph({ highlight: 'critical' });
    expect(viewportOf(view.container).scrollLeft).toBe(1890);
  });

  test('the step control walks the path, lighting and centring each step', () => {
    sizeViewport(400, 300);
    const view = renderGraph({ highlight: 'critical' });
    const { container } = view;
    const viewport = viewportOf(container);
    expect(stepText(container)).toBe('3 steps');
    expect(stepButton(container, 'Previous step').disabled).toBe(true);

    fireEvent.click(stepButton(container, 'Go to step 1'));
    expect(stepText(container)).toBe('Step 1 of 3');
    expect(nodeEl(container, 'a').dataset.pointed).toBe('');
    expect(nodeEl(container, 'a').dataset.state).toBe('active');

    fireEvent.click(stepButton(container, 'Next step'));
    expect(stepText(container)).toBe('Step 2 of 3');
    expect(nodeEl(container, 'b').dataset.pointed).toBe('');
    expect(nodeEl(container, 'a').dataset.pointed).toBeUndefined();
    // The path's own numbers hold while it is walked.
    expect(nodeEl(container, 'b').dataset.step).toBe('2');
    // Beta in the middle: 0 + 90 - 200 is clamped at 0; 600 + 30 - 150.
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 480]);

    fireEvent.click(stepButton(container, 'Next step'));
    expect(stepText(container)).toBe('Step 3 of 3');
    expect(stepButton(container, 'Next step').disabled).toBe(true);
    fireEvent.click(stepButton(container, 'Previous step'));
    expect(stepText(container)).toBe('Step 2 of 3');

    // Escape drops the walked step; the control counts the steps again.
    fireEvent.keyDown(stepButton(container, 'Previous step'), {
      key: 'Escape',
    });
    expect(stepText(container)).toBe('3 steps');
    expect(nodeEl(container, 'b').dataset.pointed).toBeUndefined();
  });

  test('] and [ on a box move focus along the path', () => {
    sizeViewport(400, 300);
    const { container } = renderGraph({ highlight: 'critical' });
    act(() => nodeEl(container, 'a').focus());
    fireEvent.keyDown(nodeEl(container, 'a'), { key: ']' });
    expect(document.activeElement).toBe(nodeEl(container, 'b'));
    expect(stepText(container)).toBe('Step 2 of 3');
    fireEvent.keyDown(nodeEl(container, 'b'), { key: '[' });
    expect(document.activeElement).toBe(nodeEl(container, 'a'));
    expect(stepText(container)).toBe('Step 1 of 3');
  });

  test('switching to Critical path while a box is locked keeps the frame on it', () => {
    sizeViewport(400, 300);
    const props = {
      nodes: NODES,
      edges: EDGES,
      layout: SPREAD,
      ariaSummary: 'A path.',
      emptyMessage: 'Nothing.',
      onSelect: () => undefined,
      // Delta, on no chain, at the top-left: no step is in the frame.
      lockedId: 'd',
    };
    const view = render(<DependencyGraph {...props} highlight="status" />);
    const viewport = viewportOf(view.container);
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
    view.rerender(<DependencyGraph {...props} highlight="critical" />);
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
    expect(nodeEl(view.container, 'd').dataset.locked).toBe('');
  });

  test('with a box locked the step control walks the chain through it', () => {
    sizeViewport(400, 300);
    // Alpha → Beta → Gamma is the graph-wide path; Epsilon → Zeta a
    // shorter chain of its own.
    const nodes: GraphNodeData[] = [
      ...NODES,
      { id: 'e', label: 'Epsilon', tone: 'default' },
      { id: 'f', label: 'Zeta', tone: 'default' },
    ];
    const edges: GraphEdgeData[] = [
      ...EDGES,
      { from: 'e', to: 'f', kind: 'default' },
    ];
    const layout: GraphLayout = {
      ...SPREAD,
      nodes: [
        ...SPREAD.nodes,
        { ...SPREAD.nodes[0], id: 'e', x: 400, y: 0, rank: 0 },
        { ...SPREAD.nodes[0], id: 'f', x: 700, y: 0, rank: 1 },
      ],
    };
    const props = {
      nodes,
      edges,
      layout,
      ariaSummary: 'Two chains.',
      emptyMessage: 'Nothing.',
      onSelect: () => undefined,
      highlight: 'critical' as const,
    };
    const view = render(<DependencyGraph {...props} lockedId={null} />);
    expect(stepText(view.container)).toBe('3 steps');
    view.rerender(<DependencyGraph {...props} lockedId="f" />);
    expect(stepText(view.container)).toBe('2 steps');
    fireEvent.click(stepButton(view.container, 'Go to step 1'));
    expect(stepText(view.container)).toBe('Step 1 of 2');
    expect(nodeEl(view.container, 'e').dataset.pointed).toBe('');
    expect(nodeEl(view.container, 'f').dataset.locked).toBe('');
    // A lock on no chain walks the graph-wide path again.
    view.rerender(<DependencyGraph {...props} lockedId="d" />);
    expect(stepText(view.container)).toBe('3 steps');
  });

  test('no step control outside Critical path, or with no path', () => {
    const risk = renderGraph({ highlight: 'risk' });
    expect(risk.container.querySelector('[data-graph-steps]')).toBeNull();
    cleanup();
    const lone = renderGraph({ highlight: 'critical', edges: [] });
    expect(lone.container.querySelector('[data-graph-steps]')).toBeNull();
  });
});
