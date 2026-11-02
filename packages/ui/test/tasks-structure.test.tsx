import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PIE_DASH,
  pieDashOffset,
  ProgressPie,
  SectionHeader,
} from '../src/index';

afterEach(cleanup);

// The structure primitives a host's own lists are built from (L24, L25):
// SectionHeader, the heading row over a band of rows (ports the legacy
// group header's cases), and ProgressPie, Linear's ring and pie (ports
// the legacy progress glyph's numbers).

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
