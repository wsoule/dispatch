import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import {
  TaskGroupTable,
  type TaskGroupTableProps,
  type TaskRowData,
  type TaskSectionData,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';

// TaskGroupTable's row windowing (use-row-windows.ts). happy-dom has no
// layout, so the geometry the windows read is stubbed: a 600px scroller,
// a 32px column header, 40px group headers and 55px rows, laid out from
// the data and the scroller's scrollTop, with folded groups taking no
// room. Everything else (focus, keys, selection, folds) is the real DOM.

const ROW = 55;
const HEAD = 32;
const GROUP_HEAD = 40;
const VIEW = 600;

function HostLink({ children, ...rest }: UiLinkProps) {
  return <a {...rest}>{children}</a>;
}

/** `g2` → group 2; `r2-017` → row 17 of group 2. */
const rowId = (g: number, i: number) => `r${g}-${String(i).padStart(3, '0')}`;
function parseRowId(id: string): { g: number; i: number } | null {
  const m = /^r(\d+)-(\d+)$/.exec(id);
  return m === null ? null : { g: Number(m[1]), i: Number(m[2]) };
}

function row(g: number, i: number): TaskRowData {
  const id = rowId(g, i);
  return {
    id,
    key: id.toUpperCase(),
    title: `Issue ${id}`,
    href: `/issues/${id}`,
    project: 'Atlas',
    state: 'Todo',
    stateKind: 'unstarted',
    priority: 3,
    priorityLabel: 'Medium',
    due: 'Oct 23',
  };
}

function sections(groups: number, rowsPer: number): TaskSectionData[] {
  return [
    {
      id: 'all',
      groups: Array.from({ length: groups }, (_, g) => ({
        id: `g${g}`,
        title: `Group ${g}`,
        rows: Array.from({ length: rowsPer }, (_, i) => row(g, i)),
      })),
    },
  ];
}

// ---- the stubbed layout -------------------------------------------------

let scroller: HTMLElement | null = null;
let rowsPerGroup = 200;

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

/** Each group's list top in the scroller's content, in document order: the
    column header, then per group its header and (unless folded) its rows. */
function listTops(): Map<Element, number> {
  const tops = new Map<Element, number>();
  let y = HEAD;
  const lists = Array.from(document.querySelectorAll('[data-collapsed] > ul'));
  for (const ul of lists) {
    y += GROUP_HEAD;
    tops.set(ul, y);
    if (!(ul as HTMLElement).hidden) y += rowsPerGroup * ROW;
  }
  return tops;
}

function layoutRect(el: Element): DOMRect | null {
  if (scroller === null) return null;
  const scrollTop = scroller.scrollTop;
  if (el === scroller) return rect(0, VIEW);
  const root = scroller.querySelector('[role="group"][aria-label]');
  if (root !== null && el === root.children[1]) {
    // The sticky column header, stuck at the scroller's top.
    return rect(0, HEAD);
  }
  if (el.tagName === 'UL') {
    const top = listTops().get(el);
    if (top === undefined) return null;
    return rect(top - scrollTop, rowsPerGroup * ROW);
  }
  if (el.getAttribute('data-nav-item') === 'group') {
    // A group's header row sits right above its list.
    const ul = el.parentElement?.querySelector(':scope > ul');
    const top =
      ul === null || ul === undefined ? undefined : listTops().get(ul);
    if (top === undefined) return null;
    return rect(top - GROUP_HEAD - scrollTop, GROUP_HEAD);
  }
  const id = el.getAttribute('data-row-id');
  if (el.tagName === 'LI' && id !== null) {
    const at = parseRowId(id);
    const ul = el.parentElement;
    const top = ul === null ? undefined : listTops().get(ul);
    if (at === null || top === undefined) return null;
    return rect(top + at.i * ROW - scrollTop, ROW);
  }
  return null;
}

const originalRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return layoutRect(this) ?? originalRect.call(this);
  };
  // The scroll container exists before the table mounts (as a host's does),
  // so the table's first measurement reads it.
  const el = document.createElement('div');
  el.style.overflowY = 'auto';
  el.style.height = `${VIEW}px`;
  document.body.appendChild(el);
  scroller = el;
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  scroller?.remove();
  scroller = null;
  rowsPerGroup = 200;
});

/** Renders into the scroll container. */
function renderIn(ui: Parameters<typeof render>[0]) {
  if (scroller === null) throw new Error('no scroller');
  return render(ui, { container: scroller });
}

/** Sets the scroller's offset and tells the table (happy-dom fires no
    scroll event of its own). */
function scrollTo(top: number) {
  if (scroller === null) throw new Error('no scroller');
  act(() => {
    scroller!.scrollTop = top;
    fireEvent.scroll(scroller!);
  });
}

/** Where row `i` of group `g` starts in the content (no group folded). */
const rowTop = (g: number, i: number) =>
  HEAD + (g + 1) * GROUP_HEAD + g * rowsPerGroup * ROW + i * ROW;

// ---- the host -----------------------------------------------------------

type Props = Partial<TaskGroupTableProps>;

function Host({
  data,
  initial = [],
  onSelection,
  selectable = false,
  ...rest
}: Props & {
  data: TaskSectionData[];
  initial?: string[];
  onSelection?: (ids: string[]) => void;
  selectable?: boolean;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initial)
  );
  return (
    <UiLinkProvider link={HostLink}>
      <TaskGroupTable
        sections={data}
        label="Issues"
        {...rest}
        selection={
          selectable
            ? {
                selected,
                onChange: (next) => {
                  setSelected(next);
                  onSelection?.([...next].sort());
                },
              }
            : undefined
        }
      />
    </UiLinkProvider>
  );
}

function renderBig(
  props: Props & {
    selectable?: boolean;
    onSelection?: (ids: string[]) => void;
  } = {}
) {
  return renderIn(<Host data={sections(5, 200)} {...props} />);
}

const mountedIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('li[data-row-id]')).map(
    (li) => li.getAttribute('data-row-id') ?? ''
  );

/** The height a group's list stands at: its gaps plus its mounted rows. */
function listHeight(container: HTMLElement, groupId: string): number {
  const ul = container.querySelector(`[data-group-id="${groupId}"] > ul`);
  if (ul === null) throw new Error(`no list for ${groupId}`);
  let px = 0;
  for (const li of Array.from(ul.children)) {
    if (li.hasAttribute('data-row-id')) px += ROW;
    else if (li.hasAttribute('data-row-gap')) {
      px += Number.parseFloat((li as HTMLElement).style.height);
    }
  }
  return px;
}

const linkOf = (view: ReturnType<typeof render>, id: string) =>
  view.getByRole('link', { name: `Issue ${id}` });

describe('TaskGroupTable row windowing', () => {
  test('a 1,000-row list mounts only the rows near the viewport', () => {
    const view = renderBig();
    const ids = mountedIds(view.container);
    expect(ids.length).toBeLessThan(100);
    expect(ids.length).toBeGreaterThan(10);
    // Every group keeps its heading and header row…
    for (let g = 0; g < 5; g++) {
      expect(
        view.getByRole('heading', { name: new RegExp(`Group ${g}`) })
      ).toBeTruthy();
      expect(view.getByRole('button', { name: `Group ${g}` })).toBeTruthy();
    }
    // …and stands at its full height: the mounted rows plus the gaps.
    for (let g = 0; g < 5; g++) {
      expect(listHeight(view.container, `g${g}`)).toBe(200 * ROW);
    }
    // Group 0's rows start at its top; the others are one gap each.
    expect(ids[0]).toBe('r0-000');
    expect(ids.every((id) => id.startsWith('r0-'))).toBe(true);
    expect(
      view.container.querySelectorAll('[data-group-id="g1"] li[data-row-id]')
        .length
    ).toBe(0);
    const gap = view.container.querySelector(
      '[data-group-id="g1"] li[data-row-gap]'
    );
    expect(gap?.getAttribute('data-row-gap')).toBe('200');
    expect(gap?.getAttribute('role')).toBe('presentation');
    expect(gap?.getAttribute('aria-hidden')).toBe('true');
    // A windowed row says its place among the group's rows.
    const first = view.container.querySelector('li[data-row-id="r0-000"]');
    expect(first?.getAttribute('aria-posinset')).toBe('1');
    expect(first?.getAttribute('aria-setsize')).toBe('200');
  });

  test('scrolling mounts the rows at the new offset and unmounts the old', () => {
    const view = renderBig();
    scrollTo(rowTop(2, 100) - 100);
    const ids = mountedIds(view.container);
    expect(ids).toContain('r2-100');
    expect(ids).toContain('r2-105');
    expect(ids).not.toContain('r0-000');
    expect(ids).not.toContain('r2-050');
    expect(ids.length).toBeLessThan(100);
    // The gaps before and after keep the list at its height.
    expect(listHeight(view.container, 'g2')).toBe(200 * ROW);
    expect(
      view.container.querySelectorAll('[data-group-id="g2"] li[data-row-gap]')
        .length
    ).toBe(2);
  });

  test('j from the last mounted row reaches the unmounted next row and focuses it after scrolling', () => {
    const view = renderBig();
    const ids = mountedIds(view.container);
    const last = ids[ids.length - 1];
    const at = parseRowId(last)!;
    const next = rowId(at.g, at.i + 1);
    expect(
      view.container.querySelector(`li[data-row-id="${next}"]`)
    ).toBeNull();
    linkOf(view, last).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'j' });
    expect(document.activeElement).toBe(linkOf(view, next));
    expect(scroller!.scrollTop).toBeGreaterThan(0);
    // The row is now mounted and placed in view: ArrowUp walks back.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(linkOf(view, last));
  });

  test('Home and End reach the first toggle and the last row', () => {
    const view = renderBig();
    linkOf(view, 'r0-003').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(linkOf(view, 'r4-199'));
    expect(scroller!.scrollTop).toBeGreaterThan(rowTop(4, 100));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Group 0' })
    );
    expect(scroller!.scrollTop).toBe(0);
    // ↓ from the toggle enters the group's first row again.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(linkOf(view, 'r0-000'));
  });

  test('↑ across a group edge reaches the toggle, then the last row of the group before', () => {
    const view = renderBig();
    scrollTo(rowTop(1, 0) - 300);
    linkOf(view, 'r1-000').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'k' });
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Group 1' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'k' });
    expect(document.activeElement).toBe(linkOf(view, 'r0-199'));
  });

  test('Shift+↓ extends the selection across the window edge', () => {
    const onSelection = mock((_ids: string[]) => {});
    const view = renderBig({ selectable: true, onSelection });
    const ids = mountedIds(view.container);
    const last = ids[ids.length - 1];
    const at = parseRowId(last)!;
    const next = rowId(at.g, at.i + 1);
    linkOf(view, last).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'x' });
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(onSelection.mock.calls.at(-1)?.[0]).toEqual([last, next].sort());
    expect(document.activeElement).toBe(linkOf(view, next));
    expect(
      view.container
        .querySelector(`li[data-row-id="${next}"]`)
        ?.getAttribute('data-selected')
    ).toBe('true');
  });

  test('⌘A selects every shown row, mounted or not', () => {
    const onSelection = mock((_ids: string[]) => {});
    const view = renderBig({ selectable: true, onSelection });
    linkOf(view, 'r0-001').focus();
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'a',
      metaKey: true,
    });
    const all = onSelection.mock.calls.at(-1)?.[0] ?? [];
    expect(all).toHaveLength(1000);
    expect(all).toContain('r4-199');
    // The select-all box reads every shown issue as selected.
    const box = view.getByRole('checkbox', {
      name: 'Select all 1000 shown issues',
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  test('folding a group drops its rows and the space they took', () => {
    const view = renderBig();
    const before = [0, 1, 2, 3, 4].reduce(
      (sum, g) => sum + listHeight(view.container, `g${g}`),
      0
    );
    expect(before).toBe(1000 * ROW);
    fireEvent.click(view.getByRole('button', { name: 'Group 1' }));
    const ul = view.container.querySelector('[data-group-id="g1"] > ul');
    expect((ul as HTMLElement).hidden).toBe(true);
    expect(ul?.children.length).toBe(0);
    const after = [0, 2, 3, 4].reduce(
      (sum, g) => sum + listHeight(view.container, `g${g}`),
      0
    );
    expect(after).toBe(800 * ROW);
    // The fold moved group 2 up: scrolling to where its rows now are
    // mounts them.
    scrollTo(rowTop(2, 20) - 200 * ROW);
    expect(mountedIds(view.container)).toContain('r2-020');
    // Unfolding windows the group again rather than drawing all of it.
    fireEvent.click(view.getByRole('button', { name: 'Group 1' }));
    expect(
      view.container.querySelectorAll('[data-group-id="g1"] li[data-row-id]')
        .length
    ).toBeLessThan(200);
    expect(listHeight(view.container, 'g1')).toBe(200 * ROW);
  });

  test('activeRowId on an unmounted row scrolls it into view', () => {
    const view = renderIn(<Host data={sections(5, 200)} />);
    expect(view.container.querySelector('li[data-row-id="r3-050"]')).toBeNull();
    view.rerender(<Host data={sections(5, 200)} activeRowId="r3-050" />);
    expect(scroller!.scrollTop).toBeGreaterThan(0);
    const li = view.container.querySelector('li[data-row-id="r3-050"]');
    expect(li).not.toBeNull();
    expect(li?.getAttribute('aria-current')).toBe('true');
    // A row already in view moves nothing.
    const at = scroller!.scrollTop;
    view.rerender(<Host data={sections(5, 200)} activeRowId="r3-049" />);
    expect(scroller!.scrollTop).toBe(at);
  });

  test('an open row does not pull the list back while it scrolls away', () => {
    // activeRowId reveals the row when it changes, never on a scroll that
    // moves the windows: the reader scrolls on past the open row.
    const view = renderIn(
      <Host data={sections(5, 200)} activeRowId="r0-005" />
    );
    expect(scroller!.scrollTop).toBe(0);
    scrollTo(rowTop(3, 50));
    expect(scroller!.scrollTop).toBe(rowTop(3, 50));
    expect(
      view.container.querySelector('li[data-row-id="r3-050"]')
    ).not.toBeNull();
    expect(view.container.querySelector('li[data-row-id="r0-005"]')).toBeNull();
    scrollTo(rowTop(4, 10));
    expect(scroller!.scrollTop).toBe(rowTop(4, 10));
  });

  test('dragged rows stay mounted while the list scrolls away', () => {
    const view = renderBig({
      drag: {
        canDrop: () => true,
        onDrop: () => undefined,
        label: (n) => `${n} issues`,
      },
    });
    const grip = view.container.querySelector(
      'li[data-row-id="r0-002"] [draggable="true"]'
    );
    expect(grip).not.toBeNull();
    const data = new Map<string, string>();
    fireEvent.dragStart(grip as Element, {
      dataTransfer: {
        effectAllowed: 'none',
        dropEffect: 'none',
        setData: (type: string, value: string) => data.set(type, value),
        getData: (type: string) => data.get(type) ?? '',
        setDragImage: () => undefined,
      },
    });
    scrollTo(rowTop(3, 0) - 100);
    const ids = mountedIds(view.container);
    expect(ids).toContain('r0-002');
    expect(ids).not.toContain('r0-003');
    expect(ids).toContain('r3-000');
    // The group under the pointer is a drop target as in a small list.
    const target = view.container.querySelector(
      '[data-group-id="g3"][data-collapsed]'
    ) as Element;
    fireEvent.dragOver(target, { dataTransfer: { dropEffect: 'none' } });
    expect(target.getAttribute('data-drop')).toBe('ok');
  });

  test('the focused row stays mounted while the list scrolls away', () => {
    const view = renderBig();
    linkOf(view, 'r0-001').focus();
    scrollTo(rowTop(4, 0) - 100);
    expect(mountedIds(view.container)).toContain('r0-001');
    expect(document.activeElement).toBe(linkOf(view, 'r0-001'));
    // j from there still walks the model: the next row, scrolled back to.
    fireEvent.keyDown(document.activeElement as Element, { key: 'j' });
    expect(document.activeElement).toBe(linkOf(view, 'r0-002'));
    expect(scroller!.scrollTop).toBeLessThan(rowTop(1, 0));
  });

  test('unmounting removes the scroll and resize listeners it added', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const el = scroller!;
    const addEl = el.addEventListener.bind(el);
    const removeEl = el.removeEventListener.bind(el);
    // Only the table's own subscriptions: React's root listeners also land
    // on the container, and the window hears many more events.
    const noted = (type: string) => type === 'scroll' || type === 'resize';
    el.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (noted(type)) added.push(`el:${type}`);
      return (addEl as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof el.addEventListener;
    el.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (noted(type)) removed.push(`el:${type}`);
      return (removeEl as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof el.removeEventListener;
    const addWin = window.addEventListener.bind(window);
    const removeWin = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (noted(type)) added.push(`win:${type}`);
      return (addWin as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (noted(type)) removed.push(`win:${type}`);
      return (removeWin as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.removeEventListener;
    try {
      // Rendered into a child of the scroller, so React's own root
      // listeners (which include scroll) land there and not on the spied
      // element; the overflow search still finds the scroller above it.
      const inner = document.createElement('div');
      el.appendChild(inner);
      const view = render(<Host data={sections(5, 200)} />, {
        container: inner,
      });
      expect(added).toEqual(['el:scroll', 'win:resize']);
      // A rerender that changes nothing about the scroller re-subscribes
      // nothing.
      view.rerender(<Host data={sections(5, 200)} activeRowId="r0-001" />);
      expect(added).toEqual(['el:scroll', 'win:resize']);
      view.unmount();
      expect(removed).toEqual(['el:scroll', 'win:resize']);
    } finally {
      el.addEventListener = addEl;
      el.removeEventListener = removeEl;
      window.addEventListener = addWin;
      window.removeEventListener = removeWin;
    }
  });

  test('at the threshold every row is drawn, with no gap and no position', () => {
    rowsPerGroup = 150;
    const view = renderIn(<Host data={sections(1, 150)} />);
    expect(mountedIds(view.container)).toHaveLength(150);
    expect(view.container.querySelector('[data-row-gap]')).toBeNull();
    expect(
      view.container
        .querySelector('li[data-row-id]')
        ?.hasAttribute('aria-posinset')
    ).toBe(false);
  });

  test('one row over the threshold windows the list', () => {
    rowsPerGroup = 151;
    const view = renderIn(<Host data={sections(1, 151)} />);
    const ids = mountedIds(view.container);
    expect(ids.length).toBeLessThan(151);
    expect(ids.length).toBeGreaterThan(10);
    expect(view.container.querySelector('[data-row-gap]')).not.toBeNull();
    expect(listHeight(view.container, 'g0')).toBe(151 * ROW);
  });

  test('a host may lower the threshold', () => {
    rowsPerGroup = 150;
    const view = renderIn(<Host data={sections(1, 150)} windowAbove={100} />);
    expect(mountedIds(view.container).length).toBeLessThan(150);
  });

  test('scrollParent as a function names the scroller', () => {
    const view = renderIn(
      <Host data={sections(5, 200)} scrollParent={() => scroller} />
    );
    expect(mountedIds(view.container).length).toBeLessThan(100);
    scrollTo(rowTop(2, 100) - 100);
    expect(mountedIds(view.container)).toContain('r2-100');
    expect(mountedIds(view.container)).not.toContain('r0-000');
  });

  test('scrollParent "window" scrolls the document', () => {
    // The (stubbed, 768px) window is the viewport: the first rows mount,
    // the far ones do not, and the scroll goes to the window.
    const view = renderIn(
      <Host data={sections(5, 200)} scrollParent="window" />
    );
    const ids = mountedIds(view.container);
    expect(ids).toContain('r0-000');
    expect(ids.length).toBeLessThan(100);
    expect(ids.every((id) => id.startsWith('r0-'))).toBe(true);
    const scrolled: number[] = [];
    const original = window.scrollBy;
    window.scrollBy = ((_x: number, y: number) => {
      scrolled.push(y);
    }) as typeof window.scrollBy;
    try {
      linkOf(view, 'r0-000').focus();
      fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
      expect(scrolled.length).toBe(1);
      expect(scrolled[0]).toBeGreaterThan(rowTop(4, 100));
      expect(scroller!.scrollTop).toBe(0);
    } finally {
      window.scrollBy = original;
    }
  });
});
