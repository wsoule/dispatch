import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { GroupHeader } from './group-header';

// The tint reaches the DOM as the `--tint` custom property the `.status-tint` recipe
// reads; an untinted header must not carry the recipe at all, or it would paint a
// gradient from an unset variable.
test('the tint is an inline --tint variable with the status-tint recipe', () => {
  const { container } = render(
    <GroupHeader tint="#f2c94c" name="In progress" count={3} />
  );
  const bar = container.firstElementChild as HTMLElement;
  expect(bar.style.getPropertyValue('--tint')).toBe('#f2c94c');
  expect(bar.className.split(/\s+/)).toContain('status-tint');

  const { container: plain } = render(<GroupHeader name="No status" />);
  const plainBar = plain.firstElementChild as HTMLElement;
  expect(plainBar.style.getPropertyValue('--tint')).toBe('');
  expect(plainBar.className).not.toContain('status-tint');
});

test('the bar is 36px on the quaternary surface', () => {
  const { container } = render(<GroupHeader name="Todo" />);
  const classes = (container.firstElementChild as HTMLElement).className.split(
    /\s+/
  );
  expect(classes).toContain('h-9');
  expect(classes).toContain('bg-surface-quaternary');
  expect(classes).toContain('rounded-card');
});

test('name and count are separate 13px spans', () => {
  render(<GroupHeader name="Backlog" count={12} />);
  expect(screen.getByText('Backlog').className).toContain('font-medium');
  expect(screen.getByText('12').className).toContain('font-book');
});

test('the chevron collapses and expands', () => {
  let collapsed = false;
  const { rerender } = render(
    <GroupHeader
      name="Done"
      collapsed={collapsed}
      onToggle={() => (collapsed = !collapsed)}
    />
  );
  const chevron = screen.getByRole('button', { name: 'Collapse group' });
  expect(chevron.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(chevron);
  expect(collapsed).toBe(true);
  rerender(
    <GroupHeader name="Done" collapsed={collapsed} onToggle={() => {}} />
  );
  expect(
    screen
      .getByRole('button', { name: 'Expand group' })
      .getAttribute('aria-expanded')
  ).toBe('false');
});

test('there is no chevron without onToggle', () => {
  render(<GroupHeader name="Done" />);
  expect(screen.queryByRole('button', { name: /group/ })).toBeNull();
});

test('onAdd renders the + button and actions sit beside it', () => {
  let added = 0;
  render(
    <GroupHeader
      name="Todo"
      onAdd={() => added++}
      addLabel="New task"
      actions={<button type="button">Graph</button>}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'New task' }));
  expect(added).toBe(1);
  expect(screen.getByRole('button', { name: 'Graph' })).toBeDefined();
});
