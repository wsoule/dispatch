import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  Checklist,
  type ChecklistItem,
  type DeadlineGroup,
  DeadlineList,
  ProgressRule,
  Register,
  RegisterCell,
  RegisterRow,
  type StatCell,
  StatsStrip,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';
import { cssRule, readCss } from './contrast-helpers';

afterEach(cleanup);

function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

describe('StatsStrip', () => {
  test('renders label, mono value and note per cell with its tone', () => {
    const { getByRole, getAllByRole } = render(
      <StatsStrip
        label="This week"
        cells={[
          { id: 'open', label: 'Open issues', value: 7, note: 'of 12' },
          {
            id: 'over',
            label: 'Overdue milestones',
            value: 1,
            note: 'Atlas',
            tone: 'danger',
          },
          { id: 'quiet', label: 'Archived', value: 0, tone: 'muted' },
        ]}
      />
    );
    expect(getByRole('list', { name: 'This week' })).toBeTruthy();
    const cells = getAllByRole('listitem');
    expect(cells.map((c) => c.getAttribute('data-tone'))).toEqual([
      'default',
      'danger',
      'muted',
    ]);
    expect(cells[1].textContent).toBe('Overdue milestones1Atlas');
  });

  test('linked cells route through the host link', () => {
    const { getByRole } = render(
      <UiLinkProvider link={HostLink}>
        <StatsStrip
          cells={[{ id: 'o', label: 'Overdue', value: 2, href: '/timeline' }]}
        />
      </UiLinkProvider>
    );
    const link = getByRole('link');
    expect(link.getAttribute('href')).toBe('/timeline');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    expect(link.textContent).toBe('Overdue2');
  });

  test("a host's data-* reach the list and each cell, a cell's title its inner element", () => {
    const { getByRole, getAllByRole } = render(
      <StatsStrip
        label="Live work"
        data-slot="live-header"
        data-testid="live-stats"
        cells={[
          {
            id: 'queued',
            label: 'Queued',
            value: 3,
            title: 'Waiting for a free agent slot',
            'data-slot': 'live-queued',
          },
          {
            id: 'eta',
            label: 'ETA',
            value: '2h',
            tone: 'warning',
            'data-slot': 'flight-eta',
            // The cell's own tone wins over a host's.
            'data-tone': 'danger',
          },
        ]}
      />
    );
    const list = getByRole('list', { name: 'Live work' });
    expect(list.getAttribute('data-slot')).toBe('live-header');
    expect(list.getAttribute('data-testid')).toBe('live-stats');
    const [queued, eta] = getAllByRole('listitem');
    expect(queued?.getAttribute('data-slot')).toBe('live-queued');
    // The hint sits on the cell's inner element, never on the <li>: a
    // listitem's title would become its whole accessible name and bury the
    // key ("Queued") under the hint.
    expect(queued?.hasAttribute('title')).toBe(false);
    expect(queued?.firstElementChild?.getAttribute('title')).toBe(
      'Waiting for a free agent slot'
    );
    expect(eta?.getAttribute('data-slot')).toBe('flight-eta');
    expect(eta?.getAttribute('data-tone')).toBe('warning');
    expect(eta?.hasAttribute('title')).toBe(false);
    expect(eta?.firstElementChild?.hasAttribute('title')).toBe(false);
  });

  test("a linked cell's title is on its link, which keeps its words as its name", () => {
    const { getByRole, getAllByRole } = render(
      <StatsStrip
        cells={[
          {
            id: 'overdue',
            label: 'Overdue',
            value: 2,
            href: '/timeline',
            title: 'Milestones past their target date',
          },
        ]}
      />
    );
    const [cell] = getAllByRole('listitem');
    expect(cell?.hasAttribute('title')).toBe(false);
    const link = getByRole('link', { name: 'Overdue 2' });
    expect(link.getAttribute('title')).toBe(
      'Milestones past their target date'
    );
  });

  test('without data-* or title it adds no attribute', () => {
    const { getByRole, getAllByRole } = render(
      <StatsStrip cells={[{ id: 'open', label: 'Open', value: 7 }]} />
    );
    const hooks = (el: Element | undefined) =>
      (el?.getAttributeNames() ?? []).filter(
        (name) => name.startsWith('data-') || name === 'title'
      );
    expect(hooks(getByRole('list', { name: 'Summary' }))).toEqual([]);
    expect(hooks(getAllByRole('listitem')[0])).toEqual(['data-tone']);
  });
});

describe('StatsStrip variant="compact"', () => {
  const file = 'tasks/stats-strip.module.css';

  test('the same list, terms, tones and hooks, without the grid sizing', () => {
    const { getByRole, getAllByRole } = render(
      <StatsStrip
        variant="compact"
        label="Live"
        data-slot="live-header"
        cells={[
          {
            id: 'slots',
            label: 'Slots',
            value: (
              <ProgressRule
                done={3}
                total={4}
                aria-label="Agent slots"
                valueText="3 of 4 slots in use"
              />
            ),
          },
          { id: 'running', label: 'Running', value: 2, tone: 'info' },
          {
            id: 'spend',
            label: 'Spend',
            value: '$4.20',
            note: 'today · $8.10 of $60 ceilings',
            title: 'Settled spend',
            'data-slot': 'live-spend',
          },
        ]}
      />
    );
    const list = getByRole('list', { name: 'Live' });
    expect(list.getAttribute('data-variant')).toBe('compact');
    expect(list.getAttribute('data-slot')).toBe('live-header');
    // No column count or last-cell span: the row is a wrapping flex line.
    expect(list.hasAttribute('style')).toBe(false);
    const cells = getAllByRole('listitem');
    expect(cells.map((c) => c.hasAttribute('style'))).toEqual([
      false,
      false,
      false,
    ]);
    expect(cells.map((c) => c.getAttribute('data-tone'))).toEqual([
      'default',
      'info',
      'default',
    ]);
    expect(cells[2]?.textContent).toBe(
      'Spend$4.20today · $8.10 of $60 ceilings'
    );
    expect(cells[2]?.hasAttribute('title')).toBe(false);
    expect(cells[2]?.firstElementChild?.getAttribute('title')).toBe(
      'Settled spend'
    );
    expect(cells[2]?.getAttribute('data-slot')).toBe('live-spend');
    expect(
      getByRole('progressbar', { name: 'Agent slots' }).getAttribute(
        'aria-valuetext'
      )
    ).toBe('3 of 4 slots in use');
  });

  test("compact's data-variant wins over a host's; a panel keeps the host's", () => {
    const { getAllByRole } = render(
      <>
        <StatsStrip
          variant="compact"
          label="Compact"
          data-variant="host"
          cells={[{ id: 'o', label: 'Open', value: 1 }]}
        />
        <StatsStrip
          label="Panel"
          data-variant="host"
          cells={[{ id: 'o', label: 'Open', value: 1 }]}
        />
      </>
    );
    expect(
      getAllByRole('list').map((list) => list.getAttribute('data-variant'))
    ).toEqual(['compact', 'host']);
  });

  test('a linked compact cell routes through the host link', () => {
    const { getByRole } = render(
      <UiLinkProvider link={HostLink}>
        <StatsStrip
          variant="compact"
          cells={[{ id: 'o', label: 'Overdue', value: 2, href: '/timeline' }]}
        />
      </UiLinkProvider>
    );
    const link = getByRole('link');
    expect(link.getAttribute('href')).toBe('/timeline');
    expect(link.hasAttribute('data-host-link')).toBe(true);
  });

  test('one 26px row of inline cells that never wraps, no panel', () => {
    const strip = cssRule(file, '.compact');
    expect(strip).toContain('display: flex;');
    expect(strip).toContain('flex-wrap: nowrap;');
    // As wide as its cells: the scroller around it clips, never the list.
    expect(strip).toContain('width: max-content;');
    expect(strip).toContain('border: 0;');
    expect(strip).toContain('background: none;');
    expect(strip).not.toContain('grid');
    expect(cssRule(file, '.compact .cell')).toContain('flex: none;');
    const inner = cssRule(file, '.compact .inner');
    expect(inner).toContain('flex-flow: row nowrap;');
    expect(inner).toContain('min-height: var(--h-sm);');
    expect(inner).toContain('padding: 0;');
    expect(
      cssRule(file, '.compact .label, .compact .value, .compact .note')
    ).toBe('white-space: nowrap;');
    // The value drops the panel's 22px figure for the body size.
    expect(cssRule(file, '.compact .value')).toContain('font-size: var(--fs);');
    // A meter at least 80px wide: the ProgressRule's 40px track minimum and
    // its receipt. A minimum, not a width, so "16/16" or "100/128" widens
    // the value instead of running past the rule into the next cell.
    expect(cssRule(file, ".compact .value:has([role='progressbar'])")).toBe(
      'min-width: 80px;'
    );
  });

  test('rules are borders centred in the gap; the scroller cuts the first', () => {
    // 8px of air, the rule, 8px of air.
    expect(cssRule(file, '.compact')).toContain('gap: 17px;');
    const rule = cssRule(file, '.compact .cell::before');
    expect(rule).toContain('left: -9px;');
    // A border, not a fill, so forced colours keep it.
    expect(rule).toContain('border-left: 1px solid var(--border);');
    expect(rule).not.toContain('background');
    // The scroller reaches 6px past the frame on both sides: as far as a
    // linked cell's fill, past its focus ring (3 to 5px out), and short of
    // the first cell's rule 9px out.
    const scroller = cssRule(file, '.scroller');
    expect(scroller).toContain('margin: -4px -6px;');
    expect(scroller).toContain('padding: 4px 6px;');
    expect(cssRule(file, '.compact a.inner')).toContain('margin: 0 -6px;');
    expect(cssRule(file, 'a.inner:focus-visible')).toContain(
      'outline-offset: -3px;'
    );
  });

  test('the scroller scrolls sideways with no scrollbar and fades its hidden edges', () => {
    const scroller = cssRule(file, '.scroller');
    expect(scroller).toContain('overflow: auto hidden;');
    expect(scroller).toContain('scrollbar-width: none;');
    expect(scroller).toContain('scroll-padding-inline: 24px;');
    expect(cssRule(file, '.scroller::-webkit-scrollbar')).toBe(
      'display: none;'
    );
    expect(cssRule(file, '.scroller[data-fade-start]')).toBe(
      'mask-image: linear-gradient(to right, transparent, currentcolor 24px);'
    );
    expect(cssRule(file, '.scroller[data-fade-end]')).toBe(
      'mask-image: linear-gradient( to right, currentcolor calc(100% - 24px), transparent );'
    );
    expect(
      cssRule(file, '.scroller[data-fade-start][data-fade-end]')
    ).toContain(
      'transparent, currentcolor 24px, currentcolor calc(100% - 24px), transparent'
    );
    // The frame draws the scroller's ring, outside the mask that would hide it.
    expect(cssRule(file, '.frame:has(> .scroller:focus-visible)')).toBe(
      'outline: 2px solid var(--focus-ring); outline-offset: 1px;'
    );
  });

  test('the end controls share the row, wrapping only below a 12rem strip', () => {
    const row = cssRule(file, '.row');
    expect(row).toContain('display: flex;');
    expect(row).toContain('flex-wrap: wrap;');
    const frame = cssRule(file, '.frame');
    expect(frame).toContain('flex: 1 1 12rem;');
    expect(frame).toContain('min-width: 0;');
    const end = cssRule(file, '.end');
    expect(end).toContain('flex: none;');
    expect(end).toContain('margin-left: auto;');
  });

  test('forced colours give the panel outlined cells', () => {
    const sheet = readCss(file).replace(/\s+/g, ' ');
    expect(sheet).toContain(
      '@media (forced-colors: active) { .strip:not(.compact) .cell { outline: 1px solid CanvasText; } }'
    );
  });

  test('tokens only: no hex in the stylesheet', () => {
    expect(readCss(file)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('StatsStrip variant="compact": end controls and sideways scroll', () => {
  const cells = [
    { id: 'running', label: 'Running', value: 2 },
    { id: 'queued', label: 'Queued', value: 5 },
  ];

  test('end draws the host controls after the list, outside it', () => {
    const { getByRole } = render(
      <StatsStrip
        variant="compact"
        label="Live"
        cells={cells}
        end={<button type="button">Pause all</button>}
      />
    );
    const list = getByRole('list', { name: 'Live' });
    const button = getByRole('button', { name: 'Pause all' });
    expect(list.contains(button)).toBe(false);
    // The list comes first in the row, so the controls read after the counts.
    expect(
      list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // One row holds both: the list's frame and the controls are siblings.
    const row = button.parentElement?.parentElement;
    expect(row?.contains(list)).toBe(true);
  });

  test('no end, null or false draws no controls box', () => {
    for (const end of [undefined, null, false]) {
      const { container, unmount } = render(
        <StatsStrip variant="compact" cells={cells} end={end} />
      );
      // Row > frame only: no second child for the controls.
      expect(container.firstElementChild?.childElementCount).toBe(1);
      unmount();
    }
  });

  test('the panel ignores end and stays a bare list', () => {
    const { container, queryByRole } = render(
      <StatsStrip cells={cells} end={<button type="button">Stop</button>} />
    );
    expect(container.firstElementChild?.tagName).toBe('UL');
    expect(queryByRole('button')).toBeNull();
  });

  test('a strip whose cells fit takes no tab stop, role, name or fade', () => {
    const { getByRole } = render(
      <StatsStrip variant="compact" label="Live" cells={cells} />
    );
    const scroller = getByRole('list', { name: 'Live' }).parentElement;
    for (const name of [
      'tabindex',
      'role',
      'aria-label',
      'data-fade-start',
      'data-fade-end',
    ]) {
      expect(scroller?.hasAttribute(name)).toBe(false);
    }
  });

  // happy-dom lays nothing out (every scroll size is 0), so overflowing
  // cells are faked: 400px of them in a 100px scroller, and a stub
  // ResizeObserver hands the test the callback a resize would fire.
  describe('cells wider than the column', () => {
    const sizes = ['scrollWidth', 'clientWidth'] as const;
    const saved = sizes.map(
      (name): [string, PropertyDescriptor | undefined] => [
        name,
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
      ]
    );
    const savedObserver = globalThis.ResizeObserver;
    let width = 400;
    let observed: Element[] = [];
    let resize: () => void = () => undefined;

    beforeEach(() => {
      width = 400;
      observed = [];
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get: () => width,
      });
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => 100,
      });
      globalThis.ResizeObserver = class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe(target: Element) {
          observed.push(target);
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    });

    afterEach(() => {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(HTMLElement.prototype, name);
        } else {
          Object.defineProperty(HTMLElement.prototype, name, descriptor);
        }
      }
      globalThis.ResizeObserver = savedObserver;
    });

    function scrollTo(scroller: HTMLElement, left: number) {
      Object.defineProperty(scroller, 'scrollLeft', {
        configurable: true,
        value: left,
      });
      fireEvent.scroll(scroller);
    }

    test('the scroller is a focusable group named after the list', () => {
      const { getByRole } = render(
        <StatsStrip variant="compact" label="Live" cells={cells} />
      );
      const group = getByRole('group', { name: 'Live, scrolls sideways' });
      expect(group.getAttribute('tabindex')).toBe('0');
      // The list keeps its own role, name and hooks inside the group.
      const list = getByRole('list', { name: 'Live' });
      expect(list.parentElement).toBe(group);
      expect(list.getAttribute('data-variant')).toBe('compact');
      // Both the column and the cells are watched for size changes.
      expect(observed).toEqual([group, list]);
    });

    test('only the edges that hide cells fade, following the scroll', () => {
      const { getByRole } = render(
        <StatsStrip variant="compact" label="Live" cells={cells} />
      );
      const group = getByRole('group');
      const fades = () => [
        group.hasAttribute('data-fade-start'),
        group.hasAttribute('data-fade-end'),
      ];
      expect(fades()).toEqual([false, true]);
      scrollTo(group, 150);
      expect(fades()).toEqual([true, true]);
      // 300 is as far as it goes (400 - 100): nothing hidden past the end.
      scrollTo(group, 300);
      expect(fades()).toEqual([true, false]);
      scrollTo(group, 0);
      expect(fades()).toEqual([false, true]);
    });

    test('a resize that lets the cells fit drops the tab stop and fades', () => {
      const { getByRole, queryByRole } = render(
        <StatsStrip variant="compact" label="Live" cells={cells} />
      );
      const list = getByRole('list', { name: 'Live' });
      expect(queryByRole('group')).not.toBeNull();
      width = 100;
      act(() => resize());
      expect(queryByRole('group')).toBeNull();
      const scroller = list.parentElement;
      expect(scroller?.hasAttribute('tabindex')).toBe(false);
      expect(scroller?.hasAttribute('data-fade-end')).toBe(false);
      // And back once the column narrows again.
      width = 400;
      act(() => resize());
      expect(scroller?.getAttribute('tabindex')).toBe('0');
    });

    test('a focused strip keeps its tab stop when the cells come to fit, until blur', () => {
      const { getByRole, queryByRole } = render(
        <StatsStrip variant="compact" label="Live" cells={cells} />
      );
      const group = getByRole('group', { name: 'Live, scrolls sideways' });
      act(() => group.focus());
      expect(document.activeElement).toBe(group);
      width = 100;
      act(() => resize());
      // Still a focusable group holding focus: the person keeps their place.
      expect(document.activeElement).toBe(group);
      expect(group.getAttribute('tabindex')).toBe('0');
      expect(group.getAttribute('role')).toBe('group');
      // Nothing is hidden any more, so nothing fades.
      expect(group.hasAttribute('data-fade-end')).toBe(false);
      act(() => group.blur());
      expect(queryByRole('group')).toBeNull();
      expect(group.hasAttribute('tabindex')).toBe(false);
    });

    // A scroller whose scrollLeft can be written, as a browser's can.
    function writableScroll(scroller: HTMLElement, start = 0): () => number {
      let left = start;
      Object.defineProperty(scroller, 'scrollLeft', {
        configurable: true,
        get: () => left,
        set: (value: number) => {
          left = value;
        },
      });
      return () => left;
    }

    // Dispatches a wheel and says whether the page may still act on it.
    // happy-dom's WheelEvent drops the modifier keys a browser's carries
    // (it is a MouseEvent there), so they are set on the event itself.
    function wheel(target: HTMLElement, init: WheelEventInit): boolean {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      for (const key of ['shiftKey', 'ctrlKey'] as const) {
        Object.defineProperty(event, key, { value: init[key] === true });
      }
      return target.dispatchEvent(event);
    }

    test('a vertical wheel scrolls hidden cells sideways, and leaves the page at the ends', () => {
      const { getByRole } = render(
        <StatsStrip variant="compact" label="Live" cells={cells} />
      );
      const group = getByRole('group');
      const left = writableScroll(group);
      // Down moves right and is taken, so the page does not scroll too.
      expect(wheel(group, { deltaY: 120 })).toBe(false);
      expect(left()).toBe(120);
      // Lines (Firefox) count 16px each.
      expect(wheel(group, { deltaY: 3, deltaMode: 1 })).toBe(false);
      expect(left()).toBe(168);
      // Clamped to the end (400 - 100)...
      expect(wheel(group, { deltaY: 500 })).toBe(false);
      expect(left()).toBe(300);
      // ...where a further wheel down scrolls the page instead.
      expect(wheel(group, { deltaY: 120 })).toBe(true);
      expect(left()).toBe(300);
      // Up moves left, until the start lets the page have it again.
      expect(wheel(group, { deltaY: -400 })).toBe(false);
      expect(left()).toBe(0);
      expect(wheel(group, { deltaY: -120 })).toBe(true);
    });

    test("sideways gestures, Shift and pinch zoom stay the browser's", () => {
      const { getByRole } = render(
        <StatsStrip variant="compact" label="Live" cells={cells} />
      );
      const group = getByRole('group');
      const left = writableScroll(group, 50);
      expect(wheel(group, { deltaX: 40, deltaY: 10 })).toBe(true);
      expect(wheel(group, { deltaY: 120, shiftKey: true })).toBe(true);
      expect(wheel(group, { deltaY: 120, ctrlKey: true })).toBe(true);
      expect(left()).toBe(50);
    });

    test('a strip whose cells fit leaves the wheel alone', () => {
      width = 100;
      const { getByRole } = render(
        <StatsStrip variant="compact" label="Live" cells={cells} />
      );
      const scroller = getByRole('list', { name: 'Live' }).parentElement;
      if (scroller === null) throw new Error('no scroller');
      const left = writableScroll(scroller);
      expect(wheel(scroller, { deltaY: 120 })).toBe(true);
      expect(left()).toBe(0);
    });

    test('the panel never measures or takes a tab stop', () => {
      const { container } = render(<StatsStrip label="Panel" cells={cells} />);
      expect(container.querySelector('[tabindex]')).toBeNull();
      expect(observed).toEqual([]);
    });
  });
});

describe('StatsStrip variant="compact" notes="hint"', () => {
  const file = 'tasks/stats-strip.module.css';
  const cells = [
    { id: 'running', label: 'Running', value: 2, title: '2 of 4 slots' },
    {
      id: 'eta',
      label: 'ETA',
      value: '5:05 AM',
      note: '~2h left',
      title: 'The critical path, at 20m a run',
      'data-slot': 'flight-eta',
    },
    {
      id: 'spend',
      label: 'Spend',
      value: '$2.40',
      note: 'of $10',
      title: '$2.40 settled of the $10 ceiling, 2 runs',
      // The title already says the note's facts: the Tooltip says it alone.
      hint: '$2.40 settled of the $10 ceiling, 2 runs',
    },
    { id: 'waves', label: 'Waves', value: 2, note: 'of 3' },
    {
      id: 'overdue',
      label: 'Overdue',
      value: 2,
      note: 'since Monday',
      href: '/timeline',
    },
  ];

  // The words a cell's inner element is described by (hidden text), or null.
  function describedBy(li: Element | undefined): string | null {
    const id = li?.firstElementChild?.getAttribute('aria-describedby');
    if (id === null || id === undefined) return null;
    const words = document.getElementById(id);
    expect(words?.hidden).toBe(true);
    return words?.textContent ?? null;
  }

  // A cell's words on screen: its text without what only assistive tech
  // reads (srOnly) and without its hidden description.
  function shown(node: Node): string {
    if (node instanceof HTMLElement) {
      if (node.hidden || node.classList.contains('srOnly')) return '';
    }
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    return Array.from(node.childNodes).map(shown).join('');
  }

  function inner(li: Element | undefined): HTMLElement {
    const el = li?.firstElementChild;
    if (!(el instanceof HTMLElement)) throw new Error('no cell');
    return el;
  }

  // The tip is aria-hidden (it never joins the cell's text), so the query
  // looks past that.
  function tipText(
    query: (role: 'tooltip', options: { hidden: true }) => HTMLElement | null
  ): string | null {
    return query('tooltip', { hidden: true })?.textContent ?? null;
  }

  // Out of the Tooltip's 400ms warm window, which a tip another test (or a
  // step before) closed would otherwise leave open, showing the next at once.
  function coolDown(): Promise<void> {
    return act(() => new Promise<void>((resolve) => setTimeout(resolve, 450)));
  }

  test("each unlinked cell's note leaves the row and stays in its text, its title the description", () => {
    const { getAllByRole } = render(
      <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
    );
    const items = getAllByRole('listitem');
    expect(items.map(shown)).toEqual([
      'Running2',
      'ETA5:05 AM',
      'Spend$2.40',
      'Waves2',
      // A linked cell keeps its note inline: the host's link takes no Tooltip.
      'Overdue2since Monday',
    ]);
    // The notes are still in the cell's text, so a screen reader reading the
    // list hears them (the title after it is hidden: the description only).
    expect(items.map((li) => li.firstElementChild?.textContent)).toEqual([
      'Running2',
      'ETA5:05 AM~2h left',
      'Spend$2.40of $10',
      'Waves2of 3',
      'Overdue2since Monday',
    ]);
    expect(items.map(describedBy)).toEqual([
      null,
      'The critical path, at 20m a run',
      '$2.40 settled of the $10 ceiling, 2 runs',
      null,
      null,
    ]);
    // A hinted cell is a tab stop with the cue and no native title (its
    // Tooltip shows the words); any other unlinked cell takes no tabindex
    // (a click on it focuses nothing, as on any text) and keeps its title.
    const targets = items.map((li) => li.firstElementChild);
    expect(targets.map((el) => el?.getAttribute('tabindex') ?? null)).toEqual([
      null,
      '0',
      '0',
      '0',
      null,
    ]);
    expect(targets.map((el) => el?.hasAttribute('data-hint'))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(targets.map((el) => el?.getAttribute('title') ?? null)).toEqual([
      '2 of 4 slots',
      null,
      null,
      null,
      null,
    ]);
    // The host's hooks stay on the <li>, never on the hint.
    expect(items[1]?.getAttribute('data-slot')).toBe('flight-eta');
  });

  test("keyboard focus shows the cell's hint at once, read once; blur hides it", () => {
    const { getAllByRole, queryByRole } = render(
      <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
    );
    const items = getAllByRole('listitem');
    const eta = inner(items[1]);
    const described = eta.getAttribute('aria-describedby');
    act(() => eta.focus());
    // No hint of its own: the note, then the title.
    expect(tipText(queryByRole)).toBe(
      '~2h left. The critical path, at 20m a run'
    );
    // Its own hidden title describes it, not the tip's id as well: read once.
    expect(eta.getAttribute('aria-describedby')).toBe(described);
    act(() => eta.blur());
    expect(tipText(queryByRole)).toBeNull();
    // A host's hint is said as it is; a note with no title or hint says itself.
    const spend = inner(items[2]);
    act(() => spend.focus());
    expect(tipText(queryByRole)).toBe(
      '$2.40 settled of the $10 ceiling, 2 runs'
    );
    act(() => inner(items[3]).focus());
    expect(tipText(queryByRole)).toBe('of 3');
  });

  test('a mouse hover shows the hint only after the delay, a touch never does', async () => {
    const { getAllByRole, queryByRole } = render(
      <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
    );
    await coolDown();
    const spend = inner(getAllByRole('listitem')[2]);
    fireEvent.pointerEnter(spend, { pointerType: 'touch' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(tipText(queryByRole)).toBeNull();
    fireEvent.pointerEnter(spend, { pointerType: 'mouse' });
    // Not at once: the Tooltip's 300ms delay.
    expect(tipText(queryByRole)).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(tipText(queryByRole)).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(tipText(queryByRole)).toBe(
      '$2.40 settled of the $10 ceiling, 2 runs'
    );
  });

  test('inline (the default) and the panel keep every note on the row', () => {
    const { getAllByRole } = render(
      <>
        <StatsStrip variant="compact" label="Inline" cells={cells} />
        <StatsStrip label="Panel" notes="hint" cells={cells} />
      </>
    );
    const items = getAllByRole('listitem');
    const onRow = [
      'Running2',
      'ETA5:05 AM~2h left',
      'Spend$2.40of $10',
      'Waves2of 3',
      'Overdue2since Monday',
    ];
    expect(items.map(shown)).toEqual([...onRow, ...onRow]);
    expect(document.querySelector('[data-hint]')).toBeNull();
    expect(document.querySelector('.srOnly')).toBeNull();
    // Inline, an unlinked cell keeps its title as the native hint.
    expect(inner(items[1]).getAttribute('title')).toBe(
      'The critical path, at 20m a run'
    );
  });

  test('on a touch screen (no hover, a coarse pointer) hint keeps the notes on the row', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query === '(hover: none), (pointer: coarse)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const { getAllByRole } = render(
        <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
      );
      expect(getAllByRole('listitem').map(shown)).toEqual([
        'Running2',
        'ETA5:05 AM~2h left',
        'Spend$2.40of $10',
        'Waves2of 3',
        'Overdue2since Monday',
      ]);
      expect(document.querySelector('[data-hint]')).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  // Flight Plan's header puts its notes back on the row when its fan-out ends: the
  // focused cell must keep its element (and focus), not be remounted to <body>.
  test('a cell keeps its element and focus as the strip changes mode', () => {
    const { getAllByRole, queryByRole, rerender } = render(
      <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
    );
    const eta = inner(getAllByRole('listitem')[1]);
    act(() => eta.focus());
    expect(tipText(queryByRole)).not.toBeNull();
    rerender(
      <StatsStrip variant="compact" label="Plan" notes="inline" cells={cells} />
    );
    const after = inner(getAllByRole('listitem')[1]);
    expect(after).toBe(eta);
    expect(document.activeElement).toBe(eta);
    // No longer a tab stop or hinted, but still able to hold the focus it has.
    expect(eta.getAttribute('tabindex')).toBe('-1');
    expect(eta.hasAttribute('data-hint')).toBe(false);
    expect(eta.hasAttribute('aria-describedby')).toBe(false);
    expect(shown(eta)).toBe('ETA5:05 AM~2h left');
    expect(tipText(queryByRole)).toBeNull();
    // Once focus moves on it takes no tabindex, like the cells that never had
    // a hint, so a later click on it focuses nothing.
    act(() => eta.blur());
    expect(eta.hasAttribute('tabindex')).toBe(false);
    // And back: the same element is hinted again.
    rerender(
      <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
    );
    expect(inner(getAllByRole('listitem')[1])).toBe(eta);
    expect(eta.getAttribute('tabindex')).toBe('0');
  });

  // Focus inside a cell (a control in its value, Flight Plan's slots picker) is
  // the control's own: the cell's element stays out of the tab order and never
  // takes a tabindex of its own for it.
  test("focus on a control inside a cell leaves the cell's element alone", () => {
    const withControl: StatCell[] = [
      {
        id: 'running',
        label: 'Running',
        value: <button type="button">2/4</button>,
        note: 'slots',
      },
    ];
    const { getByRole, rerender } = render(
      <StatsStrip
        variant="compact"
        label="Plan"
        notes="hint"
        cells={withControl}
      />
    );
    const button = getByRole('button', { name: '2/4' });
    const cell = button.closest('li')?.firstElementChild;
    act(() => button.focus());
    rerender(
      <StatsStrip
        variant="compact"
        label="Plan"
        notes="inline"
        cells={withControl}
      />
    );
    expect(document.activeElement).toBe(button);
    expect(cell?.hasAttribute('tabindex')).toBe(false);
  });

  // A 300px scroller; each cell 80px wide every 100px (the Spend cell 30px further),
  // moved by the scroll.
  function fakeScroll(items: HTMLElement[]): {
    scroller: HTMLElement;
    left: () => number;
    setLeft: (value: number) => void;
  } {
    const scroller = items[0]?.closest('ul')?.parentElement;
    if (scroller === null || scroller === undefined)
      throw new Error('no scroller');
    let left = 0;
    Object.defineProperty(scroller, 'scrollLeft', {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = value;
      },
    });
    const box = (x: number, width: number) =>
      ({
        left: x,
        right: x + width,
        top: 0,
        bottom: 26,
        width,
        height: 26,
      }) as DOMRect;
    scroller.getBoundingClientRect = () => box(0, 300);
    items.forEach((li, i) => {
      li.getBoundingClientRect = () =>
        box(i * 100 - left + (i === 2 ? 30 : 0), 80);
    });
    return {
      scroller,
      left: () => left,
      setLeft: (value) => {
        left = value;
      },
    };
  }

  // Chromium's own scroll on focus leaves a cell that is only partly hidden alone, so
  // the strip scrolls a cell the keyboard reaches clear of its 24px fades itself.
  test('a cell that takes keyboard focus behind a fade is scrolled clear of it', () => {
    const { getAllByRole } = render(
      <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
    );
    const items = getAllByRole('listitem');
    const strip = fakeScroll(items);
    // The Spend cell sits at 230–310: past the right fade (276). Focus scrolls it to 276.
    const spend = inner(items[2]);
    act(() => spend.focus());
    expect(strip.left()).toBe(34);
    // Back to a cell before the left fade: it is scrolled to 24px from the start.
    strip.setLeft(100);
    act(() => inner(items[1]).focus());
    expect(strip.left()).toBe(76);
    // A cell already clear of both fades stays where it is.
    act(() => spend.focus());
    expect(strip.left()).toBe(76);
  });

  // A press focuses the control it lands on at mousedown; scrolling the strip then
  // would slide it from under the pointer and lose the click (the slots picker's).
  test('focus from a press (not :focus-visible) leaves the strip where it is', () => {
    const { getAllByRole } = render(
      <StatsStrip variant="compact" label="Plan" notes="hint" cells={cells} />
    );
    const items = getAllByRole('listitem');
    const strip = fakeScroll(items);
    const matches = HTMLElement.prototype.matches;
    HTMLElement.prototype.matches = function (this: HTMLElement, selector) {
      return selector === ':focus-visible'
        ? false
        : matches.call(this, selector);
    };
    try {
      fireEvent.pointerDown(inner(items[2]));
      act(() => inner(items[2]).focus());
      expect(strip.left()).toBe(0);
      strip.setLeft(79);
      fireEvent.pointerDown(inner(items[0]));
      act(() => inner(items[0]).focus());
      expect(strip.left()).toBe(79);
    } finally {
      HTMLElement.prototype.matches = matches;
    }
  });

  test("a hinted cell's key is underlined in dots; its ring fits the scroller's padding", () => {
    const label = cssRule(file, '.compact .inner[data-hint] .label');
    expect(label).toContain('text-decoration-style: dotted;');
    expect(cssRule(file, '.compact .inner[data-hint]')).toContain(
      'cursor: help;'
    );
    const ring = cssRule(file, '.compact div.inner:focus-visible');
    expect(ring).toContain('outline: 2px solid var(--focus-ring);');
    // The ring's reach (width + offset) stays inside the scroller's 4px of block
    // padding, which clips anything further out.
    const width = Number(/outline: (\d+)px/.exec(ring)?.[1]);
    const offset = Number(/outline-offset: (\d+)px/.exec(ring)?.[1]);
    expect(cssRule(file, '.scroller')).toContain('padding: 4px 6px;');
    expect(width + offset).toBeLessThanOrEqual(4);
  });
});

function item(id: string): DeadlineGroup['items'][number] {
  return {
    id,
    label: `Milestone ${id}`,
    sublabel: 'Atlas · 3 open',
    href: `/timeline?milestone=${id}`,
    status: 'on_track',
    statusLabel: 'On track',
    dueLabel: 'Oct 23',
  };
}

describe('DeadlineList', () => {
  const groups: DeadlineGroup[] = [
    { id: 'over', label: 'Overdue', tone: 'danger', items: [item('m0')] },
    { id: 'today', label: 'Today', items: [] },
    {
      id: 'week',
      label: 'This week',
      items: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(item),
    },
  ];

  test('groups are headed with counts; items link via the host', () => {
    const view = render(
      <UiLinkProvider link={HostLink}>
        <DeadlineList groups={groups} />
      </UiLinkProvider>
    );
    expect(view.getByRole('heading', { name: /Overdue.*1/ })).toBeTruthy();
    expect(view.getByRole('heading', { name: /This week.*6/ })).toBeTruthy();
    // An empty group keeps its heading and says so (Gr8r's panel prints a
    // faint "Nothing due" under it).
    expect(view.getByRole('heading', { name: /Today.*0/ })).toBeTruthy();
    expect(view.getByText('Nothing due')).toBeTruthy();
    // Each group's label carries its tone (danger Overdue), so the label
    // takes the colour; the dates stay quiet.
    const tones = [
      ...view.container.querySelectorAll('[data-deadline-group] [data-tone]'),
    ].map((label) => label.getAttribute('data-tone'));
    expect(tones).toEqual(['danger', 'default', 'default']);
    const link = view.getByRole('link', { name: /Milestone m0/ });
    expect(link.getAttribute('href')).toBe('/timeline?milestone=m0');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    // The status mark is part of the link's name.
    expect(link.textContent).toContain('Oct 23');
    expect(
      view.getAllByRole('img', { name: 'On track' }).length
    ).toBeGreaterThan(0);
  });

  test('with every group empty, each group still stands and says so', () => {
    const view = render(
      <DeadlineList
        groups={[
          { id: 'over', label: 'Overdue', tone: 'danger', items: [] },
          { id: 'today', label: 'Today', items: [] },
        ]}
      />
    );
    expect(view.getAllByRole('heading')).toHaveLength(2);
    expect(view.getAllByRole('region')).toHaveLength(2);
    expect(view.getAllByText('Nothing due')).toHaveLength(2);
  });

  test('"+N more" reveals the rest and moves focus to the first new item', () => {
    const view = render(<DeadlineList groups={groups} limit={4} />);
    expect(view.queryByRole('link', { name: /Milestone m5/ })).toBeNull();
    const more = view.getByRole('button', { name: '+2 more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const revealed = view.getByRole('link', { name: /Milestone m5/ });
    expect(document.activeElement).toBe(revealed);
    fireEvent.click(view.getByRole('button', { name: 'Show fewer' }));
    expect(view.queryByRole('link', { name: /Milestone m5/ })).toBeNull();
  });
});

describe('Register', () => {
  test('header is decorative; the list and cell labels carry meaning', () => {
    const view = render(
      <Register
        label="Projects"
        columns="1fr 1fr"
        header={[
          { id: 'name', label: 'Project' },
          { id: 'lead', label: 'Lead' },
        ]}
      >
        <RegisterRow>
          <RegisterCell label="Project" variant="name" sub="Platform">
            Atlas
          </RegisterCell>
          <RegisterCell label="Lead" variant="mono" tone="warning">
            No lead
          </RegisterCell>
        </RegisterRow>
      </Register>
    );
    const header = view.container.querySelector('[aria-hidden="true"]');
    expect(header?.textContent).toBe('ProjectLead');
    const list = view.getByRole('list', { name: 'Projects' });
    expect(list.textContent).toContain('ProjectAtlasPlatform');
    expect(list.textContent).toContain('LeadNo lead');
    expect(
      view.container.querySelector('[data-tone="warning"]')
    ).not.toBeNull();
  });

  test('linked rows are one focusable target through the host link', () => {
    const view = render(
      <UiLinkProvider link={HostLink}>
        <Register label="Runs" columns="1fr">
          <RegisterRow href="/runs/1" rowLabel="Run 1">
            <RegisterCell variant="name">Run 1</RegisterCell>
          </RegisterRow>
          <RegisterRow
            href="https://linear.app/x"
            external
            rowLabel="Atlas in Linear"
          >
            <RegisterCell>Atlas</RegisterCell>
          </RegisterRow>
        </Register>
      </UiLinkProvider>
    );
    const run = view.getByRole('link', { name: 'Run 1' });
    expect(run.getAttribute('href')).toBe('/runs/1');
    expect(run.hasAttribute('data-host-link')).toBe(true);
    const ext = view.getByRole('link', {
      name: 'Atlas in Linear (opens in a new tab)',
    });
    expect(ext.getAttribute('target')).toBe('_blank');
  });

  test('stacks by viewport width, or by its own width with stackWithin', () => {
    const rows = (
      <RegisterRow>
        <RegisterCell>Atlas</RegisterCell>
      </RegisterRow>
    );
    const byViewport = render(
      <Register label="Viewport" columns="1fr" stackBelow={700}>
        {rows}
      </Register>
    );
    const viewportRoot = byViewport.container.firstElementChild;
    expect(viewportRoot?.getAttribute('data-stack')).toBe('viewport-700');
    cleanup();

    const byWidth = render(
      <Register
        label="Container"
        columns="1fr"
        stackBelow={700}
        stackWithin={1000}
        stackedColumns="repeat(auto-fill, minmax(150px, 1fr))"
      >
        {rows}
      </Register>
    );
    const root = byWidth.container.firstElementChild as HTMLElement | null;
    // stackWithin wins over stackBelow: the root is the query container
    // (CSS module class names are empty under Bun, so data-stack is read).
    expect(root?.getAttribute('data-stack')).toBe('container-1000');
    expect(root?.style.getPropertyValue('--register-stacked-cols')).toBe(
      'repeat(auto-fill, minmax(150px, 1fr))'
    );
  });

  // The small steps keep a short register (three to five narrow columns in a settings
  // page) a table at the app's default window size; each is its own container query.
  test('stackWithin takes the small steps 480 and 600 too', () => {
    for (const step of [480, 600] as const) {
      const view = render(
        <Register
          label={`Within ${String(step)}`}
          columns="1fr 96px"
          stackWithin={step}
        >
          <RegisterRow>
            <RegisterCell>Atlas</RegisterCell>
            <RegisterCell align="end">$4</RegisterCell>
          </RegisterRow>
        </Register>
      );
      expect(view.container.firstElementChild?.getAttribute('data-stack')).toBe(
        `container-${String(step)}`
      );
      expect(
        view.getByRole('list', { name: `Within ${String(step)}` })
      ).toBeTruthy();
      cleanup();
    }
  });

  // A long doc slug in an end cell ran about 4px past a stacked card's
  // edge at 390px: an end cell is only as wide as its content (it is not
  // stretched), so a nowrap value set its width past the grid area. The
  // cell and its value are capped at the area's width, so the host's
  // ellipsis clips and a long word wraps, in the table and stacked.
  test('an end cell and its value stay within their grid area', () => {
    const view = render(
      <Register label="Docs" columns="1fr 160px" stackWithin={600}>
        <RegisterRow>
          <RegisterCell variant="name">Plan</RegisterCell>
          <RegisterCell align="end" label="Slug" data-testid="slug-cell">
            <span>a-very-long-document-slug-that-runs-on-and-on</span>
          </RegisterCell>
        </RegisterRow>
      </Register>
    );
    // The label and the value are the cell's own children, which the
    // `.end > *` cap reaches.
    const cell = view.getByTestId('slug-cell');
    expect(cell.children).toHaveLength(2);
    const file = 'tasks/register.module.css';
    expect(cssRule(file, '.end')).toContain('max-width: 100%;');
    expect(cssRule(file, '.end > *')).toBe('max-width: 100%;');
    expect(cssRule(file, '.cellValue')).toContain('overflow-wrap: break-word;');
    // Stacking moves the end cell to the start of its track but keeps it
    // fitted to its content, so the cap must hold there too: no stacked
    // `.end` rule sets a width of its own.
    const stacked = [
      ...readCss(file).matchAll(/\.(?:stack|within)\d+ \.end \{([^}]*)\}/g),
    ].map((match) => match[1] ?? '');
    expect(stacked).toHaveLength(7);
    expect(stacked.filter((body) => body.includes('width'))).toEqual([]);
  });

  test('callback rows are buttons; selected rows are marked current', () => {
    const onActivate = mock(() => {});
    const view = render(
      <Register label="Sections" columns="1fr">
        <RegisterRow onActivate={onActivate} rowLabel="People" selected>
          <RegisterCell>People</RegisterCell>
        </RegisterRow>
      </Register>
    );
    fireEvent.click(view.getByRole('button', { name: 'People' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(view.getByRole('listitem').getAttribute('aria-current')).toBe(
      'true'
    );
  });
});

describe('review additions', () => {
  test('StatsStrip: the last cell spans what its row leaves empty', () => {
    const cells = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        label: `Cell ${i}`,
        value: i,
      }));
    const spanOf = (n: number) => {
      const view = render(<StatsStrip cells={cells(n)} label={`n${n}`} />);
      const strip = view.getByRole('list', { name: `n${n}` });
      const items = strip.querySelectorAll('li');
      const result = {
        cols: strip.style.getPropertyValue('--stat-cols'),
        span: items[items.length - 1]?.style.getPropertyValue('--stat-span'),
      };
      view.unmount();
      return result;
    };
    expect(spanOf(4)).toEqual({ cols: '4', span: '' });
    expect(spanOf(3)).toEqual({ cols: '3', span: '' });
    expect(spanOf(5)).toEqual({ cols: '4', span: '4' });
    expect(spanOf(6)).toEqual({ cols: '4', span: '3' });
  });

  test('DeadlineList: "Show fewer" folds the overflow back; empty groups say so', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}`,
      label: `Milestone ${i}`,
      href: `/m/${i}`,
      status: 'on_track' as const,
      statusLabel: 'On track',
      dueLabel: `Oct ${20 + i}`,
    }));
    const view = render(
      <DeadlineList
        limit={2}
        emptyLabel="Nothing due"
        groups={[
          { id: 'today', label: 'Today', items: [] },
          { id: 'week', label: 'This week', items },
        ]}
      />
    );
    expect(view.getByText('Nothing due')).toBeTruthy();
    const more = view.getByRole('button', { name: '+4 more' });
    fireEvent.click(more);
    expect(view.getAllByRole('link')).toHaveLength(6);
    const fewer = view.getByRole('button', { name: 'Show fewer' });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fewer);
    expect(view.getAllByRole('link')).toHaveLength(2);
  });
});

describe('Checklist onToggle', () => {
  // The second criterion has no id: it is reported by its index, the way
  // ReviewMode stores a run's criteria ticks.
  const criteria: ChecklistItem[] = [
    { id: 'hashed', label: 'Events are hashed', met: true },
    { label: 'Sampling is configurable', met: false, note: 'Per project' },
  ];

  test('each item is a checkbox named by its label, checked when met', () => {
    const view = render(
      <Checklist
        label="Review checklist"
        items={criteria}
        onToggle={() => undefined}
      />
    );
    const list = view.getByRole('list', { name: 'Review checklist' });
    const rows = view.getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-met'))).toEqual([
      'true',
      'false',
    ]);
    expect(rows.every((row) => list.contains(row))).toBe(true);
    const boxes = view.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(
      view.getByRole('checkbox', { name: 'Events are hashed' })
    ).toBeTruthy();
    // The note sits after the label inside the Checkbox's <label>, so it
    // follows the label in the box's name.
    expect(
      view.getByRole('checkbox', { name: /^Sampling is configurable/ })
    ).toBeTruthy();
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    // No state words and no amber chip in this mode.
    expect(rows[1].textContent).toContain('Per project');
    expect(list.textContent).not.toContain('Met');
    expect(list.textContent).not.toContain('Missing');
    expect(list.querySelector('[data-tone]')).toBeNull();
  });

  test('a tick reports the item id (or its index) and the next state', () => {
    const onToggle = mock((_id: string, _met: boolean) => undefined);
    const view = render(
      <Checklist
        label="Review checklist"
        items={criteria}
        onToggle={onToggle}
      />
    );
    fireEvent.click(view.getByRole('checkbox', { name: 'Events are hashed' }));
    fireEvent.click(
      view.getByRole('checkbox', { name: /^Sampling is configurable/ })
    );
    expect(onToggle.mock.calls).toEqual([
      ['hashed', false],
      ['1', true],
    ]);
  });

  test('controlled by met: a tick the host refuses leaves the box as it was', () => {
    const view = render(
      <Checklist
        label="Review checklist"
        items={criteria}
        onToggle={() => undefined}
      />
    );
    const box = view.getByRole('checkbox', {
      name: /^Sampling is configurable/,
    }) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    view.rerender(
      <Checklist
        label="Review checklist"
        items={criteria.map((item) => ({ ...item, met: true }))}
        onToggle={() => undefined}
      />
    );
    expect(box.checked).toBe(true);
  });

  test('without onToggle it stays the read-only rubric (no checkbox)', () => {
    const view = render(<Checklist label="Rubric" items={criteria} />);
    expect(view.getByRole('list', { name: 'Rubric' })).toBeTruthy();
    expect(view.queryAllByRole('checkbox')).toHaveLength(0);
    const rows = view.getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-met'))).toEqual([
      'true',
      'false',
    ]);
    expect(rows[0].textContent).toContain('Met');
    expect(rows[1].textContent).toContain('Missing');
  });
});
