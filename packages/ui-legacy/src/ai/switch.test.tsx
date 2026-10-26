import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { Switch } from './switch';

test('the switch is a 28×16 pill that turns indigo when on', () => {
  render(<Switch aria-label="Show sub-issues" defaultChecked={false} />);
  const toggle = screen.getByRole('switch', { name: 'Show sub-issues' });
  const classes = toggle.className.split(/\s+/);
  expect(classes).toContain('h-4');
  expect(classes).toContain('w-7');
  expect(classes).toContain('data-checked:bg-primary');
  expect(toggle.hasAttribute('data-checked')).toBe(false);
  fireEvent.click(toggle);
  expect(toggle.hasAttribute('data-checked')).toBe(true);
});

test('onCheckedChange receives the new boolean first', () => {
  let next: boolean | undefined;
  render(
    <Switch
      aria-label="Nested"
      checked={false}
      onCheckedChange={(checked) => (next = checked)}
    />
  );
  fireEvent.click(screen.getByRole('switch'));
  expect(next).toBe(true);
});

// In a settings row the label sits on the left and the whole row is the control.
test('a label renders a row with the label on the left', () => {
  const { container } = render(<Switch label="Show empty groups" />);
  const row = container.firstElementChild as HTMLElement;
  expect(row.tagName).toBe('LABEL');
  expect(row.firstElementChild?.textContent).toBe('Show empty groups');
  expect(
    screen.getByRole('switch', { name: 'Show empty groups' })
  ).toBeDefined();
});
