import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { AutonomySlider } from './AutonomySlider';

/** The stop buttons that currently read as chosen. */
function pressedStops(): HTMLElement[] {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true');
}

test('the slider is named Autonomy and exactly one stop is pressed', () => {
  render(<AutonomySlider rung={2} onRungChange={() => {}} />);
  const slider = screen.getByRole('slider', { name: 'Autonomy' });
  expect((slider as HTMLInputElement).value).toBe('2');
  const pressed = pressedStops();
  expect(pressed).toHaveLength(1);
  expect(pressed[0]?.textContent).toBe('Allow extra files');
  // The other three stops say so explicitly rather than leaving it unset.
  expect(
    screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'false')
  ).toHaveLength(3);
});

test('a drag across stops saves once, on release, and moves the pressed stop', () => {
  const changes: number[] = [];
  render(<AutonomySlider rung={1} onRungChange={(r) => changes.push(r)} />);
  const slider = screen.getByRole('slider', { name: 'Autonomy' });
  fireEvent.change(slider, { target: { value: '2' } });
  fireEvent.change(slider, { target: { value: '3' } });
  // Dragging only moves the draft: nothing is saved yet.
  expect(changes).toEqual([]);
  expect(pressedStops().map((b) => b.textContent)).toEqual(['Fix on its own']);
  fireEvent.pointerUp(slider);
  expect(changes).toEqual([3]);
  // A stray keyup afterwards (a modifier, a Tab landing here) saves nothing.
  fireEvent.keyUp(slider, { key: 'Shift' });
  fireEvent.pointerUp(slider);
  expect(changes).toEqual([3]);
  expect(pressedStops()).toHaveLength(1);
});

test('arrow keys commit once per key release', () => {
  const changes: number[] = [];
  render(<AutonomySlider rung={2} onRungChange={(r) => changes.push(r)} />);
  const slider = screen.getByRole('slider', { name: 'Autonomy' });
  fireEvent.change(slider, { target: { value: '3' } });
  fireEvent.keyUp(slider, { key: 'ArrowRight' });
  expect(changes).toEqual([3]);
});

test('a stop click commits that rung once; the saved stop commits nothing', () => {
  const changes: number[] = [];
  render(<AutonomySlider rung={1} onRungChange={(r) => changes.push(r)} />);
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Merge and accept memory and doc edits on their own',
    })
  );
  expect(changes).toEqual([4]);
  expect(pressedStops().map((b) => b.textContent)).toEqual([
    'Merge and accept memory and doc edits on their own',
  ]);
  // A drag that ends where it started is no change at all.
  const slider = screen.getByRole('slider', { name: 'Autonomy' });
  fireEvent.change(slider, { target: { value: '2' } });
  fireEvent.change(slider, { target: { value: '1' } });
  fireEvent.pointerUp(slider);
  fireEvent.click(screen.getByRole('button', { name: 'Review everything' }));
  expect(changes).toEqual([4]);
});
