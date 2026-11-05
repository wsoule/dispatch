import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { SpendTable } from './SpendTable';

afterEach(cleanup);

const rows = [
  { key: 'alpha', label: 'Alpha', sessionCount: 3, totalCostUsd: 1.5 },
  { key: 'beta', label: 'Beta', sessionCount: 1, totalCostUsd: 0.25 },
];

// Clickable rows are native buttons (the register row's stretched overlay), so Enter and
// Space come with the element; the active filter is a pressed state, not `aria-selected`.
test('clickable rows are buttons that expose the active filter as pressed', () => {
  const clicked: string[] = [];
  render(
    <SpendTable
      columnLabel="Project"
      rows={rows}
      emptyMessage="No spend"
      onRowClick={(key) => clicked.push(key)}
      activeKey="alpha"
    />
  );
  const buttons = screen.getAllByRole('button');
  expect(buttons).toHaveLength(2);
  const [alpha, beta] = buttons;
  if (alpha === undefined || beta === undefined) throw new Error('no rows');
  expect(alpha.tagName).toBe('BUTTON');
  expect(beta.tagName).toBe('BUTTON');
  expect(alpha.getAttribute('aria-label')).toBe('Alpha');
  expect(alpha.getAttribute('aria-pressed')).toBe('true');
  expect(beta.getAttribute('aria-pressed')).toBe('false');
  expect(alpha.hasAttribute('aria-selected')).toBe(false);
  // The active row keeps its data-active hook on the row itself.
  expect(alpha.closest('li')?.hasAttribute('data-active')).toBe(true);
  expect(beta.closest('li')?.hasAttribute('data-active')).toBe(false);

  fireEvent.click(beta);
  fireEvent.click(alpha);
  expect(clicked).toEqual(['beta', 'alpha']);
});

// Counts and spend print as their own cells; spend keeps two decimals.
test('rows show the session count and the spend in dollars', () => {
  render(
    <SpendTable columnLabel="Model" rows={rows} emptyMessage="No spend" />
  );
  expect(screen.getByRole('list', { name: 'Model spend' })).toBeDefined();
  expect(screen.getByText('$1.50')).toBeDefined();
  expect(screen.getByText('$0.25')).toBeDefined();
});

// Without a click handler the table is plain text: no buttons, no tab stops.
test('rows are inert when no click handler is given', () => {
  render(
    <SpendTable columnLabel="Model" rows={rows} emptyMessage="No spend" />
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(
    screen.getByText('Alpha').closest('li')?.hasAttribute('tabindex')
  ).toBe(false);
});

// No rows: the empty message instead of an empty panel.
test('an empty table shows its empty message', () => {
  render(<SpendTable columnLabel="Model" rows={[]} emptyMessage="No spend" />);
  expect(screen.getByText('No spend')).toBeDefined();
  expect(screen.queryByRole('list')).toBeNull();
});
