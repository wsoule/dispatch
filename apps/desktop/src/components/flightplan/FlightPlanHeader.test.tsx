import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatEta } from './criticalPath';
import { type FlightHeaderStats, FlightPlanHeader } from './FlightPlanHeader';

const stats: FlightHeaderStats = {
  slots: { used: 1, total: 3 },
  running: 1,
  queued: 4,
  done: 26,
  total: 50,
  critical: { count: 1, ms: 20 * 60_000 },
  eta: { at: Date.UTC(2026, 10, 3, 19, 57), ms: 100 * 60_000 },
  pace: { medianMs: 20 * 60_000, samples: 3 },
};

// The ETA as the header prints it in this machine's time zone (formatEta is local time).
const etaText = formatEta(
  stats.eta?.at ?? 0,
  (stats.eta?.at ?? 0) - (stats.eta?.ms ?? 0)
);

// Each cell's words (key, value, note) and its hover hint, in reading order. The hint
// is on the cell's inner element, never the <li>, whose name it would otherwise become.
function cellsOf(root: HTMLElement): { text: string; title: string }[] {
  return Array.from(root.querySelectorAll('li'), (li) => {
    expect(li.hasAttribute('title')).toBe(false);
    return {
      text: li.textContent ?? '',
      title: li.firstElementChild?.getAttribute('title') ?? '',
    };
  });
}

describe('FlightPlanHeader', () => {
  test('the fan-out controls sit at the end of the strip row, outside the list', () => {
    const { getByRole, container } = render(
      <FlightPlanHeader
        stats={stats}
        controls={
          <>
            <button type="button">3 slots</button>
            <button type="button">Pause</button>
            <button type="button">Stop</button>
          </>
        }
      />
    );
    const header = container.querySelector('[data-slot=flight-header]');
    const list = getByRole('list', { name: 'Flight plan' });
    expect(list.getAttribute('data-variant')).toBe('compact');
    expect(header?.contains(list)).toBe(true);
    const row = list.parentElement?.parentElement?.parentElement;
    const buttons = ['3 slots', 'Pause', 'Stop'].map((name) =>
      getByRole('button', { name })
    );
    for (const button of buttons) {
      expect(list.contains(button)).toBe(false);
      expect(row?.contains(button)).toBe(true);
    }
    // All three share one controls box, in the order the caller gave.
    const box = buttons[0]?.parentElement;
    expect(buttons.every((b) => b.parentElement === box)).toBe(true);
    expect(Array.from(box?.children ?? [], (b) => b.textContent)).toEqual([
      '3 slots',
      'Pause',
      'Stop',
    ]);
  });

  test('the strip keeps every cell and hook', () => {
    const { container } = render(
      <FlightPlanHeader stats={stats} controls={null} />
    );
    const slots = Array.from(container.querySelectorAll('li'), (li) =>
      li.getAttribute('data-slot')
    );
    expect(slots).toEqual([
      'flight-stat',
      'flight-eta',
      'flight-critical-stat',
      'flight-stat',
      'flight-stat',
    ]);
  });

  test('fanning out, one Running cell carries the slots meter, and the timing comes next', () => {
    const { container } = render(
      <FlightPlanHeader stats={stats} controls={null} />
    );
    const cells = cellsOf(container);
    // Running, then when it lands (the ETA and the critical path), then the counts: the
    // fan-out controls leave the strip little room, and its fade hides the end. The
    // ETA's 1h 40m is the remaining work over the slots, longer than the path's own
    // 20m, so the path keeps its time on screen.
    expect(cells.map((c) => c.text)).toEqual([
      'Running1/3',
      `ETA${etaText}~1h 40m left`,
      'Critical path1~20m',
      'Queued4',
      'Landed26/50',
    ]);
    const meter = container.querySelector(
      '[data-slot=flight-slots] [role=progressbar]'
    );
    expect(meter?.getAttribute('aria-label')).toBe('Agent slots');
    expect(meter?.getAttribute('aria-valuetext')).toBe('1 of 3 slots in use');
    // The full wording stays in each cell's hint.
    expect(cells[0]?.title).toBe('1 of 3 agent slots in use');
    expect(cells[2]?.title).toBe(
      'The longest chain still to land, ~20m of work at 20m a run, the median of the last 3'
    );
  });

  test("the critical path drops its note only when the ETA's time left is the same", () => {
    const { container } = render(
      <FlightPlanHeader
        stats={{
          ...stats,
          critical: { count: 2, ms: 100 * 60_000 },
        }}
        controls={null}
      />
    );
    const cells = cellsOf(container);
    expect(cells.slice(1, 3).map((c) => c.text)).toEqual([
      `ETA${etaText}~1h 40m left`,
      'Critical path2',
    ]);
    // The time is still in the hint.
    expect(cells[2]?.title).toBe(
      'The longest chain still to land, ~1h 40m of work at 20m a run, the median of the last 3'
    );
  });

  test('with no fan-out the Running count says so in its hint, and the critical path its time', () => {
    const { container } = render(
      <FlightPlanHeader
        stats={{
          ...stats,
          slots: { used: 0, total: null },
          running: 0,
          eta: null,
        }}
        controls={null}
      />
    );
    const cells = cellsOf(container);
    expect(cells.map((c) => c.text)).toEqual([
      'Running0',
      'Ready4',
      'Landed26/50',
      'Critical path1~20m',
    ]);
    expect(cells[0]?.title).toBe('Not fanning out, so no agent slots are held');
    expect(container.querySelector('[role=progressbar]')).toBeNull();
  });

  test('runs past the slots keep a Slots meter and a Running count apart', () => {
    const { container } = render(
      <FlightPlanHeader
        stats={{ ...stats, slots: { used: 4, total: 3 }, running: 4 }}
        controls={null}
      />
    );
    const cells = cellsOf(container);
    expect(cells.slice(0, 2).map((c) => c.text)).toEqual([
      'Slots3/3',
      'Running4',
    ]);
    expect(
      container
        .querySelector('[data-slot=flight-slots]')
        ?.getAttribute('data-tone')
    ).toBe('warning');
  });

  test('the header is padding and a rule around the one-row strip', () => {
    const css = readFileSync(
      join(import.meta.dir, 'FlightPlanHeader.module.css'),
      'utf8'
    );
    expect(css).not.toContain('flex-wrap');
    expect(css).toContain('padding: var(--s-2) var(--s-4);');
    expect(css).toContain('border-bottom: 1px solid var(--border);');
  });
});
