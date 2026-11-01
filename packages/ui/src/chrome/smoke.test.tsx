import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { Button } from '../button';
import { Kbd } from '../kbd';

test('the test environment can render and query a React component', () => {
  render(<button type="button">Dispatch</button>);
  expect(screen.getByRole('button', { name: 'Dispatch' })).toBeDefined();
});

// The two most-copied primitives pinned to T3 Code's shapes: the primary button is a
// 28px indigo rectangle on the control radius with an inner highlight, and a keycap is
// an 11px tinted chip with no ring.
test('the primary button and keycap carry the T3 Code geometry', () => {
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
  expect(buttonClasses).toContain('rounded-control');
  expect(buttonClasses).toContain('inset-shadow-control-highlight');
  expect(buttonClasses).toContain('text-[13px]');
  const kbd = screen.getByText('⌘K');
  const kbdClasses = kbd.className.split(/\s+/);
  expect(kbdClasses).toContain('text-[11px]');
  expect(kbdClasses).toContain('rounded-chip');
  expect(kbdClasses).toContain('bg-foreground/[0.07]');
});

// Only ghost buttons take the neutral accent fill on hover; a filled variant keeps its
// own hover so an indigo icon button does not turn grey.
test('icon buttons take the neutral hover only on ghost', () => {
  render(
    <>
      <Button variant="ghost" size="icon" aria-label="Ghost" />
      <Button size="icon" aria-label="Primary" />
    </>
  );
  const ghost = screen.getByRole('button', { name: 'Ghost' }).className;
  const primary = screen.getByRole('button', { name: 'Primary' }).className;
  expect(ghost.split(/\s+/)).toContain('hover:bg-accent');
  expect(primary.split(/\s+/)).not.toContain('hover:bg-accent');
  expect(primary.split(/\s+/)).toContain('hover:bg-[var(--accent-hover)]');
});
