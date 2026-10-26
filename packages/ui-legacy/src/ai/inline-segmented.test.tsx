import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { InlineSegmented } from './inline-segmented';

const OPTIONS = [
  { id: 'people', label: 'People' },
  { id: 'all', label: 'All' },
] as const;

test('a radiogroup with one tab stop; click and arrows both pick', () => {
  const picked: string[] = [];
  render(
    <InlineSegmented
      label="Show"
      options={OPTIONS}
      value="people"
      onChange={(id) => picked.push(id)}
    />
  );
  const group = screen.getByRole('radiogroup', { name: 'Show' });
  const people = screen.getByRole('radio', { name: 'People' });
  const all = screen.getByRole('radio', { name: 'All' });
  expect(people.getAttribute('aria-checked')).toBe('true');
  expect(people.tabIndex).toBe(0);
  expect(all.tabIndex).toBe(-1);
  fireEvent.click(all);
  fireEvent.keyDown(group, { key: 'ArrowLeft' });
  expect(picked).toEqual(['all', 'all']);
});
