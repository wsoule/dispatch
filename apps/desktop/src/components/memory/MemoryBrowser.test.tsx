import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { entry, proposal } from '../../lib/memory.test-helper';
import { MemoryBrowser } from './MemoryBrowser';

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
      <MemoryBrowser data={data} />
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

test('opens an entry under the list', async () => {
  mount();
  fireEvent.click(await screen.findByText('terse comments'));
  expect(
    await screen.findByRole('region', { name: 'Memory entry' })
  ).toBeTruthy();
});

test('draws the scopes as a tab strip whose panel is labelled by the open tab', async () => {
  mount();
  expect(await screen.findByText('terse comments')).toBeTruthy();
  const strip = screen.getByRole('tablist', { name: 'Memory' });
  const names = within(strip)
    .getAllByRole('tab')
    .map((t) => t.textContent);
  expect(names).toEqual([
    'Personal 1',
    'Project 1',
    'Team 1',
    'Proposals',
    'Stale 1',
  ]);
  const personal = screen.getByRole('tab', { name: 'Personal 1' });
  expect(personal.getAttribute('aria-selected')).toBe('true');
  const panel = screen.getByRole('tabpanel');
  expect(panel.getAttribute('aria-labelledby')).toBe(personal.id);
  expect(personal.getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.contains(list())).toBe(true);
  // Arrow keys move the selection like a click.
  fireEvent.keyDown(personal, { key: 'ArrowRight' });
  const project = screen.getByRole('tab', { name: 'Project 1' });
  expect(project.getAttribute('aria-selected')).toBe('true');
  expect(personal.getAttribute('aria-selected')).toBe('false');
  expect(within(list()).getByText('proto shims')).toBeTruthy();
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
    project.id
  );
});

test('marks the open entry current and closes it when another tab is picked', async () => {
  mount();
  fireEvent.click(await screen.findByText('terse comments'));
  expect(
    await screen.findByRole('region', { name: 'Memory entry' })
  ).toBeTruthy();
  const row = within(list()).getByRole('button', { name: /terse comments/ });
  expect(row.getAttribute('aria-current')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: /Project/ }));
  expect(screen.queryByRole('region', { name: 'Memory entry' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /Personal/ }));
  expect(screen.queryByRole('region', { name: 'Memory entry' })).toBeNull();
  const again = within(list()).getByRole('button', { name: /terse comments/ });
  expect(again.getAttribute('aria-current')).toBeNull();
});

test('picking the selected tab again closes the open entry', async () => {
  mount();
  fireEvent.click(await screen.findByText('terse comments'));
  expect(
    await screen.findByRole('region', { name: 'Memory entry' })
  ).toBeTruthy();
  const personal = screen.getByRole('tab', { name: /Personal/ });
  expect(personal.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(personal);
  expect(screen.queryByRole('region', { name: 'Memory entry' })).toBeNull();
  // Still on Personal, with nothing marked current.
  expect(personal.getAttribute('aria-selected')).toBe('true');
  const row = within(list()).getByRole('button', { name: /terse comments/ });
  expect(row.getAttribute('aria-current')).toBeNull();
});

test('shows skeleton rows and no counts while the entries load', () => {
  const client = {
    listMemory: () => new Promise(() => undefined),
    listMemoryProposals: () => new Promise(() => undefined),
  } as unknown as ApiClient;
  const data = {
    client,
    port: 1,
    me: 'human:wyat',
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
  } as unknown as DispatchProjectData;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryBrowser data={data} />
    </QueryClientProvider>
  );
  const strip = screen.getByRole('tablist', { name: 'Memory' });
  expect(
    within(strip)
      .getAllByRole('tab')
      .map((t) => t.textContent)
  ).toEqual(['Personal', 'Project', 'Team', 'Proposals', 'Stale']);
  const status = within(screen.getByRole('tabpanel')).getByRole('status');
  expect(status.getAttribute('aria-busy')).toBe('true');
  expect(status.textContent).toContain('Loading memory…');
  expect(screen.queryByText('Nothing here yet.')).toBeNull();
});

test('says why memory is unavailable without a token', () => {
  const data = {
    client: {} as ApiClient,
    port: 1,
    me: 'human:wyat',
    messageAccess: {
      canDecide: false,
      canMessage: false,
      explanation: 'Memory needs an app token in this window.',
    },
  } as unknown as DispatchProjectData;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryBrowser data={data} />
    </QueryClientProvider>
  );
  expect(
    screen.getByText('Memory needs an app token in this window.')
  ).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
});
