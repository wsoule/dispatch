import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { Segmented } from './Segmented';

const OPTIONS = [
  { value: 'board', label: 'Board' },
  { value: 'lanes', label: 'Lanes' },
  { value: 'list', label: 'List' },
];

test('the selected option is marked pressed', () => {
  render(
    <Segmented
      label="View"
      value="lanes"
      options={OPTIONS}
      onChange={() => {}}
    />
  );
  // Radix ToggleGroup type="single" exposes role="radio"/aria-checked
  // rather than role="button"/aria-pressed; query mechanics only.
  expect(
    screen.getByRole('radio', { name: 'Lanes' }).getAttribute('aria-checked')
  ).toBe('true');
  expect(
    screen.getByRole('radio', { name: 'Board' }).getAttribute('aria-checked')
  ).toBe('false');
});

test('clicking an option reports it', () => {
  let picked = '';
  render(
    <Segmented
      label="View"
      value="board"
      options={OPTIONS}
      onChange={(next) => {
        picked = next;
      }}
    />
  );
  fireEvent.click(screen.getByRole('radio', { name: 'List' }));
  expect(picked).toBe('list');
});

// The behavioural change this task makes: an icon option keeps its label
// visible, the way diffs.com presents Split/Stacked, instead of replacing it.
test('an icon option still renders its label', () => {
  render(
    <Segmented
      label="View"
      value="board"
      options={[{ value: 'board', label: 'Board', icon: <svg /> }]}
      onChange={() => {}}
    />
  );
  expect(screen.getByText('Board')).toBeDefined();
});

// The group keeps naming itself for screen readers — a regression here would
// silently undo work the existing component already did correctly.
test('the group is named for assistive tech', () => {
  render(
    <Segmented
      label="View"
      value="board"
      options={OPTIONS}
      onChange={() => {}}
    />
  );
  // Radix ToggleGroup type="single" reports role="radiogroup" rather than
  // "group"; query mechanics only, the group is still named "View".
  expect(screen.getByRole('radiogroup', { name: 'View' })).toBeDefined();
});
