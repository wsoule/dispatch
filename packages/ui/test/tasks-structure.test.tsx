import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRef } from 'react';

import {
  ListItem,
  Panel,
  PanelRow,
  PIE_DASH,
  pieDashOffset,
  ProgressPie,
  SectionHeader,
  Tooltip,
} from '../src/index';
import {
  contrast,
  hex,
  over,
  readCss,
  THEMES,
  tintShare,
  tokensCss,
} from './contrast-helpers';

afterEach(cleanup);

// The structure primitives a host's own lists are built from (L24, L25,
// L27, L28): SectionHeader, the heading row over a band of rows (ports the
// legacy group header's cases), ProgressPie, Linear's ring and pie (ports
// the legacy progress glyph's numbers), ListItem, the row of a host's own
// list (ports the legacy list row's cases), and Panel with PanelRow, the
// embedded box and its rows (ports the legacy chrome panel's cases).

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src with its whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8').replace(/\s+/g, ' ');
}

describe('SectionHeader', () => {
  test('the chevron collapses and expands, saying so in its name and aria-expanded', () => {
    let collapsed = false;
    const onToggle = mock(() => {
      collapsed = !collapsed;
    });
    const { rerender } = render(
      <SectionHeader name="Done" collapsed={collapsed} onToggle={onToggle} />
    );
    const chevron = screen.getByRole('button', { name: 'Collapse group' });
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    expect(chevron.getAttribute('data-part')).toBe('toggle');
    fireEvent.click(chevron);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(collapsed).toBe(true);
    rerender(
      <SectionHeader name="Done" collapsed={collapsed} onToggle={onToggle} />
    );
    const expand = screen.getByRole('button', { name: 'Expand group' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    // The root says it is folded.
    expect(
      expand.closest('[data-collapsed]')?.getAttribute('data-collapsed')
    ).toBe('true');
  });

  test('toggleLabel names the chevron; aria-expanded still says the state', () => {
    render(
      <SectionHeader
        name="Backlog"
        collapsed
        onToggle={() => undefined}
        toggleLabel="Fold Backlog"
      />
    );
    const chevron = screen.getByRole('button', { name: 'Fold Backlog' });
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
  });

  test('there is no chevron without onToggle', () => {
    const { container } = render(<SectionHeader name="Done" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-part="toggle"]')).toBeNull();
    expect(container.firstElementChild?.hasAttribute('data-collapsed')).toBe(
      false
    );
  });

  test('onAdd renders the + button after the actions, which sit beside it', () => {
    const onAdd = mock(() => undefined);
    const { container } = render(
      <SectionHeader
        name="Todo"
        onAdd={onAdd}
        addLabel="New task"
        actions={<button type="button">Graph</button>}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    const actions = container.querySelector('[data-part="actions"]');
    const buttons = Array.from(actions?.querySelectorAll('button') ?? []);
    expect(
      buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)
    ).toEqual(['Graph', 'New task']);
    expect(buttons[1]?.getAttribute('title')).toBe('New task');
  });

  test('the + is named "New" by default; no actions, no actions part', () => {
    const { container, rerender } = render(
      <SectionHeader name="Todo" onAdd={() => undefined} />
    );
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
    rerender(<SectionHeader name="Todo" />);
    expect(container.querySelector('[data-part="actions"]')).toBeNull();
  });

  test('name and count are separate parts', () => {
    const { container } = render(<SectionHeader name="Backlog" count={12} />);
    expect(container.querySelector('[data-part="name"]')?.textContent).toBe(
      'Backlog'
    );
    expect(container.querySelector('[data-part="count"]')?.textContent).toBe(
      '12'
    );
  });

  test('the count is in the heading, so it is part of its accessible name', () => {
    render(<SectionHeader name="Coming in" count={2} />);
    const heading = screen.getByRole('heading', { name: 'Coming in 2' });
    expect(heading.tagName).toBe('H3');
    // FlowColumns reads it this way.
    expect(screen.getByRole('heading', { name: /Coming in\s*2/ })).toBe(
      heading
    );
  });

  test('a count of 0 is still printed', () => {
    render(<SectionHeader name="Coming in" count={0} />);
    expect(screen.getByRole('heading', { name: 'Coming in 0' })).toBeTruthy();
  });

  test('tone sets data-tone on the root and draws the diamond beside the words', () => {
    const { container, rerender } = render(
      <SectionHeader name="Failed" tone="danger" count={3} />
    );
    const root = container.firstElementChild;
    expect(root?.getAttribute('data-tone')).toBe('danger');
    // The diamond is decoration: hidden, so the heading is not read twice.
    const diamond = root?.querySelector('[data-status]');
    expect(diamond?.getAttribute('data-status')).toBe('overdue');
    expect(diamond?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Failed 3' })).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    // Each status tone in its own shape.
    for (const [tone, shape] of [
      ['warning', 'at_risk'],
      ['success', 'on_track'],
      ['info', 'open'],
    ] as const) {
      rerender(<SectionHeader name="Group" tone={tone} />);
      expect([
        tone,
        container.querySelector('[data-status]')?.getAttribute('data-status'),
      ]).toEqual([tone, shape]);
    }
    // Default (or none) draws neither the diamond nor data-tone.
    rerender(<SectionHeader name="Group" tone="default" />);
    expect(container.firstElementChild?.hasAttribute('data-tone')).toBe(false);
    expect(container.querySelector('[data-status]')).toBeNull();
  });

  test('the host data hooks reach the root; the icon is its own part', () => {
    const { container } = render(
      <SectionHeader
        name={<span data-slot="group-header-name">In progress</span>}
        icon={<span data-slot="group-header-icon">◐</span>}
        data-slot="group-header"
        data-testid="lane"
      />
    );
    const root = container.firstElementChild;
    expect(root?.getAttribute('data-slot')).toBe('group-header');
    expect(root?.getAttribute('data-testid')).toBe('lane');
    expect(
      root?.querySelector('[data-part="icon"] [data-slot="group-header-icon"]')
    ).not.toBeNull();
    expect(
      root?.querySelector('[data-part="name"] [data-slot="group-header-name"]')
    ).not.toBeNull();
  });

  test('as picks the heading element', () => {
    const { container, rerender } = render(
      <SectionHeader name="Running" as="h2" />
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'Running' }).tagName
    ).toBe('H2');
    rerender(<SectionHeader name="Running" as="h4" />);
    expect(screen.getByRole('heading', { level: 4 })).toBeTruthy();
    rerender(<SectionHeader name="Running" as="div" />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(container.querySelector('[data-part="name"]')?.textContent).toBe(
      'Running'
    );
  });

  test('className adds to the root', () => {
    const { container } = render(
      <SectionHeader name="Running" className="host-band" />
    );
    expect(container.firstElementChild?.classList.contains('host-band')).toBe(
      true
    );
  });

  test('the module: sentence case, the edge, the fold, sticky, motion and forced colours', () => {
    const sheet = css('tasks/section-header.module.css');
    expect(sheet).not.toContain('uppercase');
    expect(sheet).not.toMatch(/outline:\s*(none|0)/);
    expect(sheet).toContain('font-size: var(--fs-sm);');
    expect(sheet).toContain('font-weight: var(--fw-medium);');
    expect(sheet).toContain('color: var(--text-2);');
    expect(sheet).toContain('font-variant-numeric: tabular-nums;');
    // The tone's edge is a border, so forced colours keep it.
    expect(sheet).toContain(
      '.root[data-tone] { padding-left: 8px; border-left: 2px solid var(--tone); }'
    );
    expect(sheet).toContain(
      ".root[data-collapsed='true'] .chevron { transform: rotate(-90deg); }"
    );
    expect(sheet).toContain(
      '.rule { border-bottom: 1px solid var(--divider); }'
    );
    expect(sheet).toContain('position: sticky; top: 0;');
    expect(sheet).toContain('background: var(--bg);');
    // The chevron only turns under no-preference: no transition before it.
    const motionAt = sheet.indexOf(
      '@media (prefers-reduced-motion: no-preference)'
    );
    expect(motionAt).toBeGreaterThan(0);
    expect(sheet.slice(motionAt)).toContain('.chevron { transition: transform');
    expect(sheet.slice(0, motionAt)).not.toContain('transition');
    const forced = sheet.slice(sheet.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('color: CanvasText;');
  });
});

/** A pie's svg, its ring (stroke 1.5) and its arc (stroke 4). */
function pie(done: number, total: number, label = `${done} of ${total} done`) {
  const { container } = render(
    <ProgressPie done={done} total={total} label={label} />
  );
  const circles = Array.from(container.querySelectorAll('circle'));
  return {
    svg: container.querySelector('svg'),
    ring: circles.find((c) => c.getAttribute('stroke-width') === '1.5'),
    arc: circles.find((c) => c.getAttribute('stroke-width') === '4'),
  };
}

describe('ProgressPie', () => {
  test('the dasharray is the full arc followed by a gap twice as long', () => {
    const { arc } = pie(4, 8);
    expect(arc?.getAttribute('stroke-dasharray')).toBe(
      `${PIE_DASH} ${PIE_DASH * 2}`
    );
    expect(arc?.getAttribute('transform')).toBe('rotate(-90 7 7)');
    expect(arc?.getAttribute('r')).toBe('2');
  });

  test.each([
    [0, 4, PIE_DASH],
    // About 6.0947 and 3.0473.
    [2, 4, PIE_DASH / 2],
    [3, 4, PIE_DASH / 4],
    [4, 4, 0],
  ])('%d of %d offsets the pie by %d', (done, total, offset) => {
    expect(pieDashOffset(done / total)).toBeCloseTo(offset, 9);
    expect(
      Number(pie(done, total).arc?.getAttribute('stroke-dashoffset'))
    ).toBeCloseTo(offset, 9);
    cleanup();
  });

  test('the ring is r=6 inside a 14-unit viewBox, 12px by default', () => {
    const { svg, ring } = pie(0, 3);
    expect(svg?.getAttribute('viewBox')).toBe('0 0 14 14');
    expect(ring?.getAttribute('r')).toBe('6');
    expect(svg?.getAttribute('width')).toBe('12');
    expect(svg?.getAttribute('height')).toBe('12');
  });

  test('it is an image named by its label', () => {
    render(<ProgressPie done={3} total={8} label="3 of 8 done" />);
    const img = screen.getByRole('img', { name: '3 of 8 done' });
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(img.hasAttribute('aria-hidden')).toBe(false);
  });

  test('a total of 0 draws an empty pie, never NaN', () => {
    const { arc } = pie(0, 0);
    expect(Number(arc?.getAttribute('stroke-dashoffset'))).toBe(PIE_DASH);
    cleanup();
    expect(Number(pie(5, 0).arc?.getAttribute('stroke-dashoffset'))).toBe(
      PIE_DASH
    );
  });

  test('a count past the total is a full pie, a negative one empty', () => {
    expect(Number(pie(9, 8).arc?.getAttribute('stroke-dashoffset'))).toBe(0);
    cleanup();
    expect(Number(pie(-1, 8).arc?.getAttribute('stroke-dashoffset'))).toBe(
      PIE_DASH
    );
  });

  test('an empty label makes it decorative', () => {
    const { container } = render(<ProgressPie done={1} total={2} label="" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.hasAttribute('role')).toBe(false);
    expect(svg?.hasAttribute('aria-label')).toBe(false);
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a className adds without losing the size; size and tone are attributes', () => {
    const { container } = render(
      <ProgressPie
        done={1}
        total={4}
        size={16}
        tone="info"
        label="1 of 4 landed"
        className="host-pie"
      />
    );
    const svg = container.querySelector('svg');
    expect(svg?.classList.contains('host-pie')).toBe(true);
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
    expect(svg?.getAttribute('data-tone')).toBe('info');
  });

  test('the module strokes the ring and the pie from the tone and keeps both in forced colours', () => {
    const sheet = css('tasks/task-glyphs.module.css');
    expect(sheet).toContain('.pieRing { stroke: var(--control-border); }');
    expect(sheet).toContain('.pieArc { stroke: var(--text-2); }');
    expect(sheet).toContain(
      '.pie[data-tone] .pieRing { stroke: var(--tone-line); }'
    );
    expect(sheet).toContain('.pie[data-tone] .pieArc { stroke: var(--tone); }');
    const forced = sheet.slice(sheet.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('.pie[data-tone] .pieArc { stroke: CanvasText; }');
  });
});

/** A module under src: comments removed, whitespace collapsed. */
function flatCss(file: string): string {
  return readCss(file).replace(/\s+/g, ' ');
}

/** Every var() name a module reads that tokens.css does not declare. */
function undeclaredVars(file: string): string[] {
  const declared = new Set(
    [...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
  );
  return [...readCss(file).matchAll(/var\((--[\w-]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((name) => !declared.has(name));
}

/** A module with every no-preference motion block cut out. */
function outsideMotion(sheet: string): string {
  return sheet.replace(
    /@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g,
    ''
  );
}

describe('ListItem', () => {
  const everySlot = {
    leading: <span>P</span>,
    title: 'Cache the search index',
    crumb: 'Search',
    meta: '3 replies',
    trailing: <span>pill</span>,
    date: 'Sep 13',
  };

  // The slots read left to right, the meta line under the title: a row
  // that moved one would read differently from every other row.
  test('slots render in reading order', () => {
    const { container } = render(<ListItem {...everySlot} />);
    const order = [
      ...container.querySelectorAll('[data-slot^="list-item-"]'),
    ].map((el) => el.getAttribute('data-slot'));
    expect(order).toEqual([
      'list-item-leading',
      'list-item-title',
      'list-item-crumb',
      'list-item-meta',
      'list-item-trailing',
      'list-item-date',
    ]);
    const root = container.firstElementChild;
    expect(root?.getAttribute('data-slot')).toBe('list-item');
    expect(root?.tagName).toBe('DIV');
    // The crumb is printed " › Search" inside the title, so it truncates
    // with it.
    const crumb = container.querySelector('[data-slot="list-item-crumb"]');
    expect(crumb?.textContent).toBe(' › Search');
    expect(crumb?.parentElement?.getAttribute('data-slot')).toBe(
      'list-item-title'
    );
  });

  test('a clickable row is focusable and activates on Enter and Space, with no event', () => {
    const calls: unknown[] = [];
    render(
      <ListItem
        title="Row"
        role="listitem"
        onClick={(event) => calls.push(event)}
      />
    );
    const row = screen.getByRole('listitem');
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'j' });
    expect(calls).toEqual([undefined, undefined]);
    fireEvent.click(row);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBeDefined();
  });

  test('a row without onClick takes no tab stop; tabIndex overrides it', () => {
    const { container, rerender } = render(<ListItem title="Row" />);
    const row = container.firstElementChild;
    expect(row?.hasAttribute('tabindex')).toBe(false);
    expect(row?.hasAttribute('data-clickable')).toBe(false);
    rerender(<ListItem title="Row" onClick={() => undefined} tabIndex={-1} />);
    expect(container.firstElementChild?.getAttribute('tabindex')).toBe('-1');
  });

  // The legacy hosts stopped the trailing slot's events by hand; the row
  // does it now, for clicks and for the control's own Enter and Space.
  test('neither a click nor Enter and Space in the trailing slot activate the row', () => {
    const onClick = mock(() => undefined);
    const onRetry = mock(() => undefined);
    render(
      <ListItem
        title="Row"
        role="listitem"
        onClick={onClick}
        trailing={
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        }
      />
    );
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.keyDown(retry, { key: 'Enter' });
    fireEvent.keyDown(retry, { key: ' ' });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  // Only the control's own press stays in the slot: Escape, Tab and the
  // app's shortcuts typed on a trailing button still reach the document
  // (a dialog's focus trap, an overlay's Escape, the global keyboard).
  test('keys other than a plain Enter or Space on a trailing control reach the document', () => {
    const onClick = mock(() => undefined);
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => {
      seen.push(`${event.metaKey ? 'Meta+' : ''}${event.key}`);
    };
    document.addEventListener('keydown', listen);
    try {
      render(
        <ListItem
          title="Row"
          role="listitem"
          onClick={onClick}
          trailing={<button type="button">Dismiss</button>}
        />
      );
      const dismiss = screen.getByRole('button', { name: 'Dismiss' });
      fireEvent.keyDown(dismiss, { key: 'Escape' });
      fireEvent.keyDown(dismiss, { key: 'Tab' });
      fireEvent.keyDown(dismiss, { key: 'k', metaKey: true });
      fireEvent.keyDown(dismiss, { key: 'Enter' });
      fireEvent.keyDown(dismiss, { key: ' ' });
      expect(seen).toEqual(['Escape', 'Tab', 'Meta+k']);
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', listen);
    }
  });

  test('a key on a control inside the row, outside the trailing slot, does not activate it', () => {
    const onClick = mock(() => undefined);
    render(
      <ListItem
        title={<a href="/threads/7">Thread 7</a>}
        role="listitem"
        onClick={onClick}
      />
    );
    const link = screen.getByRole('link', { name: 'Thread 7' });
    fireEvent.keyDown(link, { key: 'Enter' });
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  test('a nested row is indented with a connector', () => {
    const { container } = render(<ListItem title="Child" indent={1} />);
    const row = container.firstElementChild;
    expect(row?.getAttribute('data-indent')).toBe('1');
    const connector = container.querySelector(
      '[data-slot="list-item-connector"]'
    );
    expect(connector?.getAttribute('aria-hidden')).toBe('true');
    cleanup();
    const { container: top } = render(<ListItem title="Parent" />);
    expect(top.firstElementChild?.hasAttribute('data-indent')).toBe(false);
    expect(top.querySelector('[data-slot="list-item-connector"]')).toBeNull();
  });

  test('no slot carries a role, whatever the row is', () => {
    for (const role of ['listitem', 'option', undefined]) {
      const { container, unmount } = render(
        <ListItem {...everySlot} role={role} unread indent={1} />
      );
      const slots = container.querySelectorAll('[data-slot^="list-item-"]');
      expect(slots.length).toBeGreaterThan(6);
      for (const slot of slots) {
        expect([
          slot.getAttribute('data-slot'),
          slot.getAttribute('role'),
        ]).toEqual([slot.getAttribute('data-slot'), null]);
      }
      unmount();
    }
  });

  // A host listbox's aria-activedescendant points at the row by its id.
  test('domId lands as the DOM id', () => {
    const { container } = render(<ListItem title="Row" domId="thread-row-7" />);
    expect(container.firstElementChild?.id).toBe('thread-row-7');
  });

  test('as an option under a host listbox, aria-selected follows selected', () => {
    const { rerender } = render(
      <div role="listbox" aria-label="Threads">
        {/* ListItem sets aria-selected from `selected` under role option. */}
        {/* oxlint-disable-next-line jsx-a11y/role-has-required-aria-props */}
        <ListItem title="Row" role="option" selected domId="t-1" />
      </div>
    );
    const option = screen.getByRole('option', { name: 'Row' });
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(option.getAttribute('data-selected')).toBe('true');
    rerender(
      <div role="listbox" aria-label="Threads">
        {/* ListItem sets aria-selected from `selected` under role option. */}
        {/* oxlint-disable-next-line jsx-a11y/role-has-required-aria-props */}
        <ListItem title="Row" role="option" domId="t-1" />
      </div>
    );
    expect(option.getAttribute('aria-selected')).toBe('false');
    // Another role never says it.
    rerender(<ListItem title="Row" role="listitem" selected />);
    expect(screen.getByRole('listitem').hasAttribute('aria-selected')).toBe(
      false
    );
  });

  test('active marks the keyboard cursor; selected the picked row', () => {
    const { container } = render(<ListItem title="Row" active selected />);
    const row = container.firstElementChild;
    expect(row?.getAttribute('data-active')).toBe('true');
    expect(row?.getAttribute('data-selected')).toBe('true');
  });

  // Never colour alone: the dot comes with a word for assistive tech.
  test('unread draws a dot with an sr-only word and marks the root', () => {
    const { container, rerender } = render(
      <ListItem title="Ana replied" unread role="listitem" />
    );
    const row = screen.getByRole('listitem');
    expect(row.getAttribute('data-unread')).toBe('true');
    const unread = container.querySelector('[data-slot="list-item-unread"]');
    expect(unread?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(unread?.querySelector('.srOnly')?.textContent).toBe('Unread, ');
    expect(row.textContent).toBe('Unread, Ana replied');
    rerender(<ListItem title="Ana replied" role="listitem" />);
    expect(row.hasAttribute('data-unread')).toBe(false);
    expect(
      container.querySelector('[data-slot="list-item-unread"]')
    ).toBeNull();
  });

  test('the host hooks and className reach the root; as="li" renders a list item', () => {
    const onContextMenu = mock(() => undefined);
    render(
      <ul>
        <ListItem
          as="li"
          title="Row"
          className="host-row"
          data-testid="overseer-docked"
          data-slot="ignored"
          onContextMenu={onContextMenu}
        />
      </ul>
    );
    const row = screen.getByTestId('overseer-docked');
    expect(row.tagName).toBe('LI');
    expect(row.classList.contains('host-row')).toBe(true);
    // The row's own slot name wins over a host's.
    expect(row.getAttribute('data-slot')).toBe('list-item');
    fireEvent.contextMenu(row);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  test('as="button" is a native button; trailing controls sit beside it, never inside', () => {
    const onClick = mock(() => undefined);
    const onDismiss = mock(() => undefined);
    const { container } = render(
      <ListItem
        as="button"
        title="Docked conversation"
        date="running"
        data-testid="docked"
        onClick={onClick}
        trailing={
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
        }
      />
    );
    expect(container.querySelector('button button')).toBeNull();
    const row = screen.getByRole('button', {
      name: 'Docked conversation running',
    });
    expect(row.getAttribute('type')).toBe('button');
    // The wrapper is the root: the slot name, the hooks and the state.
    const root = screen.getByTestId('docked');
    expect(root.tagName).toBe('DIV');
    expect(root.getAttribute('data-slot')).toBe('list-item');
    expect(row.parentElement).toBe(root);
    expect(
      root.querySelector('[data-slot="list-item-trailing"]')?.parentElement
    ).toBe(root);
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('as="button" without trailing controls is the button itself', () => {
    const onClick = mock(() => undefined);
    render(
      <ListItem as="button" title="Open" data-testid="open" onClick={onClick} />
    );
    const row = screen.getByRole('button', { name: 'Open' });
    expect(row.getAttribute('data-testid')).toBe('open');
    expect(row.getAttribute('data-slot')).toBe('list-item');
    // Enter and Space are the button's own (a native click), never doubled.
    expect(row.hasAttribute('tabindex')).toBe(false);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // DockedConversation puts a Tooltip on a ListItem: the tooltip clones
  // its ref, aria-describedby and its pointer and focus handlers onto it.
  test('a Tooltip around it reaches the row: ref, description and focus', () => {
    const ref = createRef<HTMLElement>();
    render(
      <Tooltip content="Last reply: shipped it" defaultOpen>
        <ListItem
          ref={ref}
          title="Docked conversation"
          role="listitem"
          onClick={() => undefined}
        />
      </Tooltip>
    );
    const row = screen.getByRole('listitem');
    expect(ref.current).toBe(row);
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(row.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.getAttribute('data-placed')).toBe('true');
    cleanup();

    render(
      <Tooltip content="Last reply: shipped it">
        <ListItem
          title="Docked conversation"
          role="listitem"
          onClick={() => undefined}
        />
      </Tooltip>
    );
    const quiet = screen.getByRole('listitem');
    expect(quiet.hasAttribute('aria-describedby')).toBe(false);
    act(() => quiet.focus());
    expect(quiet.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', { hidden: true }).id
    );
    act(() => quiet.blur());
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  test('a Tooltip around an as="button" row with trailing controls anchors on the button', () => {
    render(
      <Tooltip content="Last reply" defaultOpen>
        <ListItem
          as="button"
          title="Docked"
          data-testid="docked"
          trailing={<span>2</span>}
        />
      </Tooltip>
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(
      screen
        .getByRole('button', { name: 'Docked' })
        .getAttribute('aria-describedby')
    ).toBe(tip.id);
    expect(screen.getByTestId('docked').hasAttribute('aria-describedby')).toBe(
      false
    );
  });

  describe('list-item.module.css', () => {
    const file = 'tasks/list-item.module.css';
    const sheet = flatCss(file);

    test('tokens only: no hex, and every var() it reads is a token', () => {
      expect(readCss(file)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(undeclaredVars(file)).toEqual([]);
    });

    test('40px, the type, the fills, the ring inside the row and the connector', () => {
      expect(sheet).not.toContain('uppercase');
      expect(sheet).not.toMatch(/outline:\s*(none|0)\b/);
      expect(sheet).toContain('min-height: var(--row-h);');
      expect(sheet).toContain(
        ".root[data-selected='true'] { background: var(--accent-soft); }"
      );
      expect(sheet).toContain(
        ".root:focus-visible, .root[data-active='true'] { outline: 2px solid var(--focus-ring); outline-offset: -2px; }"
      );
      expect(sheet).toContain(
        ".root[data-clickable='true']:not([data-selected='true']):hover { background: var(--surface-2); }"
      );
      expect(sheet).toContain('border-left: 1px solid var(--border);');
      expect(sheet).toContain('.unreadDot {');
      expect(sheet).toContain('background: var(--accent);');
      // The title truncates; the meta and the date are 12px secondary,
      // in tabular figures.
      expect(sheet).toMatch(
        /\.title \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/
      );
      for (const part of ['.meta', '.date']) {
        expect(sheet).toMatch(
          new RegExp(
            `\\${part} \\{[^}]*color: var\\(--text-2\\);[^}]*font-size: var\\(--fs-xs\\);[^}]*font-variant-numeric: tabular-nums;`
          )
        );
      }
    });

    test('motion only under no-preference; forced colours keep selected and active', () => {
      expect(outsideMotion(sheet)).not.toMatch(/(?:transition|animation):/);
      expect(sheet).toContain('@media (prefers-reduced-motion: no-preference)');
      const forced = sheet.slice(
        sheet.indexOf('@media (forced-colors: active)')
      );
      expect(forced).toContain(
        ".root[data-selected='true'] { outline: 1px solid Highlight;"
      );
      expect(forced).toContain('outline: 2px solid CanvasText;');
      expect(forced).toContain('.unreadDot { forced-color-adjust: none;');
    });

    for (const [theme, t] of THEMES) {
      test(`${theme}: the row's words read at 4.5:1 at rest, on hover and selected; the dot at 3:1`, () => {
        const selected = over(
          hex(t, '--accent'),
          hex(t, '--surface'),
          tintShare(t, '--accent-soft')
        );
        const failing: string[] = [];
        for (const text of ['--text', '--text-2']) {
          for (const [name, ground] of [
            ['--surface', hex(t, '--surface')],
            ['--bg', hex(t, '--bg')],
            ['--surface-2', hex(t, '--surface-2')],
            ['--accent-soft', selected],
          ] as const) {
            const ratio = contrast(hex(t, text), ground);
            if (ratio < 4.5) failing.push(`${text} on ${name}: ${ratio}`);
          }
        }
        for (const ground of ['--surface', '--bg', '--surface-2']) {
          const ratio = contrast(hex(t, '--accent'), hex(t, ground));
          if (ratio < 3) failing.push(`dot on ${ground}: ${ratio}`);
        }
        expect(failing).toEqual([]);
      });
    }
  });
});

describe('Panel', () => {
  test('a panel heading shows its words and its count', () => {
    render(
      <Panel heading="Needs review" count={5}>
        <p>Body</p>
      </Panel>
    );
    const heading = screen.getByRole('heading', { level: 3 });
    // The count sits after the heading, so the heading's name is its words.
    expect(heading.textContent).toBe('Needs review');
    expect(screen.getByText('5').getAttribute('data-part')).toBe('count');
  });

  // The panel is Gr8r's embedded box: --surface in a 1px --border at
  // --r-lg, no shadow, and a 40px heading row ruled off from the body.
  test('a panel is a bordered card with a 40px heading row', () => {
    const { container } = render(
      <Panel heading="Personal">
        <PanelRow>Full name</PanelRow>
      </Panel>
    );
    const panel = container.firstElementChild;
    expect(panel?.tagName).toBe('SECTION');
    expect(panel?.firstElementChild?.getAttribute('data-part')).toBe('header');
    const sheet = flatCss('tasks/panel.module.css');
    const rule = (selector: string): string => {
      const at = sheet.indexOf(`${selector} {`);
      expect([selector, at >= 0]).toEqual([selector, true]);
      return sheet
        .slice(sheet.indexOf('{', at) + 1, sheet.indexOf('}', at))
        .trim();
    };
    expect(rule('.panel')).toContain('border: 1px solid var(--border);');
    expect(rule('.panel')).toContain('border-radius: var(--r-lg);');
    expect(rule('.panel')).toContain('background: var(--surface);');
    expect(rule('.panel')).not.toContain('shadow');
    expect(rule('.header')).toContain('min-height: var(--row-h);');
    expect(rule('.header')).toContain(
      'border-bottom: 1px solid var(--divider);'
    );
    expect(tokensCss).toMatch(/--row-h: 40px;/);
    expect(rule('.row:not(:last-child)')).toBe(
      'border-bottom: 1px solid var(--divider);'
    );
  });

  test('the heading row holds the actions at its end', () => {
    render(
      <Panel
        heading="Merge queue"
        actions={<button type="button">Only mine</button>}
      >
        <p>Body</p>
      </Panel>
    );
    const action = screen.getByRole('button', { name: 'Only mine' });
    expect(action.parentElement?.getAttribute('data-part')).toBe('actions');
    expect(
      action.closest('[data-part="header"]')?.querySelector('h3')?.textContent
    ).toBe('Merge queue');
  });

  test('no heading row without a heading, a count or actions', () => {
    const { container } = render(
      <Panel>
        <p>Body</p>
      </Panel>
    );
    expect(container.querySelector('[data-part="header"]')).toBeNull();
    expect(container.querySelector('[data-part="body"]')?.textContent).toBe(
      'Body'
    );
  });

  test('headingLevel and as pick the elements; the host hooks and className reach the root', () => {
    const { container } = render(
      <Panel
        heading="Impact"
        headingLevel="h2"
        as="div"
        className="host-panel"
        data-testid="impact"
      >
        <p>Body</p>
      </Panel>
    );
    const panel = container.firstElementChild;
    expect(panel?.tagName).toBe('DIV');
    expect(panel?.getAttribute('data-testid')).toBe('impact');
    expect(panel?.classList.contains('host-panel')).toBe(true);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'Impact'
    );
  });

  test('flush drops the body padding; floating takes the pop shadow', () => {
    const { container } = render(
      <Panel heading="Guide" flush floating>
        <PanelRow>Step one</PanelRow>
      </Panel>
    );
    const panel = container.firstElementChild;
    expect(panel?.getAttribute('data-floating')).toBe('true');
    const body = container.querySelector('[data-part="body"]');
    expect(body?.getAttribute('data-flush')).toBe('true');
    const sheet = flatCss('tasks/panel.module.css');
    expect(sheet).toContain('.flush { gap: 0; padding: 0; }');
    expect(sheet).toContain(
      ".panel[data-floating='true'] { box-shadow: var(--shadow-pop); }"
    );
    cleanup();
    const { container: plain } = render(
      <Panel heading="Plain">
        <p>Body</p>
      </Panel>
    );
    expect(plain.firstElementChild?.hasAttribute('data-floating')).toBe(false);
    expect(
      plain.querySelector('[data-part="body"]')?.hasAttribute('data-flush')
    ).toBe(false);
  });

  // The urgent tier is an edge plus a word: the edge alone would say it by
  // colour only.
  test('an urgent row carries the warning edge and a word', () => {
    const { container, rerender } = render(
      <PanelRow urgent urgentLabel="Failed">
        Build the docs
      </PanelRow>
    );
    const row = container.firstElementChild;
    expect(row?.getAttribute('data-urgent')).toBe('true');
    expect(row?.getAttribute('data-tone')).toBe('warning');
    const word = container.querySelector('[data-part="urgent"]');
    expect(word?.textContent).toBe('Failed');
    expect(word?.classList.contains('srOnly')).toBe(false);
    rerender(<PanelRow urgent>Build the docs</PanelRow>);
    const hidden = container.querySelector('[data-part="urgent"]');
    expect(hidden?.textContent).toBe('Urgent, ');
    expect(hidden?.classList.contains('srOnly')).toBe(true);
    const sheet = flatCss('tasks/panel.module.css');
    expect(sheet).toContain(
      ".row[data-urgent='true'] { padding-left: calc(var(--s-3) - 2px); border-left: 2px solid var(--tone); }"
    );
  });

  test('a normal row carries no edge and no word', () => {
    const { container } = render(<PanelRow>Fine</PanelRow>);
    const row = container.firstElementChild;
    expect(row?.hasAttribute('data-urgent')).toBe(false);
    expect(row?.hasAttribute('data-tone')).toBe(false);
    expect(container.querySelector('[data-part="urgent"]')).toBeNull();
  });

  // A clickable row must be reachable by keyboard so the focus ring
  // applies and a host's roving focus can land on it.
  test('a clickable row exposes the button role and is focusable', () => {
    render(<PanelRow onActivate={() => undefined}>Open</PanelRow>);
    const row = screen.getByRole('button', { name: 'Open' });
    expect(row.tagName).toBe('DIV');
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  test('a clickable row activates on Enter and Space only, typed on the row itself', () => {
    const onActivate = mock(() => undefined);
    render(
      <PanelRow onActivate={onActivate}>
        Open
        <input aria-label="Note" />
      </PanelRow>
    );
    const row = screen.getByRole('button', { name: /^Open/ });
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onActivate).toHaveBeenCalledTimes(2);
    // Space typed into a field inside the row is the field's.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), {
      key: ' ',
    });
    expect(onActivate).toHaveBeenCalledTimes(2);
    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  // A panel row nests its own action buttons, which a <button> wrapper
  // would make invalid HTML; a press on one is that button's alone.
  test('a nested action button is not wrapped in another button element', () => {
    const onActivate = mock(() => undefined);
    const onRetry = mock(() => undefined);
    const { container } = render(
      <PanelRow onActivate={onActivate}>
        Retry the run
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </PanelRow>
    );
    expect(container.querySelector('button button')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  test('a row without onActivate claims no role and no tab stop', () => {
    const { container } = render(<PanelRow>Fine</PanelRow>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.firstElementChild?.hasAttribute('tabindex')).toBe(false);
  });

  test('a row forwards a ref and arbitrary DOM props', () => {
    const ref = createRef<HTMLDivElement>();
    const onClick = mock(() => undefined);
    render(
      <PanelRow
        ref={ref}
        data-run-id="r-7"
        title="Open the run"
        className="host-row"
        onClick={onClick}
      >
        Open
      </PanelRow>
    );
    expect(ref.current?.getAttribute('data-run-id')).toBe('r-7');
    expect(ref.current?.getAttribute('title')).toBe('Open the run');
    expect(ref.current?.classList.contains('host-row')).toBe(true);
    if (ref.current !== null) fireEvent.click(ref.current);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  describe('panel.module.css', () => {
    const file = 'tasks/panel.module.css';
    const sheet = flatCss(file);

    test('tokens only: no hex, and every var() it reads is a token', () => {
      expect(readCss(file)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(undeclaredVars(file)).toEqual([]);
    });

    test('the type, the tone edge, the ring inside the row, motion and forced colours', () => {
      expect(sheet).not.toContain('uppercase');
      expect(sheet).not.toMatch(/outline:\s*(none|0)\b/);
      expect(sheet).toMatch(
        /\.heading \{[^}]*color: var\(--text\);[^}]*font-size: var\(--fs\);[^}]*font-weight: var\(--fw-medium\);/
      );
      expect(sheet).toMatch(
        /\.count \{[^}]*color: var\(--text-3\);[^}]*font-variant-numeric: tabular-nums;/
      );
      expect(sheet).toContain(
        '.panel[data-tone] { border-left: 2px solid var(--tone); }'
      );
      expect(sheet).toContain(
        '.activatable:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }'
      );
      expect(outsideMotion(sheet)).not.toMatch(/(?:transition|animation):/);
      const forced = sheet.slice(
        sheet.indexOf('@media (forced-colors: active)')
      );
      expect(forced).toContain('outline-color: CanvasText;');
    });

    for (const [theme, t] of THEMES) {
      test(`${theme}: the heading, the count and an urgent word read at 4.5:1`, () => {
        const failing: string[] = [];
        for (const [text, ground] of [
          ['--text', '--surface'],
          ['--text-3', '--surface'],
          ['--amber', '--surface'],
          ['--text', '--surface-2'],
        ] as const) {
          const ratio = contrast(hex(t, text), hex(t, ground));
          if (ratio < 4.5) failing.push(`${text} on ${ground}: ${ratio}`);
        }
        expect(failing).toEqual([]);
      });
    }
  });
});
