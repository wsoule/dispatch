import type { ApiClient, MemoryEntryView } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import { entry } from '../../../lib/memory.test-helper';
import { MemoryReachSection } from './MemoryReachSection';

function renderSection(listMemory: ApiClient['listMemory']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryReachSection
        client={{ listMemory }}
        port={4321}
        taskId="t-1a2b3c"
      />
    </QueryClientProvider>
  );
}

const entries = (list: MemoryEntryView[]) =>
  mock((_q?: Parameters<ApiClient['listMemory']>[0]) =>
    Promise.resolve({ entries: list })
  );

describe('MemoryReachSection', () => {
  it('lists the entries that reach the task, with where each came from', async () => {
    const listMemory = entries([
      entry({ title: 'pnpm builds', body: 'Use allowBuilds.' }),
      entry({
        id: 'mem-000002',
        scope: 'project',
        kind: 'fact',
        title: 'proto shims',
        body: 'Symlink the proto binary.',
        origin: 'ledger:l-000001@2026-09-01T00:00:00.000Z',
        author: 'agent:dispatch',
        trust: 'agent',
      }),
    ]);
    renderSection(listMemory);
    expect(await screen.findByText('pnpm builds')).toBeTruthy();
    expect(listMemory).toHaveBeenCalledWith({
      taskId: 't-1a2b3c',
      limit: 200,
    });
    // Bodies sit collapsed under their title, so the list stays dense.
    const body = screen.getByText('Use allowBuilds.');
    expect(body.closest('details')?.open).toBe(false);
    expect(
      screen.getByText('Team hazard · by human:wyat · human-written')
    ).toBeTruthy();
    expect(
      screen.getByText('Project fact · from the ledger · unreviewed')
    ).toBeTruthy();
    expect(screen.getByText('Memory')).toBeTruthy();
    // Read-only: the task page offers nothing to change an entry with.
    expect(
      screen.queryAllByRole('button').filter((b) => b.tagName !== 'SUMMARY')
    ).toHaveLength(0);
  });

  it('says when more entries reach the task than it lists', async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      entry({
        id: `mem-${String(i).padStart(6, '0')}`,
        title: `lesson ${i}`,
      })
    );
    renderSection(entries(full));
    expect(await screen.findByText('first 200')).toBeTruthy();
  });

  it('renders nothing when no entry reaches the task', async () => {
    const listMemory = entries([]);
    const { container } = renderSection(listMemory);
    await waitFor(() => expect(listMemory).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('says when memory could not be read', async () => {
    renderSection(() => Promise.reject(new Error('memory is unavailable')));
    expect(await screen.findByText(/memory is unavailable/)).toBeTruthy();
  });
});
