import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { RehomePanel } from './RehomePanel';

function mount(others: { key: string; count: number }[]) {
  const rehomeMemory = mock((_from: string) => Promise.resolve({ moved: 2 }));
  const client = {
    memoryProjectKeys: () =>
      Promise.resolve({ current: 'aaaaaaaaaaaa', others }),
    rehomeMemory,
  } as unknown as ApiClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RehomePanel client={client} port={1} />
    </QueryClientProvider>
  );
  return rehomeMemory;
}

test('renders nothing while no entry is narrowed to another checkout', async () => {
  mount([]);
  await Bun.sleep(20);
  expect(screen.queryByRole('button', { name: /Move them/ })).toBeNull();
});

test('names the other checkout and moves its entries here on request', async () => {
  const rehome = mount([{ key: 'bbbbbbbbbbbb', count: 2 }]);
  expect(
    await screen.findByText(
      '2 entries are narrowed to another checkout (key bbbbbbbbbbbb)'
    )
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Move them to this project' })
  );
  await waitFor(() => expect(rehome).toHaveBeenCalledWith('bbbbbbbbbbbb'));
});

test('says why a move failed, in the danger tone, inside its settings slot', async () => {
  const rehomeMemory = mock((_from: string) =>
    Promise.reject(new Error('the daemon refused the move'))
  );
  const client = {
    memoryProjectKeys: () =>
      Promise.resolve({
        current: 'aaaaaaaaaaaa',
        others: [{ key: 'cccccccccccc', count: 1 }],
      }),
    rehomeMemory,
  } as unknown as ApiClient;
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <RehomePanel client={client} port={1} />
    </QueryClientProvider>
  );
  expect(
    await screen.findByText(
      '1 entry is narrowed to another checkout (key cccccccccccc)'
    )
  ).toBeTruthy();
  expect(container.querySelector('[data-slot="memory-rehome"]')).not.toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Move them to this project' })
  );
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('the daemon refused the move');
  expect(alert.classList.contains('toneText')).toBe(true);
  expect(alert.getAttribute('data-tone')).toBe('danger');
  expect(
    screen
      .getByRole('button', { name: 'Move them to this project' })
      .hasAttribute('disabled')
  ).toBe(false);
});
