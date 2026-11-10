import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { memo, Profiler } from 'react';
import { renderToString } from 'react-dom/server';

import {
  Register,
  RegisterCell,
  type RegisterProps,
  RegisterRow,
} from '../src/index';

// Register's opt-in row windowing (`windowed`, through use-row-windows.ts).
// happy-dom has no layout, so the geometry the windows read is stubbed: a
// 600px scroller, the register's 34px header row, then rows of `rowPx`
// each, laid out from the row's index and the scroller's scrollTop.
// Everything else (focus, keys, the list's markup) is the real DOM.

const HEAD = 34;
const VIEW = 600;
let rowPx = 57;
/** How many rows the register under test holds (set by Runs). */
let total = 0;
let scroller: HTMLElement | null = null;

/** `r0042` → 42. */
const rowId = (i: number) => `r${String(i).padStart(4, '0')}`;
/** A row's index from the number its id ends with (`r0042`, `run:r0042`). */
const indexOf = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? Number.NaN);

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    toJSON: () => undefined,
  } as DOMRect;
}

function theScroller(): HTMLElement {
  if (scroller === null) throw new Error('no scroller');
  return scroller;
}

/** The stubbed layout: the scroller, the register's list and its rows (a
    gap is never asked: the windows read rows and lists only). */
function layoutRect(el: Element): DOMRect | null {
  if (scroller === null) return null;
  const top = HEAD - scroller.scrollTop;
  if (el === scroller) return rect(0, VIEW);
  if (
    el.tagName === 'UL' &&
    el.parentElement?.hasAttribute('data-stack') === true
  ) {
    return rect(top, total * rowPx);
  }
  const id = el.getAttribute('data-row-id');
  if (el.tagName === 'LI' && id !== null) {
    return rect(top + indexOf(id) * rowPx, rowPx);
  }
  return null;
}

// ResizeObserver, stubbed so a test can say the register changed width.
type ResizeCallback = (entries: { contentRect: { width: number } }[]) => void;
const observers = new Set<ResizeCallback>();
class StubResizeObserver {
  private readonly callback: ResizeCallback;
  constructor(callback: ResizeCallback) {
    this.callback = callback;
  }
  observe() {
    observers.add(this.callback);
  }
  disconnect() {
    observers.delete(this.callback);
  }
  unobserve() {
    observers.delete(this.callback);
  }
}
function resizeTo(width: number) {
  act(() => {
    for (const callback of observers) callback([{ contentRect: { width } }]);
  });
}

const originalRect = Element.prototype.getBoundingClientRect;
const originalObserver = globalThis.ResizeObserver;
// Another test file may have left an own getBoundingClientRect on the list
// prototype (a stub restored by assignment), which would shadow the stub
// on Element.prototype: it is stubbed there too, and put back as found.
const listOwnRect = Object.getOwnPropertyDescriptor(
  HTMLUListElement.prototype,
  'getBoundingClientRect'
);
function stubbedRect(this: Element): DOMRect {
  return layoutRect(this) ?? originalRect.call(this);
}
beforeEach(() => {
  Element.prototype.getBoundingClientRect = stubbedRect;
  HTMLUListElement.prototype.getBoundingClientRect = stubbedRect;
  globalThis.ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;
  const el = document.createElement('div');
  el.style.overflowY = 'auto';
  el.style.height = `${VIEW}px`;
  document.body.appendChild(el);
  scroller = el;
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  if (listOwnRect === undefined) {
    Reflect.deleteProperty(HTMLUListElement.prototype, 'getBoundingClientRect');
  } else {
    Object.defineProperty(
      HTMLUListElement.prototype,
      'getBoundingClientRect',
      listOwnRect
    );
  }
  globalThis.ResizeObserver = originalObserver;
  observers.clear();
  scroller?.remove();
  scroller = null;
  rowPx = 57;
});

// A run row as Runs draws it: a memoized host component around one
// RegisterRow, its stretched button, then an Archive button in a cell.
const Row = memo(function Row({ i }: { i: number }) {
  return (
    <RegisterRow
      onActivate={() => undefined}
      rowLabel={`Run ${i}`}
      data-row="run"
    >
      <RegisterCell label="Agent" variant="name">
        Run {i}
      </RegisterCell>
      <RegisterCell align="end">
        <button type="button">Archive {i}</button>
      </RegisterCell>
    </RegisterRow>
  );
});

function Runs({ count, ...rest }: { count: number } & Partial<RegisterProps>) {
  total = count;
  return (
    <Register
      label="Agents"
      columns="1fr auto"
      header={[
        { id: 'agent', label: 'Agent' },
        { id: 'actions', label: '', align: 'end' },
      ]}
      {...rest}
    >
      {Array.from({ length: count }, (_, i) => (
        <Row key={rowId(i)} i={i} />
      ))}
    </Register>
  );
}

function renderIn(ui: Parameters<typeof render>[0]) {
  return render(ui, { container: theScroller() });
}

/** Sets the scroller's offset and tells the register (happy-dom fires no
    scroll event of its own). */
function scrollTo(top: number) {
  const el = theScroller();
  act(() => {
    el.scrollTop = top;
    fireEvent.scroll(el);
  });
}

const mountedIds = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('li[data-row-id]')).map(
    (li) => li.getAttribute('data-row-id') ?? ''
  );

/** The height the list stands at: its gaps plus its mounted rows. */
function listHeight(root: HTMLElement): number {
  const ul = root.querySelector('ul');
  if (ul === null) throw new Error('no list');
  let px = 0;
  for (const li of Array.from(ul.children)) {
    if (li.hasAttribute('data-row-id')) px += rowPx;
    else if (li.hasAttribute('data-row-gap')) {
      px += Number.parseFloat((li as HTMLElement).style.height);
    }
  }
  return px;
}

function rowButton(view: ReturnType<typeof render>, i: number) {
  return view.getByRole('button', { name: `Run ${i}` });
}

describe('Register row windowing', () => {
  test('off by default: every row is drawn, with no window markup', () => {
    const view = renderIn(<Runs count={300} />);
    const ul = view.container.querySelector('ul');
    expect(ul?.children.length).toBe(300);
    expect(view.container.querySelector('[data-row-gap]')).toBeNull();
    expect(view.container.querySelector('[data-row-id]')).toBeNull();
    expect(view.container.querySelector('[aria-setsize]')).toBeNull();
    expect(view.container.querySelector('[data-windowed]')).toBeNull();
  });

  test('windowed at or below windowAbove still draws every row', () => {
    const view = renderIn(<Runs count={150} windowed />);
    expect(view.container.querySelector('ul')?.children.length).toBe(150);
    expect(view.container.querySelector('[data-row-gap]')).toBeNull();
    expect(view.container.querySelector('[aria-setsize]')).toBeNull();
  });

  test('2,000 windowed rows mount only the rows near the viewport', () => {
    const view = renderIn(<Runs count={2000} windowed />);
    const ids = mountedIds(view.container);
    // 600px of rows plus eight rows of overscan below.
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.length).toBeLessThan(40);
    expect(ids[0]).toBe('r0000');
    expect(
      view.container.querySelector('[data-windowed="true"]')
    ).not.toBeNull();
    // The list stands at its full height: the mounted rows plus the gap.
    expect(listHeight(view.container)).toBe(2000 * rowPx);
    const gap = view.container.querySelector('li[data-row-gap]');
    expect(gap?.getAttribute('role')).toBe('presentation');
    expect(gap?.getAttribute('aria-hidden')).toBe('true');
    expect(gap?.getAttribute('data-row-gap')).toBe(String(2000 - ids.length));
    // Each mounted row says its place among all the rows, and keeps the
    // host's hooks.
    const first = view.container.querySelector('li[data-row-id="r0000"]');
    expect(first?.getAttribute('aria-posinset')).toBe('1');
    expect(first?.getAttribute('aria-setsize')).toBe('2000');
    expect(first?.getAttribute('data-row')).toBe('run');
    expect(view.getByRole('list', { name: 'Agents' })).toBeTruthy();
  });

  test('scrolling mounts the rows at the new offset and unmounts the old', () => {
    const view = renderIn(<Runs count={2000} windowed />);
    scrollTo(1000 * rowPx);
    const ids = mountedIds(view.container);
    expect(ids).toContain('r1000');
    expect(ids).toContain('r1005');
    expect(ids).not.toContain('r0000');
    expect(ids.length).toBeLessThan(50);
    expect(listHeight(view.container)).toBe(2000 * rowPx);
    expect(view.container.querySelectorAll('li[data-row-gap]').length).toBe(2);
    const row = view.container.querySelector('li[data-row-id="r1000"]');
    expect(row?.getAttribute('aria-posinset')).toBe('1001');
  });

  test('a scroll offset restored before mount draws the rows there', () => {
    const el = theScroller();
    el.scrollTop = 1200 * rowPx;
    const view = renderIn(<Runs count={2000} windowed />);
    const ids = mountedIds(view.container);
    expect(ids).toContain('r1200');
    expect(ids).not.toContain('r0000');
    // Unmounted and mounted again at the same offset (leaving the view and
    // coming back), the same rows are drawn.
    view.unmount();
    const again = render(<Runs count={2000} windowed />, {
      container: el.appendChild(document.createElement('div')),
    });
    expect(mountedIds(again.container)).toEqual(ids);
  });

  test('the focused row stays mounted and focused while the list scrolls away', () => {
    const view = renderIn(<Runs count={2000} windowed />);
    const button = rowButton(view, 3);
    act(() => button.focus());
    scrollTo(1500 * rowPx);
    expect(mountedIds(view.container)).toContain('r0003');
    expect(mountedIds(view.container)).toContain('r1500');
    expect(document.activeElement).toBe(button);
    // Focus left for the page: the row is let go at the next scroll.
    act(() => button.blur());
    scrollTo(1501 * rowPx);
    expect(mountedIds(view.container)).not.toContain('r0003');
  });

  test('Tab from a kept row crosses the gap to the next row', () => {
    const view = renderIn(<Runs count={2000} windowed />);
    const archive = view.getByRole('button', { name: 'Archive 3' });
    act(() => archive.focus());
    scrollTo(1500 * rowPx);
    // Its next row is a gap now: Tab mounts it, scrolls to it and focuses
    // its first stop (the row's own button), rather than leaving the list.
    expect(mountedIds(view.container)).not.toContain('r0004');
    const tab = fireEvent.keyDown(archive, { key: 'Tab' });
    expect(tab).toBe(false);
    expect(document.activeElement).toBe(rowButton(view, 4));
    expect(theScroller().scrollTop).toBeLessThan(10 * rowPx);
  });

  test('Shift+Tab from a kept row crosses the gap back to its last stop', () => {
    const view = renderIn(<Runs count={2000} windowed />);
    scrollTo(1000 * rowPx);
    const button = rowButton(view, 1003);
    act(() => button.focus());
    scrollTo(0);
    expect(mountedIds(view.container)).not.toContain('r1002');
    const tab = fireEvent.keyDown(button, { key: 'Tab', shiftKey: true });
    expect(tab).toBe(false);
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Archive 1002' })
    );
  });

  test('Tab inside a row, or to a mounted neighbour, is the browser’s', () => {
    const view = renderIn(<Runs count={2000} windowed />);
    // Not the row's last stop: the next stop is in the same row.
    const button = rowButton(view, 3);
    expect(fireEvent.keyDown(button, { key: 'Tab' })).toBe(true);
    // The last stop, with the next row mounted: nothing to do.
    const archive = view.getByRole('button', { name: 'Archive 3' });
    expect(fireEvent.keyDown(archive, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(button, { key: 'Tab', shiftKey: true })).toBe(
      true
    );
  });

  test('a width change that reflows the rows (stacked cards) re-measures them', () => {
    const view = renderIn(<Runs count={2000} windowed stackWithin={600} />);
    resizeTo(800);
    const wide = mountedIds(view.container).length;
    expect(listHeight(view.container)).toBe(2000 * rowPx);
    // The register narrows past its stackWithin step: every row becomes a
    // taller card without a window resize or a scroll.
    rowPx = 140;
    resizeTo(560);
    const narrow = mountedIds(view.container).length;
    expect(narrow).toBeLessThan(wide);
    // Every height is the cards' now, mounted rows and gaps alike.
    expect(listHeight(view.container)).toBe(2000 * rowPx);
  });

  test('the server render draws the first rows and one gap for the rest', () => {
    const html = renderToString(<Runs count={2000} windowed />);
    expect(html.match(/data-row-id=/g)?.length).toBe(60);
    expect(html.match(/data-row-gap="1940"/g)?.length).toBe(1);
    expect(html).toContain('aria-setsize="2000"');
  });
});

// A run row, or (bare) a row with nothing to Tab to: a conversation
// agent's row on Runs has no link and no button.
const MixedRow = memo(function MixedRow({
  i,
  bare,
}: {
  i: number;
  bare: boolean;
}) {
  return bare ? (
    <RegisterRow>
      <RegisterCell label="Agent" variant="name">
        Session {i}
      </RegisterCell>
    </RegisterRow>
  ) : (
    <Row i={i} />
  );
});

function Mixed({
  count,
  bare,
  keyOf = rowId,
}: {
  count: number;
  bare: (i: number) => boolean;
  keyOf?: (i: number) => string;
}) {
  total = count;
  return (
    <>
      <button type="button">Before</button>
      <Register label="Agents" columns="1fr auto" windowed>
        {Array.from({ length: count }, (_, i) => (
          <MixedRow key={keyOf(i)} i={i} bare={bare(i)} />
        ))}
      </Register>
      <button type="button">After</button>
    </>
  );
}

describe('Register row windowing: ids, places and Tab', () => {
  test('data-row-id is the key the host wrote, ":" and "=" included', () => {
    const keyOf = (i: number) => `run:${rowId(i)}`;
    const view = renderIn(
      <Mixed count={2000} bare={() => false} keyOf={keyOf} />
    );
    expect(mountedIds(view.container).slice(0, 2)).toEqual([
      'run:r0000',
      'run:r0001',
    ]);
    // The id selects its row, and pins and Tab work by it.
    const archive = view.getByRole('button', { name: 'Archive 3' });
    act(() => archive.focus());
    scrollTo(1500 * rowPx);
    expect(
      view.container.querySelector('li[data-row-id="run:r0003"]')
    ).not.toBeNull();
    expect(document.activeElement).toBe(archive);
    expect(fireEvent.keyDown(archive, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(rowButton(view, 4));
    // "=" comes back as written too (React escapes it as "=0").
    const html = renderToString(
      <Mixed count={200} bare={() => false} keyOf={(i) => `a=b:${rowId(i)}`} />
    );
    expect(html).toContain('data-row-id="a=b:r0000"');
    expect(html).not.toContain('=0b');
  });

  test('rows given as two arrays keep their keys, and a key both use stays unique', () => {
    // 30 runs then 130 sessions (160 rows, so windowed); the server draws
    // the first 60. The second list's first key repeats the first's.
    const html = renderToString(
      <Register label="Agents" columns="1fr" windowed>
        {Array.from({ length: 30 }, (_, i) => (
          <Row key={`run:${rowId(i)}`} i={i} />
        ))}
        {Array.from({ length: 130 }, (_, i) => (
          <Row key={i === 0 ? 'run:r0000' : `session:${rowId(i)}`} i={i} />
        ))}
      </Register>
    );
    const ids = [...html.matchAll(/data-row-id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(60);
    expect(ids[0]).toBe('run:r0000');
    expect(ids[29]).toBe('run:r0029');
    expect(ids[31]).toBe('session:r0001');
    // The repeated key falls back to React's own, unique key.
    expect(ids[30]).not.toBe('run:r0000');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('rows of a register nested in a windowed row take no outer place', () => {
    total = 200;
    const view = renderIn(
      <Register label="Agents" columns="1fr" windowed>
        {Array.from({ length: 200 }, (_, i) =>
          i === 0 ? (
            <RegisterRow key={rowId(i)}>
              <RegisterCell span="row">
                <Register label="Inner" columns="1fr">
                  <RegisterRow>
                    <RegisterCell>a</RegisterCell>
                  </RegisterRow>
                  <RegisterRow>
                    <RegisterCell>b</RegisterCell>
                  </RegisterRow>
                </Register>
              </RegisterCell>
            </RegisterRow>
          ) : (
            <Row key={rowId(i)} i={i} />
          )
        )}
      </Register>
    );
    const outer = view.container.querySelector('li[data-row-id="r0000"]');
    expect(outer?.getAttribute('aria-posinset')).toBe('1');
    const inner = view.getByRole('list', { name: 'Inner' });
    const rows = Array.from(inner.querySelectorAll('li'));
    expect(rows.length).toBe(2);
    for (const li of rows) {
      expect(li.getAttribute('data-row-id')).toBeNull();
      expect(li.getAttribute('aria-posinset')).toBeNull();
      expect(li.getAttribute('aria-setsize')).toBeNull();
    }
  });

  test('crossing windowAbove keeps every row mounted, and the focus', () => {
    const view = renderIn(<Runs count={150} windowed />);
    const archive = view.getByRole('button', { name: 'Archive 3' });
    act(() => archive.focus());
    view.rerender(<Runs count={151} windowed />);
    expect(
      view.container.querySelector('[data-windowed="true"]')
    ).not.toBeNull();
    expect(archive.isConnected).toBe(true);
    expect(document.activeElement).toBe(archive);
    view.rerender(<Runs count={150} windowed />);
    expect(view.container.querySelector('[data-windowed]')).toBeNull();
    expect(archive.isConnected).toBe(true);
    expect(document.activeElement).toBe(archive);
    // Not windowing, the rows carry no place.
    expect(view.container.querySelector('[aria-setsize]')).toBeNull();
  });

  test('Tab across a gap passes over rows with no Tab stop', () => {
    const view = renderIn(
      <Mixed count={2000} bare={(i) => i >= 4 && i <= 6} />
    );
    const archive = view.getByRole('button', { name: 'Archive 3' });
    act(() => archive.focus());
    scrollTo(1500 * rowPx);
    expect(fireEvent.keyDown(archive, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(rowButton(view, 7));
  });

  test('a run of bare rows longer than the window is crossed gap by gap', () => {
    const view = renderIn(
      <Mixed count={2000} bare={(i) => i >= 4 && i <= 60} />
    );
    const archive = view.getByRole('button', { name: 'Archive 3' });
    act(() => archive.focus());
    scrollTo(1500 * rowPx);
    expect(fireEvent.keyDown(archive, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(rowButton(view, 61));
    expect(mountedIds(view.container)).toContain('r0061');
  });

  test('with no stop left in the list, Tab leaves it as the browser would', () => {
    const view = renderIn(
      <Mixed count={2000} bare={(i) => i >= 1990 || i <= 9} />
    );
    scrollTo(1985 * rowPx);
    const archive = view.getByRole('button', { name: 'Archive 1989' });
    act(() => archive.focus());
    scrollTo(0);
    expect(fireEvent.keyDown(archive, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'After' })
    );
    // And back: Shift+Tab from the first row with stops, the rows above it
    // bare, reaches the control before the list.
    scrollTo(5 * rowPx);
    const first = rowButton(view, 10);
    act(() => first.focus());
    scrollTo(1500 * rowPx);
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(
      false
    );
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Before' })
    );
  });

  test('a window that moves re-renders none of the rows it keeps', () => {
    const renders = new Map<string, number>();
    const count = (id: string) => {
      renders.set(id, (renders.get(id) ?? 0) + 1);
    };
    // Each host row wraps its RegisterRow in a Profiler, which reports
    // every render inside it: a new place object would re-render the
    // RegisterRow under the memoized host row.
    const Counted = memo(function Counted({ i }: { i: number }) {
      return (
        <Profiler id={rowId(i)} onRender={count}>
          <RegisterRow rowLabel={`Run ${i}`} onActivate={() => undefined}>
            <RegisterCell>Run {i}</RegisterCell>
          </RegisterRow>
        </Profiler>
      );
    });
    function Host() {
      total = 2000;
      return (
        <Register label="Agents" columns="1fr" windowed>
          {Array.from({ length: 2000 }, (_, i) => (
            <Counted key={rowId(i)} i={i} />
          ))}
        </Register>
      );
    }
    const view = renderIn(<Host />);
    const first = mountedIds(view.container);
    expect(first).toContain('r0012');
    const before = renders.get('r0012') ?? 0;
    expect(before).toBeGreaterThan(0);
    // A scroll of a few rows moves the window (rows mount below it) while
    // row 12 stays drawn at the same place.
    scrollTo(4 * rowPx);
    const moved = mountedIds(view.container);
    expect(moved).toContain('r0012');
    expect(moved.length).toBeGreaterThan(first.length);
    expect(renders.get('r0012')).toBe(before);
  });
});
