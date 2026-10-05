import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { entry, proposal } from '../lib/memory.test-helper';
import { MemoryView } from './MemoryView';

function mount() {
  const listMemory = mock((_q?: unknown) =>
    Promise.resolve({
      entries: [
        entry({ id: 'mem-p', scope: 'personal', title: 'terse comments' }),
        entry({ id: 'mem-j', scope: 'project', title: 'proto shims' }),
        entry({
          id: 'mem-t',
          scope: 'team',
          title: 'deploys freeze on Fridays',
          origin: 'sync:ada-0000000a:mem-t',
          author: 'human:ada',
        }),
        entry({
          id: 'mem-s',
          scope: 'team',
          state: 'stale',
          title: 'old lesson',
        }),
      ],
    })
  );
  const listMemoryProposals = mock((_state?: unknown) =>
    Promise.resolve({ proposals: [proposal()] })
  );
  const client = {
    listMemory,
    listMemoryProposals,
    memoryProjectKeys: () =>
      Promise.resolve({ current: 'aaaaaaaaaaaa', others: [] }),
    getMemory: (id: string) =>
      Promise.resolve({ entry: entry({ id }), revisions: [], recallCount: 0 }),
  } as unknown as ApiClient;
  const data = {
    client,
    port: 1,
    me: 'human:wyat',
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
  } as unknown as DispatchProjectData;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryView data={data} />
    </QueryClientProvider>
  );
  return { listMemory, listMemoryProposals };
}

const list = () => screen.getByRole('list', { name: 'Memory entries' });

test('opens on Personal and moves between the scope tabs', async () => {
  const { listMemory } = mount();
  expect(await screen.findByText('terse comments')).toBeTruthy();
  expect(listMemory).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: /Project/ }));
  expect(within(list()).getByText('proto shims')).toBeTruthy();
  expect(within(list()).queryByText('terse comments')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /Team/ }));
  expect(within(list()).getByText('deploys freeze on Fridays')).toBeTruthy();
  // Replicated from a teammate's machine (federation's MemorySync).
  expect(within(list()).getByText(/from a teammate’s machine/)).toBeTruthy();
  expect(within(list()).queryByText('old lesson')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /Stale/ }));
  expect(within(list()).getByText('old lesson')).toBeTruthy();
});

test('lists open proposals under Proposals', async () => {
  const { listMemoryProposals } = mount();
  fireEvent.click(await screen.findByRole('tab', { name: /Proposals/ }));
  expect(
    await screen.findByText('pnpm 11 ignores onlyBuiltDependencies')
  ).toBeTruthy();
  expect(listMemoryProposals).toHaveBeenCalledWith('open');
});

test('opens an entry beside the list', async () => {
  mount();
  fireEvent.click(await screen.findByText('terse comments'));
  expect(
    await screen.findByRole('region', { name: 'Memory entry' })
  ).toBeTruthy();
});
