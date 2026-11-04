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
// Only the strip's own items: the Waves cell holds a list of its own.
function cellsOf(root: HTMLElement): { text: string; title: string }[] {
  return Array.from(
    root.querySelectorAll('[data-variant=compact] > li'),
    (li) => {
      expect(li.hasAttribute('title')).toBe(false);
      return {
        text: li.textContent ?? '',
        title: li.firstElementChild?.getAttribute('title') ?? '',
      };
    }
  );
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

  test('the slots picker sits in the cell that carries the meter, after it', () => {
    const picker = (
      <button type="button" aria-label="Agent slots for e-1: 3 slots" />
    );
    const { container, getByRole, rerender } = render(
      <FlightPlanHeader stats={stats} controls={null} slotsPicker={picker} />
    );
    const button = getByRole('button', {
      name: 'Agent slots for e-1: 3 slots',
    });
    const cell = button.closest('li');
    expect(cell?.getAttribute('data-slot')).toBe('flight-stat');
    expect(cell?.textContent).toBe('Running1/3');
    const meter = cell?.querySelector('[data-slot=flight-slots]');
    expect(meter?.nextElementSibling).toBe(button);
    // Runs past the slots: the picker goes with the meter into the Slots cell.
    rerender(
      <FlightPlanHeader
        stats={{ ...stats, slots: { used: 4, total: 3 }, running: 4 }}
        controls={null}
        slotsPicker={picker}
      />
    );
    expect(
      getByRole('button', { name: 'Agent slots for e-1: 3 slots' })
        .closest('li')
        ?.textContent?.startsWith('Slots')
    ).toBe(true);
    // No picker, no wrapper: the meter is the cell's value on its own.
    rerender(<FlightPlanHeader stats={stats} controls={null} />);
    expect(
      container.querySelector('[data-slot=flight-slots]')?.parentElement
        ?.className
    ).not.toContain('slots');
  });

  test('the fan-out spend and waves follow the counts as their own cells', () => {
    const { container } = render(
      <FlightPlanHeader
        stats={{
          ...stats,
          spend: {
            value: '$9.81',
            note: 'of $60',
            title: '$9.81 settled of the $60 ceiling · 2 runs',
            nearCeiling: false,
          },
          waves: [
            { name: 'Wave 1', status: 'passed' },
            { name: 'Wave 2', status: 'active' },
          ],
        }}
        controls={null}
      />
    );
    const cells = cellsOf(container);
    expect(cells.slice(5)).toEqual([
      {
        text: 'Spend$9.81of $60',
        title: '$9.81 settled of the $60 ceiling · 2 runs',
      },
      {
        text: 'WavesWave 1: passedWave 2: active',
        title: 'Wave 1: passed, Wave 2: active',
      },
    ]);
    const spend = container.querySelector('[data-slot=flight-spend]');
    expect(spend?.getAttribute('data-tone')).toBe('default');
    // No warning shape away from the ceiling.
    expect(spend?.querySelector('svg')).toBeNull();
  });

  test('a spend near its ceiling warns by tone, a triangle and words', () => {
    const { container } = render(
      <FlightPlanHeader
        stats={{
          ...stats,
          spend: {
            value: '$55',
            note: 'of $60',
            title: '$55 settled of the $60 ceiling, near it · 9 runs',
            nearCeiling: true,
          },
        }}
        controls={null}
      />
    );
    const spend = container.querySelector('[data-slot=flight-spend]');
    expect(spend?.getAttribute('data-tone')).toBe('warning');
    expect(spend?.querySelector('svg')).not.toBeNull();
    expect(spend?.querySelector('.srOnly')?.textContent).toBe(
      ', near its ceiling'
    );
  });

  test('a spend near its ceiling comes straight after the running cell', () => {
    const near = {
      value: '$55',
      note: 'of $60',
      title: '$55 settled of the $60 ceiling, near it · 9 runs',
      nearCeiling: true,
    };
    const waves = [
      { name: 'Wave 1', status: 'passed' as const },
      { name: 'Wave 2', status: 'active' as const },
    ];
    const { container, rerender } = render(
      <FlightPlanHeader
        stats={{ ...stats, spend: near, waves }}
        controls={null}
      />
    );
    expect(cellsOf(container).map((c) => c.text)).toEqual([
      'Running1/3',
      ['Spend', '$55', ', near its ceiling', 'of $60'].join(''),
      `ETA${etaText}~1h 40m left`,
      'Critical path1~20m',
      'Queued4',
      'Landed26/50',
      'WavesWave 1: passedWave 2: active',
    ]);
    // Runs past the slots: after both the Slots meter and the Running count.
    rerender(
      <FlightPlanHeader
        stats={{
          ...stats,
          slots: { used: 4, total: 3 },
          running: 4,
          spend: near,
        }}
        controls={null}
      />
    );
    expect(
      cellsOf(container)
        .slice(0, 3)
        .map((c) => c.text)
    ).toEqual([
      'Slots3/3',
      'Running4',
      ['Spend', '$55', ', near its ceiling', 'of $60'].join(''),
    ]);
  });

  test("a paused session's spend leads the strip, warning or not", () => {
    const calm = {
      value: '$4',
      note: 'of $60',
      title: '$4 settled of the $60 ceiling · 2 runs',
      nearCeiling: false,
    };
    const { container } = render(
      <FlightPlanHeader
        stats={{ ...stats, eta: null, spend: calm, paused: true }}
        controls={null}
      />
    );
    expect(cellsOf(container).map((c) => c.text)).toEqual([
      'Spend$4of $60',
      'Running1/3',
      'Critical path1~20m',
      'Queued4',
      'Landed26/50',
    ]);
  });

  // Picking fewer slots than the runs in flight splits the meter's cell into Slots and
  // Running. The cell that holds the picker must survive that, or the picker's focus
  // falls to <body> in the middle of using it.
  test('the slots picker keeps its node and its focus when the runs pass the slots', () => {
    const picker = (
      <button type="button" aria-label="Agent slots for e-1: 3 slots" />
    );
    const { getByRole, rerender } = render(
      <FlightPlanHeader
        stats={{ ...stats, slots: { used: 2, total: 3 }, running: 2 }}
        controls={null}
        slotsPicker={picker}
      />
    );
    const before = getByRole('button', {
      name: 'Agent slots for e-1: 3 slots',
    });
    before.focus();
    expect(document.activeElement).toBe(before);
    rerender(
      <FlightPlanHeader
        stats={{ ...stats, slots: { used: 2, total: 1 }, running: 2 }}
        controls={null}
        slotsPicker={picker}
      />
    );
    const after = getByRole('button', {
      name: 'Agent slots for e-1: 3 slots',
    });
    expect(after).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(after.closest('li')?.textContent).toBe('Slots1/1');
    // The spend turning to a warning moves its cell up beside the meter's, not the
    // meter's cell itself, so the picker keeps its focus then too.
    const spend = {
      value: '$9.20',
      note: 'of $10',
      title: '$9.20 settled of the $10 ceiling · 4 runs',
      nearCeiling: false,
    };
    for (const nearCeiling of [false, true]) {
      rerender(
        <FlightPlanHeader
          stats={{
            ...stats,
            slots: { used: 2, total: 1 },
            running: 2,
            spend: { ...spend, nearCeiling },
          }}
          controls={null}
          slotsPicker={picker}
        />
      );
    }
    expect(document.activeElement).toBe(before);
    expect(cellsOf(document.body)[2]?.text.startsWith('Spend')).toBe(true);
  });

  test('one wave draws no Waves cell', () => {
    const { container } = render(
      <FlightPlanHeader
        stats={{ ...stats, waves: [{ name: 'Wave 1', status: 'active' }] }}
        controls={null}
      />
    );
    expect(container.querySelector('[data-slot=flight-waves]')).toBeNull();
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
