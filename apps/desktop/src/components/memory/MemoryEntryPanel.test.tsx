import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { entry } from '../../lib/memory.test-helper';
import { MemoryEntryPanel } from './MemoryEntryPanel';

const ok = () => Promise.resolve(entry());

function mount(
  shown: ReturnType<typeof entry>,
  viewer: { canDecide: boolean; me: string }
) {
  const client = {
    getMemory: () =>
      Promise.resolve({
        entry: shown,
        revisions: [
          {
            memoryId: shown.id,
            rev: 1,
            by: 'run:r-9f2c01',
            cause: 'save',
            at: '2026-09-01T10:00:00.000Z',
          },
        ],
        recallCount: 7,
      }),
    pinMemory: mock(ok),
    retireMemory: mock(ok),
    confirmMemory: mock(ok),
    promoteMemory: mock(ok),
    deleteMemory: mock(() => Promise.resolve()),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryEntryPanel
        entry={shown}
        client={client as unknown as ApiClient}
        port={1}
        viewer={viewer}
      />
    </QueryClientProvider>
  );
  return client;
}

test('shows provenance, revisions and the recall count', async () => {
  mount(entry({ trust: 'agent' }), { canDecide: true, me: 'human:wyat' });
  expect(await screen.findByText('Recalled 7 times')).toBeTruthy();
  expect(screen.getByText(/rev 1: save by run:r-9f2c01/)).toBeTruthy();
  expect(screen.getByText(/Team hazard/)).toBeTruthy();
});

test('offers a decider pin, confirm, retire and delete on an agent team entry', async () => {
  const client = mount(entry({ trust: 'agent' }), {
    canDecide: true,
    me: 'human:wyat',
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Pin' }));
  await waitFor(() =>
    expect(client.pinMemory).toHaveBeenCalledWith('mem-000001', true)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(client.confirmMemory).toHaveBeenCalledWith('mem-000001')
  );
  fireEvent.change(screen.getByLabelText('Why retire it'), {
    target: { value: 'no longer true' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
  await waitFor(() =>
    expect(client.retireMemory).toHaveBeenCalledWith(
      'mem-000001',
      'no longer true'
    )
  );
  expect(screen.queryByRole('button', { name: /Promote/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(client.deleteMemory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
  await waitFor(() =>
    expect(client.deleteMemory).toHaveBeenCalledWith('mem-000001')
  );
});

test('offers a teammate below the decide tier only a retire, which proposes', async () => {
  mount(entry({ trust: 'agent' }), { canDecide: false, me: 'human:ada' });
  expect(await screen.findByRole('button', { name: 'Retire' })).toBeTruthy();
  for (const name of ['Pin', 'Confirm', 'Delete'])
    expect(screen.queryByRole('button', { name })).toBeNull();
});

test('promotes your own personal entry to project or team memory', async () => {
  const client = mount(entry({ scope: 'personal', author: 'run:r-9f2c01' }), {
    canDecide: true,
    me: 'human:wyat',
  });
  fireEvent.click(
    await screen.findByRole('button', { name: 'Promote to team' })
  );
  await waitFor(() =>
    expect(client.promoteMemory).toHaveBeenCalledWith('mem-000001', 'team')
  );
});
