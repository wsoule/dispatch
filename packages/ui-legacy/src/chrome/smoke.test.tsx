import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { Button } from '../button';
import { Kbd } from '../kbd';

test('the test environment can render and query a React component', () => {
  render(<button type="button">Dispatch</button>);
  expect(screen.getByRole('button', { name: 'Dispatch' })).toBeDefined();
});

// The two most-copied primitives pinned to the measured Linear values (§15): the
// primary button is a 28px indigo rectangle with a 6px radius, and a keycap is 11px
// with the 4px chip radius and a half-pixel ring.
test('the primary button and keycap carry the Linear geometry', () => {
  render(
    <>
      <Button>Create issue</Button>
      <Kbd>⌘K</Kbd>
    </>
  );
  const button = screen.getByRole('button', { name: 'Create issue' });
  const buttonClasses = button.className.split(/\s+/);
  expect(buttonClasses).toContain('h-7');
  expect(buttonClasses).toContain('bg-primary');
  expect(buttonClasses).toContain('rounded-[6px]');
  expect(buttonClasses).toContain('text-[12px]');
  const kbd = screen.getByText('⌘K');
  const kbdClasses = kbd.className.split(/\s+/);
  expect(kbdClasses).toContain('text-[11px]');
  expect(kbdClasses).toContain('rounded-chip');
  expect(kbdClasses).toContain('border-[0.5px]');
});

// Only ghost icon buttons take the control fill on hover; a filled variant keeps its
// own hover so an indigo icon button does not turn grey.
test('the icon sizes take the control hover only on ghost', () => {
  render(
    <>
      <Button variant="ghost" size="icon" aria-label="Ghost" />
      <Button size="icon" aria-label="Primary" />
    </>
  );
  const ghost = screen.getByRole('button', { name: 'Ghost' }).className;
  const primary = screen.getByRole('button', { name: 'Primary' }).className;
  expect(ghost.split(/\s+/)).toContain('hover:bg-surface-control');
  expect(primary.split(/\s+/)).not.toContain('hover:bg-surface-control');
  expect(primary.split(/\s+/)).toContain('hover:bg-[var(--accent-hover)]');
});
