import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { FlightPlan } from './flightPlan';
import { FlightPlanMini } from './FlightPlanMini';

function plan(overrides: Partial<FlightPlan> = {}): FlightPlan {
  return {
    nodes: [],
    waves: [
      { index: 0, total: 2, done: 2, running: 0 },
      { index: 1, total: 3, done: 1, running: 2 },
      { index: 2, total: 1, done: 0, running: 0 },
    ],
    currentWave: 1,
    total: 6,
    done: 3,
    running: 2,
    queued: 0,
    slots: { used: 2, total: 3 },
    ...overrides,
  };
}

test('reads the wave, the running count and the slots', () => {
  render(<FlightPlanMini plan={plan()} />);
  const mini = screen.getByRole('img', {
    name: 'wave 2 of 3, 2 running, 2 of 3 slots in use',
  });
  expect(mini.textContent).toContain('Wave 2/3');
  expect(mini.textContent).toContain('2 running');
  // One segment per wave, the worked one marked; one dot per slot.
  expect(mini.querySelectorAll('[data-slot=flight-wave]')).toHaveLength(3);
  expect(mini.querySelectorAll('[data-current]')).toHaveLength(1);
  expect(mini.querySelector('[data-slot=flight-slots]')?.children).toHaveLength(
    3
  );
});

test('a deep plan folds into at most eight segments', () => {
  const waves = Array.from({ length: 20 }, (_, index) => ({
    index,
    total: 1,
    done: 0,
    running: 0,
  }));
  render(<FlightPlanMini plan={plan({ waves, currentWave: 0 })} />);
  expect(
    document.querySelectorAll('[data-slot=flight-wave]').length
  ).toBeLessThanOrEqual(8);
});

test('a landed plan with no session says so and shows no slots', () => {
  render(
    <FlightPlanMini
      plan={plan({
        currentWave: null,
        running: 0,
        slots: { used: 0, total: null },
      })}
    />
  );
  expect(screen.getByRole('img').textContent).toContain('All landed');
  expect(document.querySelector('[data-slot=flight-slots]')).toBeNull();
});
