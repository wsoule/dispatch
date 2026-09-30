import type { LedgerEntry } from '@dispatch/core/browser';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ReceiptsSection } from './ReceiptsSection';

const classesOf = (el: Element | null) =>
  (el?.getAttribute('class') ?? '').split(/\s+/);

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'l-000001',
    epicId: null,
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

// Sub-headings are sentence-case 12px/500 with a plain count — no uppercase,
// no `·` separator — and the section heading carries the total on the right.
test('groups under sentence-case sub-headings with a count', () => {
  const { container } = render(
    <ReceiptsSection
      entries={[
        entry({ id: 'l-1', kind: 'constraint', title: 'Keep the API' }),
        entry({ id: 'l-2', kind: 'constraint', title: 'No new deps' }),
        entry({ id: 'l-3', kind: 'hazard', title: 'A hazard' }),
      ]}
    />
  );
  expect(screen.getByText('Receipts')).toBeDefined();
  const constraints = screen.getByText('Constraints');
  expect(classesOf(constraints)).toContain('text-[12px]');
  expect(classesOf(constraints)).toContain('font-medium');
  expect(classesOf(constraints)).not.toContain('uppercase');
  expect(constraints.textContent).toBe('Constraints2');
  expect(screen.getByText('Hazards')).toBeDefined();
  expect(screen.queryByText(/CONSTRAINT/)).toBeNull();
  expect(
    container.querySelectorAll('[data-slot="receipt-group"]')
  ).toHaveLength(2);
});

// Each entry is a comment card: quaternary surface, 8px radius, half-pixel
// border; the source task id sits in sans, not mono.
test('renders each entry as a comment card with a sans source id', () => {
  const { container } = render(
    <ReceiptsSection
      entries={[entry({ id: 'l-1', sourceTaskId: 't-1a2b3c' })]}
    />
  );
  const card = container.querySelector('[data-slot="receipt-entry"]');
  const classes = classesOf(card);
  expect(classes).toContain('bg-surface-quaternary');
  expect(classes).toContain('rounded-card');
  expect(classes).toContain('border-[0.5px]');
  expect(classes).toContain('border-border-strong');
  const source = screen.getByText('t-1a2b3c');
  expect(classesOf(source)).toContain('font-book');
  expect(classesOf(source)).not.toContain('font-mono');
});

test('renders nothing when the task has no receipts', () => {
  const { container } = render(<ReceiptsSection entries={[]} />);
  expect(container.firstElementChild).toBeNull();
});
