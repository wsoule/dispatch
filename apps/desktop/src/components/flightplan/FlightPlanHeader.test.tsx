import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      'flight-stat',
      'flight-stat',
      'flight-stat',
      'flight-critical-stat',
      'flight-eta',
    ]);
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
