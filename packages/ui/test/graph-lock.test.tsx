import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import {
  DependencyGraph,
  DOUBLE_CLICK_MS,
  DOUBLE_PRESS_MS,
  lockStripPlace,
} from '../src/graph/dependency-graph';
import { layoutGraph } from '../src/graph/layout';
import type {
  DependencyGraphProps,
  GraphClusterData,
  GraphEdgeData,
  GraphLayout,
  GraphNodeData,
  GraphNodeReadiness,
} from '../src/graph/types';

// Lock on and drill down (owner request 2026-10-23, architecture §8.4
// Graph "Lock on"): a click, tap or Enter locks a box so its paths stay
// lit while the reader pans, scrolls, zooms or switches the highlight; a
// second press opens it; the locked box carries an action strip (Open,
// Open graph, Unlock) kept in view; a double press drills into the box's
// own graph, and a double-click on a frame's title into the frame's.

afterEach(() => {
  cleanup();
  setSystemTime();
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits `ms` inside act(), so the graph's timers run. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

/** Waits out a mouse's second click's double-click window. */
async function afterDoubleClick(): Promise<void> {
  await wait(DOUBLE_CLICK_MS + 60);
}

/** Waits out a second tap's double-tap window. */
async function afterDoublePress(): Promise<void> {
  await wait(DOUBLE_PRESS_MS + 60);
}

const READY: GraphNodeReadiness = {
  state: 'ready',
  label: 'Ready',
  tone: 'success',
  blockedBy: 0,
  unblocks: 1,
};

const blockedBy = (n: number, unblocks = 0): GraphNodeReadiness => ({
  state: 'blocked',
  label: `Blocked by ${n}`,
  tone: 'warning',
  blockedBy: n,
  unblocks,
});

/** ENG-12 → ENG-23 → OPS-20, each with a chain to drill into; ENG-26 has
    none (a loose issue in a milestone's own graph). */
const CHAIN: GraphNodeData[] = [
  {
    id: 'ENG-12',
    key: 'ENG-12',
    label: 'Dual-write payments',
    tone: 'default',
    readiness: READY,
    drillHref: '/graph?chain=ENG-12',
  },
  {
    id: 'ENG-23',
    key: 'ENG-23',
    label: 'Typo tolerance',
    tone: 'default',
    readiness: blockedBy(1, 1),
    drillHref: '/graph?chain=ENG-23',
  },
  {
    id: 'OPS-20',
    key: 'OPS-20',
    label: 'Load test search',
    tone: 'default',
    readiness: blockedBy(1),
    drillHref: '/graph?chain=OPS-20',
  },
  {
    id: 'ENG-26',
    key: 'ENG-26',
    label: 'Backfill',
    tone: 'default',
    readiness: { ...READY, state: 'independent', label: '', unblocks: 0 },
  },
];

const CHAIN_EDGES: GraphEdgeData[] = [
  { from: 'ENG-12', to: 'ENG-23', kind: 'default' },
  { from: 'ENG-23', to: 'OPS-20', kind: 'default' },
];

function renderChain(props: Partial<DependencyGraphProps> = {}) {
  return render(
    <DependencyGraph
      nodes={CHAIN}
      edges={CHAIN_EDGES}
      ariaSummary="A chain."
      emptyMessage="Nothing."
      onSelect={() => undefined}
      onDrill={() => undefined}
      pathWords={{ unit: ['issue', 'issues'] }}
      {...props}
    />
  );
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
  if (el === null) throw new Error(`no node ${id}`);
  return el;
}

function viewportOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-graph-viewport]');
  if (el === null) throw new Error('viewport');
  return el;
}

function readoutOf(container: HTMLElement): string {
  return (
    container.querySelector('[data-graph-readout]')?.textContent ?? '(none)'
  );
}

function stripOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-graph-lock-strip]');
}

function locked(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-locked]')]
    .map((el) => el.dataset.graphNode)
    .filter((id): id is string => id !== undefined);
}

function statusOf(container: HTMLElement): string {
  return container.querySelector('[data-graph-lock-status]')?.textContent ?? '';
}

/** A mouse click (detail counts the clicks of a double-click). */
function click(el: Element, detail = 1): boolean {
  return fireEvent.click(el, { detail });
}

/** A touch tap: a touch press, then its click. */
function tap(el: Element): boolean {
  fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 7 });
  return fireEvent.click(el, { detail: 1 });
}

describe('DependencyGraph: lock on', () => {
  test('a click locks the box: it stays the active node, with its own mark', () => {
    const onSelect = mock((_id: string) => undefined);
    const { container } = renderChain({ onSelect });
    const box = nodeEl(container, 'ENG-23');
    click(box);
    expect(onSelect).not.toHaveBeenCalled();
    expect(locked(container)).toEqual(['ENG-23']);
    expect(box.getAttribute('aria-pressed')).toBe('true');
    expect(box.dataset.state).toBe('active');
    expect(box.hasAttribute('data-pointed')).toBe(true);
    expect(nodeEl(container, 'ENG-12').dataset.state).toBe('lit');
    expect(nodeEl(container, 'OPS-20').dataset.state).toBe('down');
    expect(nodeEl(container, 'OPS-20').hasAttribute('data-next')).toBe(true);
    // The graph says it is locked, for the hover rule.
    expect(
      container.querySelector('[data-highlight]')?.hasAttribute('data-locked')
    ).toBe(true);
    // The readout leads with the lock and its actions.
    expect(readoutOf(container)).toBe(
      'Locked on ENG-23 Open Open its graph Unlock Blocked by 1 · Waits on 1 open, start with ENG-12 · Holds up 1 · Done would unblock 1: OPS-20'
    );
    // Its Unlock is a button like Open its graph (not a ghost that reads
    // as one more fact), and a rule, not a " · ", parts the three buttons
    // from the facts.
    const readout = container.querySelector('[data-graph-readout]');
    const actions = [
      ...(readout?.querySelectorAll<HTMLElement>('[data-lock-action]') ?? []),
    ];
    expect(actions.map((el) => el.dataset.lockAction)).toEqual([
      'open',
      'graph',
      'unlock',
    ]);
    expect(actions[2]?.className).toBe(actions[1]?.className);
    const after = actions[2]?.parentElement?.nextElementSibling;
    expect(after?.getAttribute('aria-hidden')).toBe('true');
    expect(after?.textContent).toBe(' ');
    // Said once to a screen reader, in a status line (not the readout).
    expect(statusOf(container)).toBe('Locked on ENG-23 Typo tolerance.');
    expect(
      container.querySelector('[data-graph-lock-status]')?.getAttribute('role')
    ).toBe('status');
    expect(
      container.querySelector('[data-graph-readout]')?.hasAttribute('aria-live')
    ).toBe(false);
  });

  test('a second click on the locked box opens it (after the double-click window)', async () => {
    const onSelect = mock((_id: string) => undefined);
    const { container } = renderChain({ onSelect });
    const box = nodeEl(container, 'ENG-23');
    click(box);
    click(box);
    // It has a graph to drill into, so the open waits out a double-click:
    // the longest common one (500 ms), not only the double tap's 300 ms.
    expect(onSelect).not.toHaveBeenCalled();
    await afterDoublePress();
    expect(onSelect).not.toHaveBeenCalled();
    await wait(DOUBLE_CLICK_MS - DOUBLE_PRESS_MS);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe('ENG-23');
    // Opening keeps the lock.
    expect(locked(container)).toEqual(['ENG-23']);
  });

  test('a slow double-click on the locked box drills without opening it first', async () => {
    const onSelect = mock((_id: string) => undefined);
    const onDrill = mock((_href: string) => undefined);
    const { container } = renderChain({ onSelect, onDrill });
    const box = nodeEl(container, 'ENG-23');
    click(box);
    expect(locked(container)).toEqual(['ENG-23']);
    // The OS still counts two clicks 350 ms apart as a double-click.
    click(box, 1);
    await wait(350);
    click(box, 2);
    expect(onDrill.mock.calls).toEqual([['/graph?chain=ENG-23']]);
    await afterDoubleClick();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a box with nothing to drill into opens on the second click at once', () => {
    const onSelect = mock((_id: string) => undefined);
    const { container } = renderChain({ onSelect });
    const box = nodeEl(container, 'ENG-26');
    click(box);
    expect(onSelect).not.toHaveBeenCalled();
    click(box);
    expect(onSelect).toHaveBeenCalledTimes(1);
    // A double-click on it opens it once, as a second click does.
    click(nodeEl(container, 'ENG-12'));
    click(box);
    click(box, 2);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  test('a click on another box moves the lock there', () => {
    const onLockChange = mock((_id: string | null) => undefined);
    const { container } = renderChain({ onLockChange });
    click(nodeEl(container, 'ENG-23'));
    click(nodeEl(container, 'OPS-20'));
    expect(locked(container)).toEqual(['OPS-20']);
    expect(onLockChange.mock.calls.map((call) => call[0])).toEqual([
      'ENG-23',
      'OPS-20',
    ]);
    expect(statusOf(container)).toBe('Locked on OPS-20 Load test search.');
  });

  test('pointing at other boxes while locked moves nothing', () => {
    const { container } = renderChain();
    click(nodeEl(container, 'ENG-23'));
    const before = readoutOf(container);
    const other = nodeEl(container, 'ENG-26');
    fireEvent.pointerEnter(other, { pointerType: 'mouse' });
    expect(nodeEl(container, 'ENG-23').dataset.state).toBe('active');
    expect(nodeEl(container, 'ENG-12').dataset.state).toBe('lit');
    expect(other.dataset.state).toBe('dim');
    expect(other.hasAttribute('data-pointed')).toBe(false);
    expect(readoutOf(container)).toBe(before);
    // Keyboard focus on another box previews nothing either.
    act(() => nodeEl(container, 'OPS-20').focus());
    expect(nodeEl(container, 'ENG-23').dataset.state).toBe('active');
    expect(readoutOf(container)).toBe(before);
    act(() => nodeEl(container, 'OPS-20').blur());
    // Unlocked, the box under the pointer is read again at once.
    fireEvent.keyDown(nodeEl(container, 'ENG-23'), { key: 'Escape' });
    expect(locked(container)).toEqual([]);
    expect(other.dataset.state).toBe('active');
    expect(other.hasAttribute('data-pointed')).toBe(true);
  });

  test('panning, scrolling, zooming and switching the highlight keep the lock', () => {
    const props = {
      nodes: CHAIN,
      edges: CHAIN_EDGES,
      ariaSummary: 'A chain.',
      emptyMessage: 'Nothing.',
      onSelect: () => undefined,
    };
    const { container, rerender, getByRole } = render(
      <DependencyGraph {...props} />
    );
    click(nodeEl(container, 'ENG-23'));
    const viewport = viewportOf(container);
    // A drag on the background, and the click its release sends.
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0 };
    fireEvent.pointerDown(viewport.firstElementChild as HTMLElement, {
      ...pointer,
      clientX: 200,
      clientY: 200,
    });
    fireEvent.pointerMove(viewport, {
      ...pointer,
      buttons: 1,
      clientX: 120,
      clientY: 160,
    });
    fireEvent.pointerUp(viewport, { ...pointer, clientX: 120, clientY: 160 });
    click(viewport);
    expect(locked(container)).toEqual(['ENG-23']);
    // A plain wheel scrolls (and a scroll event) leave it.
    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
      viewport.scrollTop = 40;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(locked(container)).toEqual(['ENG-23']);
    // Zoom and Fit.
    fireEvent.click(getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(
      getByRole('button', { name: 'Fit the graph to the frame' })
    );
    fireEvent.keyDown(nodeEl(container, 'ENG-23'), { key: '-' });
    expect(locked(container)).toEqual(['ENG-23']);
    // Another highlight: still locked, and under Critical path the lock
    // shows the longest chain through it.
    rerender(<DependencyGraph {...props} highlight="critical" />);
    expect(locked(container)).toEqual(['ENG-23']);
    expect(nodeEl(container, 'ENG-23').dataset.state).toBe('active');
    expect(nodeEl(container, 'OPS-20').dataset.step).toBe('3');
    rerender(<DependencyGraph {...props} highlight="status" />);
    expect(locked(container)).toEqual(['ENG-23']);
  });

  test('a drag that starts on a box pans and leaves no trace on it', () => {
    const { container } = renderChain();
    const viewport = viewportOf(container);
    const box = nodeEl(container, 'ENG-23');
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0 };
    // A mouse press focuses the button it goes down on.
    fireEvent.pointerDown(box, { ...pointer, clientX: 300, clientY: 300 });
    act(() => box.focus());
    expect(box.dataset.state).toBe('active');
    fireEvent.pointerMove(viewport, {
      ...pointer,
      buttons: 1,
      clientX: 200,
      clientY: 300,
    });
    fireEvent.pointerUp(viewport, { ...pointer, clientX: 200, clientY: 300 });
    click(box);
    // Nothing locked, nothing lit, though the box keeps focus.
    expect(locked(container)).toEqual([]);
    expect(box.dataset.state).toBeUndefined();
    expect(box.hasAttribute('data-pointed')).toBe(false);
    expect(nodeEl(container, 'ENG-12').dataset.state).toBeUndefined();
    expect(document.activeElement).toBe(box);
    // The keyboard still traces it from there.
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(nodeEl(container, 'OPS-20'));
    expect(nodeEl(container, 'OPS-20').dataset.state).toBe('active');
  });

  test('Escape, a click on the background, Unlock and the strip each unlock', () => {
    const { container } = renderChain();
    const box = nodeEl(container, 'ENG-23');
    const lock = () => {
      click(box);
      expect(locked(container)).toEqual(['ENG-23']);
    };
    lock();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(locked(container)).toEqual([]);
    expect(box.dataset.state).toBeUndefined();
    expect(statusOf(container)).toBe('Unlocked.');
    lock();
    click(viewportOf(container));
    expect(locked(container)).toEqual([]);
    lock();
    const strip = stripOf(container);
    const unlock = strip?.querySelector<HTMLElement>(
      '[data-lock-action="unlock"]'
    );
    if (unlock === null || unlock === undefined) throw new Error('unlock');
    expect(unlock.getAttribute('aria-label')).toBe('Unlock');
    click(unlock);
    expect(locked(container)).toEqual([]);
    expect(stripOf(container)).toBeNull();
    // The readout's own Unlock, from the keyboard: focus goes to the box.
    lock();
    const readoutUnlock = container.querySelector<HTMLElement>(
      '[data-graph-readout] [data-lock-action="unlock"]'
    );
    if (readoutUnlock === null) throw new Error('readout unlock');
    expect(readoutUnlock.textContent).toBe('Unlock');
    click(readoutUnlock, 0);
    expect(locked(container)).toEqual([]);
    expect(document.activeElement).toBe(box);
    // Escape from the strip unlocks too and leaves focus on the box.
    lock();
    const open = stripOf(container)?.querySelector<HTMLElement>(
      '[data-lock-action="open"]'
    );
    if (open === null || open === undefined) throw new Error('open');
    act(() => open.focus());
    fireEvent.keyDown(open, { key: 'Escape' });
    expect(locked(container)).toEqual([]);
    expect(document.activeElement).toBe(box);
  });

  test('Escape unlocks from outside the graph too, unless something nearer takes it', () => {
    const { container } = renderChain();
    const box = nodeEl(container, 'ENG-23');
    const field = document.createElement('input');
    document.body.append(field);
    try {
      // A drag on the background leaves focus on the page itself.
      click(box);
      act(() => box.blur());
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(locked(container)).toEqual([]);
      expect(statusOf(container)).toBe('Unlocked.');
      // An open panel's (or menu's) own Escape on the document goes first.
      click(box);
      const panel = (event: KeyboardEvent) => event.preventDefault();
      document.addEventListener('keydown', panel);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      document.removeEventListener('keydown', panel);
      expect(locked(container)).toEqual(['ENG-23']);
      // Escape typed into a field elsewhere is the field's.
      act(() => field.focus());
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(locked(container)).toEqual(['ENG-23']);
    } finally {
      field.remove();
    }
  });

  test('a host lock: lockedId shows it, onLockChange is told, a box not drawn locks nothing', () => {
    function Host() {
      const [lock, setLock] = useState<string | null>('OPS-20');
      return (
        <>
          <DependencyGraph
            nodes={CHAIN}
            edges={CHAIN_EDGES}
            ariaSummary="A chain."
            emptyMessage="Nothing."
            onSelect={() => undefined}
            lockedId={lock}
            onLockChange={setLock}
          />
          <output data-host-lock="">{lock ?? 'none'}</output>
        </>
      );
    }
    const { container } = render(<Host />);
    const host = () =>
      container.querySelector('[data-host-lock]')?.textContent ?? '';
    expect(locked(container)).toEqual(['OPS-20']);
    click(nodeEl(container, 'ENG-12'));
    expect(host()).toBe('ENG-12');
    expect(locked(container)).toEqual(['ENG-12']);
    fireEvent.keyDown(nodeEl(container, 'ENG-12'), { key: 'Escape' });
    expect(host()).toBe('none');
    // A host that keeps a lock on a box it does not draw: nothing locks.
    const { container: other } = renderChain({ lockedId: 'not-drawn' });
    expect(locked(other)).toEqual([]);
    expect(stripOf(other)).toBeNull();
  });

  test('a new selection from the host moves the lock to it', () => {
    const onLockChange = mock((_id: string | null) => undefined);
    const props = {
      nodes: CHAIN,
      edges: CHAIN_EDGES,
      ariaSummary: 'A chain.',
      emptyMessage: 'Nothing.',
      onSelect: () => undefined,
      onLockChange,
    };
    const { container, rerender } = render(
      <DependencyGraph {...props} selectedId={null} />
    );
    // Unlocked, a selection locks nothing.
    rerender(<DependencyGraph {...props} selectedId="ENG-26" />);
    expect(locked(container)).toEqual([]);
    click(nodeEl(container, 'ENG-23'));
    // A panel's "Waits on" row selects ENG-12: the lock follows.
    rerender(<DependencyGraph {...props} selectedId="ENG-12" />);
    expect(locked(container)).toEqual(['ENG-12']);
    expect(onLockChange.mock.calls.map((call) => call[0])).toEqual([
      'ENG-23',
      'ENG-12',
    ]);
  });

  test('the lock is centred on a reload or a shared link', () => {
    const restore = sizeViewport(300, 60);
    try {
      const box = layoutGraph(CHAIN, CHAIN_EDGES).nodes.find(
        (n) => n.id === 'OPS-20'
      );
      if (box === undefined) throw new Error('OPS-20');
      const { container } = renderChain({
        lockedId: 'OPS-20',
        focusId: 'ENG-12',
      });
      expect(viewportOf(container).scrollLeft).toBe(
        Math.max(0, box.x + box.width / 2 - 150)
      );
    } finally {
      restore();
    }
  });
});

describe('DependencyGraph: the locked box’s action strip', () => {
  test('Open, Open graph and Unlock ride the locked box', () => {
    const onSelect = mock((_id: string) => undefined);
    const { container } = renderChain({
      onSelect,
      drillHrefFor: (href) => `${href}&highlight=risk`,
    });
    expect(stripOf(container)).toBeNull();
    click(nodeEl(container, 'ENG-23'));
    const strip = stripOf(container);
    if (strip === null) throw new Error('strip');
    expect(strip.dataset.graphLockStrip).toBe('ENG-23');
    expect(strip.getAttribute('role')).toBe('group');
    expect(strip.getAttribute('aria-label')).toBe('Locked on ENG-23');
    const actions = [
      ...strip.querySelectorAll<HTMLElement>('[data-lock-action]'),
    ];
    expect(actions.map((el) => el.dataset.lockAction)).toEqual([
      'open',
      'graph',
      'unlock',
    ]);
    expect(actions.map((el) => el.textContent)).toEqual([
      'Open',
      'Open graph',
      '',
    ]);
    // Open graph is a real link to the box's graph, as the host rewrites it.
    expect(actions[1].tagName).toBe('A');
    expect(actions[1].getAttribute('href')).toBe(
      '/graph?chain=ENG-23&highlight=risk'
    );
    // Every action is keyboard reachable: real buttons and links, in the
    // tab order, after the boxes (Tab from the box lands on Open).
    for (const el of actions) {
      expect(['BUTTON', 'A']).toContain(el.tagName);
      expect(el.tabIndex).toBeGreaterThanOrEqual(0);
    }
    const lastBox = [
      ...container.querySelectorAll<HTMLElement>('[data-graph-node]'),
    ].pop();
    expect(
      (lastBox?.compareDocumentPosition(strip) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // Open opens it at once (no double-click to wait for on a button).
    click(actions[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe('ENG-23');
    // A press on the strip never pans or unlocks.
    fireEvent.pointerDown(actions[1], {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
    });
    expect(viewportOf(container).hasAttribute('data-panning')).toBe(false);
    expect(locked(container)).toEqual(['ENG-23']);
  });

  test('a box with no graph gets no Open graph; a link node opens by its link', () => {
    const { container } = renderChain();
    click(nodeEl(container, 'ENG-26'));
    expect(
      [
        ...(stripOf(container)?.querySelectorAll<HTMLElement>(
          '[data-lock-action]'
        ) ?? []),
      ].map((el) => el.dataset.lockAction)
    ).toEqual(['open', 'unlock']);
    cleanup();
    const { container: links } = render(
      <DependencyGraph
        nodes={CHAIN.map((n) => ({ ...n, href: `/issues/${n.id}` }))}
        edges={CHAIN_EDGES}
        ariaSummary="Links."
        emptyMessage="Nothing."
      />
    );
    const anchor = nodeEl(links, 'ENG-23').querySelector('a');
    if (anchor === null) throw new Error('anchor');
    // The locking click does not follow the link.
    expect(click(anchor)).toBe(false);
    expect(anchor.getAttribute('aria-current')).toBe('true');
    const open = stripOf(links)?.querySelector('[data-lock-action="open"]');
    expect(open?.tagName).toBe('A');
    expect(open?.getAttribute('href')).toBe('/issues/ENG-23');
  });

  test('on a link node the second press follows the link', () => {
    const { container } = render(
      <DependencyGraph
        nodes={CHAIN.map((n) => ({ ...n, href: `/issues/${n.id}` }))}
        edges={CHAIN_EDGES}
        ariaSummary="Links."
        emptyMessage="Nothing."
      />
    );
    const anchor = nodeEl(container, 'ENG-26').querySelector('a');
    if (anchor === null) throw new Error('anchor');
    const followed: boolean[] = [];
    anchor.addEventListener('click', (event) => {
      // Recorded after React's handler: was the link left to follow?
      queueMicrotask(() => followed.push(!event.defaultPrevented));
    });
    click(anchor);
    // Enter on the locked link node: the anchor is clicked through.
    fireEvent.keyDown(anchor, { key: 'Enter' });
    return Promise.resolve().then(() => {
      expect(followed).toEqual([false, true]);
    });
  });

  test('the strip sits under the box and moves with the scroll, kept in view', () => {
    const layout: GraphLayout = {
      width: 1000,
      height: 500,
      direction: 'LR',
      nodes: [
        {
          id: 'ENG-12',
          x: 10,
          y: 20,
          width: 180,
          height: 60,
          rank: 0,
          labelLines: ['Dual-write payments'],
          sublabelLine: '',
        },
        {
          id: 'ENG-23',
          x: 600,
          y: 400,
          width: 180,
          height: 60,
          rank: 1,
          labelLines: ['Typo tolerance'],
          sublabelLine: '',
        },
      ],
      edges: [],
      groups: [],
    };
    const restore = sizeViewport(500, 200);
    const unstub = stubStrip(200, 30);
    try {
      const { container } = render(
        <DependencyGraph
          nodes={CHAIN.slice(0, 2)}
          edges={[]}
          ariaSummary="Two."
          emptyMessage="Nothing."
          onSelect={() => undefined}
          layout={layout}
        />
      );
      const viewport = viewportOf(container);
      click(nodeEl(container, 'ENG-23'));
      const strip = stripOf(container);
      if (strip === null) throw new Error('strip');
      const scrollTo = (left: number, top: number) =>
        act(() => {
          viewport.scrollLeft = left;
          viewport.scrollTop = top;
          viewport.dispatchEvent(new Event('scroll'));
        });
      // The box in view: the strip under it, at its ring's left edge.
      scrollTo(500, 300);
      expect([strip.style.left, strip.style.top, strip.dataset.side]).toEqual([
        '596px',
        '464px',
        'below',
      ]);
      // No room under it on screen: over it instead, never on its words.
      scrollTo(500, 280);
      expect([strip.style.left, strip.style.top, strip.dataset.side]).toEqual([
        '596px',
        '366px',
        'above',
      ]);
      // Near the frame's right edge: slid left to stay in view, still
      // beside the box.
      scrollTo(250, 300);
      expect(strip.style.left).toBe('546px');
      // It follows a zoom: the box's place scales, the strip does not.
      fireEvent.click(
        container.querySelector('[aria-label="Zoom out"]') as HTMLElement
      );
      expect(strip.style.left).not.toBe('546px');
    } finally {
      unstub();
      restore();
    }
  });

  test('a lock from the first render (a reload, a shared link) is placed and follows the scroll', () => {
    const layout: GraphLayout = {
      width: 1000,
      height: 500,
      direction: 'LR',
      nodes: [
        {
          id: 'ENG-23',
          x: 600,
          y: 400,
          width: 180,
          height: 60,
          rank: 0,
          labelLines: ['Typo tolerance'],
          sublabelLine: '',
        },
      ],
      edges: [],
      groups: [],
    };
    const restore = sizeViewport(500, 200);
    const unstub = stubStrip(200, 30);
    try {
      const { container } = render(
        <DependencyGraph
          nodes={CHAIN.slice(1, 2)}
          edges={[]}
          ariaSummary="One."
          emptyMessage="Nothing."
          onSelect={() => undefined}
          layout={layout}
          lockedId="ENG-23"
        />
      );
      const strip = stripOf(container);
      if (strip === null) throw new Error('strip');
      const viewport = viewportOf(container);
      act(() => {
        viewport.scrollLeft = 500;
        viewport.scrollTop = 280;
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect([strip.style.top, strip.dataset.side]).toEqual(['366px', 'above']);
    } finally {
      unstub();
      restore();
    }
  });

  test('the strip keeps clear of the screen’s fixed bars, placed again on a page scroll', () => {
    const layout: GraphLayout = {
      width: 1000,
      height: 500,
      direction: 'LR',
      nodes: [
        {
          id: 'ENG-23',
          x: 600,
          y: 400,
          width: 180,
          height: 60,
          rank: 0,
          labelLines: ['Typo tolerance'],
          sublabelLine: '',
        },
      ],
      edges: [],
      groups: [],
    };
    const restore = sizeViewport(500, 200);
    const unstub = stubStrip(200, 30);
    // A phone's tab bar, fixed over the window's bottom edge.
    const bar = document.createElement('nav');
    bar.dataset.uiEdgeBar = 'bottom';
    let barTop = 900;
    bar.getBoundingClientRect = () =>
      ({
        x: 0,
        y: barTop,
        left: 0,
        top: barTop,
        right: 1024,
        bottom: barTop + 56,
        width: 1024,
        height: 56,
      }) as DOMRect;
    document.body.append(bar);
    try {
      const { container } = render(
        <DependencyGraph
          nodes={CHAIN.slice(1, 2)}
          edges={[]}
          ariaSummary="One."
          emptyMessage="Nothing."
          onSelect={() => undefined}
          layout={layout}
        />
      );
      const viewport = viewportOf(container);
      click(nodeEl(container, 'ENG-23'));
      const strip = stripOf(container);
      if (strip === null) throw new Error('strip');
      act(() => {
        viewport.scrollLeft = 500;
        viewport.scrollTop = 300;
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(strip.dataset.side).toBe('below');
      // The page scrolls, and the bar now covers the frame's bottom: the
      // strip moves over the box, where it can be tapped.
      barTop = 480;
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      expect([strip.style.top, strip.dataset.side]).toEqual(['366px', 'above']);
    } finally {
      bar.remove();
      unstub();
      restore();
    }
  });

  test('lockStripPlace: under, over, slid into view, and attached', () => {
    const box = { x: 600, y: 400, width: 180, height: 60 };
    const strip = { width: 200, height: 30 };
    const visible = (left: number, top: number, w = 500, h = 200) => ({
      left,
      top,
      right: left + w,
      bottom: top + h,
    });
    expect(lockStripPlace({ box, strip, visible: visible(500, 300) })).toEqual({
      left: 596,
      top: 464,
      side: 'below',
    });
    expect(lockStripPlace({ box, strip, visible: visible(500, 280) })).toEqual({
      left: 596,
      top: 366,
      side: 'above',
    });
    // No room under or over it: beside it, along its side.
    expect(
      lockStripPlace({ box, strip, visible: visible(500, 380, 500, 90) })
    ).toEqual({ left: 784, top: 396, side: 'right' });
    // Not on a side its own arrows use; with no side that fits whole, the
    // place that keeps most of it on screen (over it, here).
    expect(
      lockStripPlace({
        box,
        strip,
        visible: visible(500, 380, 500, 90),
        beside: { left: false, right: false },
      }).side
    ).toBe('above');
    // Slid left at the right edge, right at the left edge.
    expect(
      lockStripPlace({ box, strip, visible: visible(250, 300) }).left
    ).toBe(546);
    expect(
      lockStripPlace({ box, strip, visible: visible(700, 300) }).left
    ).toBe(704);
    // Never off the box's side: a box far out of view keeps it beside it.
    const far = lockStripPlace({ box, strip, visible: visible(0, 0, 300) });
    // (the ring's left edge, 4px out, plus the least overlap)
    expect(far.left).toBe(596 + 24 - 200);
    expect(far.left + strip.width).toBeGreaterThan(box.x);
  });

  test('lockStripPlace: over the box when under it would cover more words', () => {
    const box = { x: 600, y: 400, width: 180, height: 60 };
    const strip = { width: 200, height: 30 };
    const visible = { left: 500, top: 250, right: 1000, bottom: 600 };
    // Its arrows leave and enter by both sides.
    const beside = { left: false, right: false };
    // The next row's words start 10px under the ring: over the box, clear.
    const nextRow = { x: 600, y: 474, width: 180, height: 40 };
    expect(
      lockStripPlace({ box, strip, visible, avoid: [nextRow], beside })
    ).toEqual({
      left: 596,
      top: 366,
      side: 'above',
    });
    // A frame title over it covers less than the next row: still over.
    const title = { x: 600, y: 380, width: 60, height: 12 };
    expect(
      lockStripPlace({ box, strip, visible, avoid: [nextRow, title], beside })
        .side
    ).toBe('above');
    // Words on both sides, more of them over it: under it, as by default.
    const bigTitle = { x: 590, y: 360, width: 220, height: 40 };
    expect(
      lockStripPlace({
        box,
        strip,
        visible,
        avoid: [nextRow, bigTitle],
        beside,
      }).side
    ).toBe('below');
    // Nothing in the way either side: under it.
    expect(lockStripPlace({ box, strip, visible, avoid: [] }).side).toBe(
      'below'
    );
    // No room over it on screen: under it whatever it covers.
    expect(
      lockStripPlace({
        box,
        strip,
        visible: { ...visible, top: 380 },
        avoid: [nextRow],
        beside,
      }).side
    ).toBe('below');
    // Words under and over it, none beside it: beside it, on a side no
    // arrow of its own uses (the right first, then the left).
    const wide = { left: 300, top: 250, right: 1100, bottom: 600 };
    const both = [nextRow, { x: 600, y: 360, width: 180, height: 40 }];
    expect(lockStripPlace({ box, strip, visible: wide, avoid: both })).toEqual({
      left: 784,
      top: 396,
      side: 'right',
    });
    expect(
      lockStripPlace({
        box,
        strip,
        visible: wide,
        avoid: both,
        beside: { left: true, right: false },
      })
    ).toEqual({ left: 396, top: 396, side: 'left' });
  });

  test('lockStripPlace: never over the step control, nor beside it', () => {
    // A box at the frame's bottom-left, over the critical path's step
    // control (a hard limit, not a word to rather avoid).
    const box = { x: 20, y: 400, width: 180, height: 60 };
    const strip = { width: 200, height: 30 };
    const visible = { left: 0, top: 250, right: 600, bottom: 520 };
    const control = { x: 8, y: 476, width: 170, height: 30 };
    expect(lockStripPlace({ box, strip, visible }).side).toBe('below');
    expect(lockStripPlace({ box, strip, visible, blocked: [control] })).toEqual(
      { left: 16, top: 366, side: 'above' }
    );
    // No room over it either: beside it.
    expect(
      lockStripPlace({
        box,
        strip,
        visible: { ...visible, top: 380 },
        blocked: [control],
      }).side
    ).toBe('right');
    // A box half out of the frame's corner, with arrows both sides: under
    // it is off screen, so it goes over it, on screen, though it meets the
    // control there (off screen it would help nobody).
    expect(
      lockStripPlace({
        box: { x: -60, y: 480, width: 180, height: 60 },
        strip,
        visible,
        blocked: [control],
        beside: { left: false, right: false },
      })
    ).toEqual({ left: 4, top: 446, side: 'above' });
  });
});

describe('DependencyGraph: drill down', () => {
  test('a double-click locks, then opens the box’s own graph, not the box', async () => {
    const onSelect = mock((_id: string) => undefined);
    const onDrill = mock((_href: string) => undefined);
    const { container } = renderChain({
      onSelect,
      onDrill,
      drillHrefFor: (href) => `${href}&highlight=critical`,
    });
    const box = nodeEl(container, 'OPS-20');
    click(box, 1);
    click(box, 2);
    expect(onDrill).toHaveBeenCalledTimes(1);
    expect(onDrill.mock.calls[0][0]).toBe(
      '/graph?chain=OPS-20&highlight=critical'
    );
    // The first click's lock is the box drilled into.
    expect(locked(container)).toEqual(['OPS-20']);
    // A double-click on the already locked box drills too, and the open
    // its first click waited for never comes.
    click(box, 1);
    click(box, 2);
    expect(onDrill).toHaveBeenCalledTimes(2);
    await afterDoubleClick();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a double-click selects no text', () => {
    const { container } = renderChain();
    const box = nodeEl(container, 'ENG-12');
    expect(fireEvent.mouseDown(box, { detail: 1 })).toBe(true);
    expect(fireEvent.mouseDown(box, { detail: 2 })).toBe(false);
  });

  test('Shift + Enter opens its graph; the key help says every key', () => {
    const onDrill = mock((_href: string) => undefined);
    const onSelect = mock((_id: string) => undefined);
    const { container } = renderChain({ onDrill, onSelect });
    const box = nodeEl(container, 'ENG-12');
    act(() => box.focus());
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onDrill.mock.calls[0][0]).toBe('/graph?chain=ENG-12');
    expect(onSelect).not.toHaveBeenCalled();
    // Nothing to drill into: Shift + Enter does what a double-click does
    // there, locking the box and opening it at once.
    const loose = nodeEl(container, 'ENG-26');
    fireEvent.keyDown(loose, { key: 'Enter', shiftKey: true });
    expect(onDrill).toHaveBeenCalledTimes(1);
    expect(locked(container)).toEqual(['ENG-26']);
    expect(onSelect.mock.calls).toEqual([['ENG-26']]);
    // Again on the locked box: it opens it again (the host keeps it open).
    fireEvent.keyDown(loose, { key: 'Enter', shiftKey: true });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(locked(container)).toEqual(['ENG-26']);
    const help = document.getElementById(
      box.getAttribute('aria-describedby') ?? ''
    )?.textContent;
    expect(help).toContain(
      'Enter locks a box, keeping its paths lit; Enter on the locked box opens it, Shift and Enter opens its graph (the box itself when it has none), Tab reaches its buttons and Escape unlocks.'
    );
    expect(help).toContain(
      'On a touch screen, a tap locks a box and a second tap opens it; a double tap opens its graph.'
    );
    // The toolbar hint names the gestures too.
    expect(container.textContent).toContain(
      'Click to lock · Double-click to drill in · Drag to pan · Ctrl + wheel to zoom'
    );
  });

  test('the frame titles that drill open their graph on a double-click', () => {
    const nodes: GraphNodeData[] = CHAIN.map((n, i) => ({
      ...n,
      cluster: i < 2 ? 'milestone:m1' : 'milestone:m2',
    }));
    const clusters: GraphClusterData[] = [
      {
        id: 'milestone:m1',
        label: 'Dual-write',
        drillHref: '/graph?milestone=m1',
      },
      { id: 'milestone:m2', label: 'No milestone' },
    ];
    const onDrill = mock((_href: string) => undefined);
    const { container } = renderChain({
      nodes,
      clusters,
      onDrill,
      drillHrefFor: (href) => `${href}&highlight=risk`,
    });
    const title = (id: string) => {
      const el = container.querySelector<HTMLElement>(
        `[data-graph-cluster-title="${id}"]`
      );
      if (el === null) throw new Error(id);
      return el;
    };
    const drills = title('milestone:m1');
    expect(drills.hasAttribute('data-graph-drill')).toBe(true);
    expect(drills.getAttribute('title')).toBe(
      'Dual-write · double-click to open its graph'
    );
    // A single click on a title that drills does nothing, not even
    // unlock: it may be half of a double-click.
    click(nodeEl(container, 'ENG-23'));
    click(drills, 1);
    expect(locked(container)).toEqual(['ENG-23']);
    expect(onDrill).not.toHaveBeenCalled();
    click(drills, 2);
    expect(onDrill.mock.calls[0][0]).toBe('/graph?milestone=m1&highlight=risk');
    expect(fireEvent.mouseDown(drills, { detail: 2 })).toBe(false);
    // A double tap on it drills too.
    tap(drills);
    tap(drills);
    expect(onDrill).toHaveBeenCalledTimes(2);
    // A title with no graph is background: a click on it unlocks.
    const plain = title('milestone:m2');
    expect(plain.hasAttribute('data-graph-drill')).toBe(false);
    click(plain);
    expect(locked(container)).toEqual([]);
  });

  test('a host without onDrill gets a page load', () => {
    const assign = mock((_href: string) => undefined);
    const original = window.location.assign;
    Object.defineProperty(window.location, 'assign', {
      configurable: true,
      value: assign,
    });
    try {
      const { container } = renderChain({ onDrill: undefined });
      const box = nodeEl(container, 'ENG-12');
      click(box, 1);
      click(box, 2);
      expect(assign.mock.calls[0][0]).toBe('/graph?chain=ENG-12');
    } finally {
      Object.defineProperty(window.location, 'assign', {
        configurable: true,
        value: original,
      });
    }
  });
});

describe('DependencyGraph: keyboard and touch', () => {
  test('focus previews, Enter locks, Enter on the lock opens, Escape unlocks', () => {
    const onSelect = mock((_id: string) => undefined);
    const { container } = renderChain({ onSelect });
    const box = nodeEl(container, 'ENG-23');
    act(() => box.focus());
    expect(box.dataset.state).toBe('active');
    expect(locked(container)).toEqual([]);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(locked(container)).toEqual(['ENG-23']);
    expect(onSelect).not.toHaveBeenCalled();
    // From a key the open never waits for a double-click.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    // A button's own Space click is a key press too.
    click(nodeEl(container, 'OPS-20'), 0);
    expect(locked(container)).toEqual(['OPS-20']);
    click(nodeEl(container, 'OPS-20'), 0);
    expect(onSelect).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(nodeEl(container, 'OPS-20'), { key: 'Escape' });
    expect(locked(container)).toEqual([]);
  });

  test('Space locks a plain box; a second press on a box that opens nothing unlocks it', () => {
    const { container } = render(
      <DependencyGraph
        nodes={CHAIN}
        edges={CHAIN_EDGES}
        ariaSummary="Plain."
        emptyMessage="Nothing."
      />
    );
    const box = nodeEl(container, 'ENG-26');
    expect(box.tagName).toBe('DIV');
    act(() => box.focus());
    fireEvent.keyDown(box, { key: ' ' });
    expect(locked(container)).toEqual(['ENG-26']);
    expect(box.getAttribute('aria-current')).toBe('true');
    // Nothing to open: no Open on the strip, and a second press unlocks.
    expect(
      stripOf(container)?.querySelector('[data-lock-action="open"]')
    ).toBeNull();
    fireEvent.keyDown(box, { key: ' ' });
    expect(locked(container)).toEqual([]);
    const help = document.getElementById(
      box.getAttribute('aria-describedby') ?? ''
    )?.textContent;
    expect(help).toContain("On a touch screen, a tap locks a box's paths.");
  });

  test('a tap locks, a later tap opens, a double tap drills, a tap on the background unlocks', async () => {
    const onSelect = mock((_id: string) => undefined);
    const onDrill = mock((_href: string) => undefined);
    const { container } = renderChain({ onSelect, onDrill });
    const box = nodeEl(container, 'ENG-12');
    setSystemTime(new Date('2026-10-23T12:00:00Z'));
    // Chromium focuses a tapped button: that focus never traces alone.
    fireEvent.pointerDown(box, { pointerType: 'touch', pointerId: 7 });
    act(() => box.focus());
    fireEvent.click(box, { detail: 1 });
    expect(locked(container)).toEqual(['ENG-12']);
    expect(onSelect).not.toHaveBeenCalled();
    // A second tap a second later opens it (after the double-tap window).
    setSystemTime(new Date('2026-10-23T12:00:01Z'));
    tap(box);
    await afterDoublePress();
    expect(onSelect).toHaveBeenCalledTimes(1);
    // A double tap on another box: the first locks, the second drills.
    setSystemTime(new Date('2026-10-23T12:00:05Z'));
    const other = nodeEl(container, 'OPS-20');
    tap(other);
    tap(other);
    expect(onDrill.mock.calls[0][0]).toBe('/graph?chain=OPS-20');
    // A tap on the background unlocks, and the tapped focus leaves no trace.
    tap(viewportOf(container));
    expect(locked(container)).toEqual([]);
    expect(box.dataset.state).toBeUndefined();
    await afterDoublePress();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test('a tap after an unlock is a new first tap, never half of a double tap', () => {
    const onDrill = mock((_href: string) => undefined);
    const { container } = renderChain({ onDrill });
    const box = nodeEl(container, 'ENG-23');
    tap(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(locked(container)).toEqual([]);
    tap(box);
    expect(onDrill).not.toHaveBeenCalled();
    expect(locked(container)).toEqual(['ENG-23']);
  });

  test('a cancelled touch press (a scroll) is no tap', () => {
    const { container } = renderChain();
    const box = nodeEl(container, 'ENG-12');
    fireEvent.pointerDown(box, { pointerType: 'touch', pointerId: 7 });
    fireEvent.pointerCancel(box, { pointerType: 'touch', pointerId: 7 });
    // The browser's click after a cancel (if any) is a plain one.
    fireEvent.click(box, { detail: 1 });
    expect(locked(container)).toEqual(['ENG-12']);
    fireEvent.pointerDown(box, { pointerType: 'touch', pointerId: 7 });
    fireEvent.pointerCancel(box, { pointerType: 'touch', pointerId: 7 });
    fireEvent.click(box, { detail: 1 });
    // Not a double tap: nothing drilled, the box stays locked.
    expect(locked(container)).toEqual(['ENG-12']);
  });
});

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src, comments removed and whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string, from = 0): string {
  const at = sheet.indexOf(`${selector} {`, from);
  expect([selector, at >= 0]).toEqual([selector, true]);
  const open = sheet.indexOf('{', at);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

describe('the lock’s look (dependency-graph.module.css)', () => {
  const sheet = css('graph/dependency-graph.module.css');

  test('the locked box has its own mark beside the tint: rounded corner ticks, never the focus ring', () => {
    const mark = rule(sheet, '.lockMark');
    expect(mark).toContain('position: absolute');
    // Gr8r's rounded corners: a 2px accent edge with a small radius,
    // masked down to its four corners.
    expect(mark).toContain('border: 2px solid currentcolor');
    expect(mark).toContain('border-radius: var(--r-xs)');
    expect(mark).toContain('color: var(--accent)');
    expect(mark).toContain(
      'mask: conic-gradient( at var(--tick) var(--tick), transparent 75%, currentcolor 0 ) 0 0 / calc(100% - var(--tick)) calc(100% - var(--tick))'
    );
    expect(mark).toContain('pointer-events: none');
    // No rule rings the locked box itself: the keyboard focus ring (2px
    // accent, 1px out) is the only ring of its own it carries, so a focus
    // preview, a lock and a focused lock each look different.
    expect(sheet).not.toMatch(/\.node\.locked[^{]*\{[^}]*outline/);
    // Forced colours: the ticks kept, in Highlight, beside the double rule
    // of the box being read (not a thicker copy of the upstream ring).
    const forced = sheet.indexOf('@media (forced-colors: active)');
    expect(rule(sheet, '.lockMark, .node.locked > .lockMark', forced)).toBe(
      'forced-color-adjust: none; color: Highlight;'
    );
    expect(
      rule(
        sheet,
        '.node.pointed:not(:focus-visible), .node.selected:not(:focus-visible, .lit, .down, .chain)',
        forced
      )
    ).toBe('outline: 4px double CanvasText; outline-offset: 2px;');
  });

  test('the locked box draws its ticks, and only the locked box', () => {
    const { container } = renderChain();
    expect(container.querySelector('[data-lock-mark]')).toBeNull();
    click(nodeEl(container, 'ENG-23'));
    const marks = container.querySelectorAll('[data-lock-mark]');
    expect(marks).toHaveLength(1);
    expect(
      marks[0]?.closest('[data-graph-node]')?.getAttribute('data-graph-node')
    ).toBe('ENG-23');
    expect(marks[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  test('while locked a hover only fills a box and rings it thinly, never moves the trace', () => {
    // Gr8r's hover is the --surface-2 fill, the same locked or not: it is
    // never a flood, so it needs no lock guard.
    expect(
      rule(sheet, '.node:not(.selected, .overdueNode, .locked):hover')
    ).toBe('background: var(--surface-2);');
    expect(sheet).not.toContain(':where(.graph:not([data-locked]))');
    // A box off the locked box's paths also gets a thin neutral ring; one
    // on them keeps its 2px ring under the pointer, a focused one its
    // focus ring.
    expect(
      rule(
        sheet,
        ':where(.graph[data-locked]) .node:not(.locked, .lit, .down, .chain, :focus-visible):hover'
      )
    ).toBe('outline: 1px solid var(--control-border); outline-offset: 2px;');
  });

  test('the locked box keeps its accent tint under the pointer', () => {
    // The click that locks a box leaves the pointer on it: the hover fill
    // must not replace the tint there, or the lock reads as a hovered box
    // with a ring. The tint is the box being read's rule (the locked box
    // is always the box being read); no hover rule may reach the locked
    // box's background.
    expect(rule(sheet, '.node.pointed:not(.selected, .overdueNode)')).toBe(
      'background: linear-gradient(var(--accent-soft), var(--accent-soft)) var(--surface);'
    );
    const hovers = [
      ...sheet.matchAll(/([^{}]*:hover[^{}]*)\{([^}]*)\}/g),
    ].filter(([, , body]) => /background/.test(body ?? ''));
    const nodeHovers = hovers
      .map(([, selector]) => (selector ?? '').trim())
      .filter((selector) => selector.includes('.node'));
    expect(nodeHovers).toEqual([
      '.node:not(.selected, .overdueNode, .locked):hover',
    ]);
    // And the locked box is the box being read, so it carries .pointed.
    const { container } = renderChain();
    click(nodeEl(container, 'ENG-23'));
    const box = nodeEl(container, 'ENG-23');
    expect(box.getAttribute('data-locked')).toBe('');
    expect(box.getAttribute('data-pointed')).toBe('');
  });

  test('the strip is Gr8r: a floating bar of sentence-case buttons, Open the primary', () => {
    const strip = rule(sheet, '.lockStrip');
    expect(strip).toContain('border: 1px solid var(--border)');
    expect(strip).toContain('border-radius: var(--r)');
    expect(strip).toContain('background: var(--surface)');
    // It floats over the drawing, so it takes the floating shadow.
    expect(strip).toContain('box-shadow: var(--shadow-pop)');
    // The buttons: Gr8r's secondary at rest (Open graph), sentence case in
    // Geist, a 6px radius.
    const button = rule(sheet, '.lockButton, .readoutAction');
    expect(button).toContain('font-family: inherit');
    expect(button).toContain('border-radius: var(--r-sm)');
    expect(button).toContain('border: 1px solid var(--border-strong)');
    expect(button).toContain('box-shadow: var(--shadow-sm)');
    expect(button).toContain('color: var(--text)');
    expect(button).not.toContain('text-transform');
    expect(button).not.toContain('letter-spacing');
    expect(button).not.toContain('font-mono');
    expect(rule(sheet, '.lockButton')).toContain('height: var(--h-sm)');
    expect(
      rule(sheet, '.readoutAction', sheet.indexOf('.readoutActions {'))
    ).toContain('min-height: 24px');
    // Open: the primary, the accent fill.
    const open = rule(
      sheet,
      '.lockButton.actionOpen, .readoutAction.actionOpen'
    );
    expect(open).toContain('background: var(--accent)');
    expect(open).toContain('color: var(--on-accent)');
    // Unlock: an icon button on the strip, a secondary in the readout (a
    // ghost there read as one more fact), parted from the facts by a rule
    // that forced colours keep.
    const close = rule(sheet, '.lockClose');
    expect(close).toContain('border-color: transparent');
    expect(close).toContain('background: transparent');
    expect(close).toContain('color: var(--text-2)');
    expect(sheet).not.toContain('readoutQuiet');
    const rest = rule(sheet, '.readoutBreak');
    expect(rest).toContain('border-left: 1px solid var(--border-strong)');
    expect(rest).not.toContain('background');
    // "Locked on" in sentence case, the accent's text colour.
    const lead = rule(sheet, '.readoutLocked');
    expect(lead).toContain('color: var(--accent-ink)');
    expect(lead).not.toContain('text-transform');
    const coarse = sheet.indexOf('@media (pointer: coarse)');
    // A touch screen widens the buttons but keeps their height, so the
    // strip covers no more of the box under it.
    expect(rule(sheet, '.lockButton', coarse)).toBe('min-width: 32px;');
  });

  test('the strip reads in sentence case: Open, Open graph and an Unlock icon', () => {
    const { container } = renderChain();
    click(nodeEl(container, 'ENG-23'));
    const strip = container.querySelector('[data-graph-lock-strip]');
    const words = [
      ...(strip?.querySelectorAll('[data-lock-action]') ?? []),
    ].map((el) => [
      el.getAttribute('data-lock-action'),
      el.textContent,
      el.getAttribute('aria-label'),
    ]);
    expect(words[0]).toEqual(['open', 'Open', null]);
    expect(words.at(-1)).toEqual(['unlock', '', 'Unlock']);
  });

  test('a double press selects no text and zooms no page', () => {
    expect(rule(sheet, '.node')).toContain('user-select: none');
    expect(rule(sheet, '.viewport')).toContain('touch-action: manipulation');
    expect(rule(sheet, '.clusterTitleDrill')).toContain('cursor: zoom-in');
  });
});

/**
 * Gives the graph's frame a size for one test (happy-dom lays nothing
 * out): only the element carrying data-graph-viewport is resized.
 */
function sizeViewport(width: number, height: number): () => void {
  return stubSize('data-graph-viewport', 'clientWidth', 'clientHeight', {
    width,
    height,
  });
}

/** Gives the lock strip a size for one test. */
function stubStrip(width: number, height: number): () => void {
  return stubSize('data-graph-lock-strip', 'offsetWidth', 'offsetHeight', {
    width,
    height,
  });
}

function stubSize(
  attr: string,
  widthKey: 'clientWidth' | 'offsetWidth',
  heightKey: 'clientHeight' | 'offsetHeight',
  size: { width: number; height: number }
): () => void {
  const proto = HTMLElement.prototype;
  const saved = {
    width: Object.getOwnPropertyDescriptor(proto, widthKey),
    height: Object.getOwnPropertyDescriptor(proto, heightKey),
  };
  const fallback = (
    descriptor: PropertyDescriptor | undefined,
    el: HTMLElement
  ): number => (descriptor?.get?.call(el) as number | undefined) ?? 0;
  Object.defineProperty(proto, widthKey, {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute(attr) ? size.width : fallback(saved.width, this);
    },
  });
  Object.defineProperty(proto, heightKey, {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute(attr)
        ? size.height
        : fallback(saved.height, this);
    },
  });
  return () => {
    for (const [key, descriptor] of [
      [widthKey, saved.width],
      [heightKey, saved.height],
    ] as const) {
      if (descriptor === undefined) Reflect.deleteProperty(proto, key);
      else Object.defineProperty(proto, key, descriptor);
    }
  };
}
