import type { LedgerEntry } from '@dispatch-foo/core/browser';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ReceiptsSection } from './ReceiptsSection';

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'l-000001',
    milestoneId: null,
    sourceTaskId: 't-aaaaaa',
    kind: 'decision',
    title: 'Scope extended for run r-x',
    detail: 'src/x.ts — needed',
    appliesTo: [],
    authoredBy: 'human:x',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

test("a policy auto-decision among the task's receipts is marked as one", () => {
  render(
    <ReceiptsSection
      entries={[
        entry({
          id: 'l-1',
          detail: 'granted — auto-decided by policy rung 2 (auto-scope)',
        }),
        entry({
          id: 'l-2',
          title: 'By hand',
          detail: 'granted [decided via app]',
        }),
        entry({ id: 'l-3', kind: 'hazard', title: 'A hazard' }),
      ]}
    />
  );
  expect(screen.getAllByText('Auto-decided')).toHaveLength(1);
  expect(screen.getByText('By hand')).toBeDefined();
});

// Sub-headings are sentence case with a plain count, in kind order, no `·`
// separator and no shouting (the gr8r-rules scan keeps text-transform out of
// the module); the section heading carries the total.
test('groups under sentence-case sub-headings with a count', () => {
  const { container } = render(
    <ReceiptsSection
      entries={[
        entry({ id: 'l-3', kind: 'hazard', title: 'A hazard' }),
        entry({ id: 'l-1', kind: 'constraint', title: 'Keep the API' }),
        entry({ id: 'l-2', kind: 'constraint', title: 'No new deps' }),
      ]}
    />
  );
  expect(
    screen.getByRole('heading', { name: /^Receipts\b.*3$/ })
  ).toBeDefined();
  const groups = Array.from(
    container.querySelectorAll('[data-slot="receipt-group"]')
  );
  expect(groups).toHaveLength(2);
  const constraints = screen.getByText('Constraints');
  expect(constraints.textContent).toBe('Constraints2');
  expect(groups[0]?.contains(constraints)).toBe(true);
  expect(groups[1]?.contains(screen.getByText('Hazards'))).toBe(true);
  expect(
    Array.from(groups[0]?.querySelectorAll('[data-slot="receipt-entry"]') ?? [])
      .length
  ).toBe(2);
  expect(screen.queryByText(/CONSTRAINT/)).toBeNull();
  expect(container.textContent).not.toContain('·');
});

// Each entry is a comment card: its title, its detail, and the source task id
// at the right, set in mono because an id is a machine-read string.
test('renders each entry as a card with its source task id in mono', () => {
  const { container } = render(
    <ReceiptsSection
      entries={[entry({ id: 'l-1', sourceTaskId: 't-1a2b3c' })]}
    />
  );
  const card = container.querySelector('[data-slot="receipt-entry"]');
  expect(card?.textContent).toContain('Scope extended for run r-x');
  expect(card?.textContent).toContain('src/x.ts — needed');
  const source = card?.querySelector('[data-slot="receipt-source"]');
  expect(source?.textContent).toBe('t-1a2b3c');
  expect(source?.classList.contains('mono')).toBe(true);
});

test('leaves the source out when no task raised the entry', () => {
  const { container } = render(
    <ReceiptsSection entries={[entry({ id: 'l-1', sourceTaskId: null })]} />
  );
  expect(container.querySelector('[data-slot="receipt-source"]')).toBeNull();
});

test('renders nothing when the task has no receipts', () => {
  const { container } = render(<ReceiptsSection entries={[]} />);
  expect(container.firstElementChild).toBeNull();
});
