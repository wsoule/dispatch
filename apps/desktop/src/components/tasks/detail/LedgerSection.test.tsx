import type { LedgerEntry } from '@dispatch/core/browser';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { LedgerSection } from './LedgerSection';

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

test('a policy auto-decision in the task ledger is marked as one', () => {
  render(
    <LedgerSection
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
  expect(screen.getAllByText('auto-decided')).toHaveLength(1);
  expect(screen.getByText('By hand')).toBeDefined();
});
