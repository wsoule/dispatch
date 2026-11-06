import type { ApiClient, PlanningAuditEntry } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { PlanningAuditGroup } from './PlanningAuditGroup';

// The audit lists each change with who made it, named from the people list.

const ENTRIES: PlanningAuditEntry[] = [
  {
    id: 2,
    at: new Date().toISOString(),
    by: 'human:ana',
    what: 'Weight of Beta',
    before: null,
    after: '2',
  },
  {
    id: 1,
    at: new Date().toISOString(),
    by: 'human:zed',
    what: 'Warn ahead',
    before: '7 days',
    after: '10 days',
  },
];

function mount(entries: PlanningAuditEntry[]) {
  const client = {
    fetchPlanningAudit: () => Promise.resolve(entries),
  } as unknown as ApiClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PlanningAuditGroup
        data={{
          client,
          port: 1,
          config: null,
          people: [{ ref: 'human:ana', name: 'Ana' }],
        }}
      />
    </QueryClientProvider>
  );
}

test('lists each change, before and after, and who made it', async () => {
  mount(ENTRIES);
  expect(await screen.findByText('Weight of Beta')).toBeTruthy();
  expect(screen.getByText('none → 2')).toBeTruthy();
  expect(screen.getByText('7 days → 10 days')).toBeTruthy();
  expect(screen.getByText('Ana')).toBeTruthy();
  // Someone the people list does not name keeps their ref.
  expect(screen.getByText('human:zed')).toBeTruthy();
});

test('says so when nothing has changed yet', async () => {
  mount([]);
  expect(await screen.findByText('No changes yet.')).toBeTruthy();
});
