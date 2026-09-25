import type { BoardSyncStatus } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { accessFor, SettingsAccessProvider } from './access';
import { BoardSyncGroup, notSharingHint, syncedWhen } from './BoardSyncGroup';
import { dataWith } from './fixtures.test-helper';

// Mounted at the request tier: Sync now is its own route, open to any
// teammate, so nothing here may depend on being able to save config.
function mount(status: BoardSyncStatus) {
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    fetchBoardSyncStatus: mock(() => Promise.resolve(status)),
    syncBoardNow: mock(() => Promise.resolve(status)),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsAccessProvider access={accessFor('request', false)}>
        <BoardSyncGroup data={dataWith({ client: client as never })} />
      </SettingsAccessProvider>
    </QueryClientProvider>
  );
  return client;
}

const on: BoardSyncStatus = {
  enabled: true,
  replica: 'ada-1a2b3c4d',
  remote: 'git@example.com:team/repo.git',
  branch: 'dispatch-sync',
  lastSyncAt: '2026-09-23T10:00:00.000Z',
  lastError: null,
  pending: 0,
  applied: 3,
  problems: [],
  people: 2,
  seats: 3,
  paused: null,
};

test('off, it says how to turn it on', async () => {
  mount({ enabled: false, reason: 'off' });
  expect(await screen.findByText('Not sharing')).toBeTruthy();
  expect(screen.getByText(/Turn on sharing below/)).toBeTruthy();
});

// Already on in config: turning it on again is not the fix.
test('on but not started, it says what to check instead', async () => {
  mount({ enabled: false, reason: 'not-started' });
  expect(await screen.findByText('Not sharing')).toBeTruthy();
  expect(screen.getByText(/Sharing is on but didn.t start/)).toBeTruthy();
  expect(screen.queryByText(/Turn on sharing below/)).toBeNull();
});

test('an older daemon that gives no reason reads as off', () => {
  expect(notSharingHint(undefined)).toBe(notSharingHint('off'));
});

test('on, it names the branch and remote and offers to sync now', async () => {
  mount(on);
  expect(
    await screen.findByText('dispatch-sync on git@example.com:team/repo.git')
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: /Sync now/ })).toBeTruthy();
});

test('Sync now stays usable for a teammate who cannot change settings', async () => {
  mount(on);
  const button = await screen.findByRole('button', { name: /Sync now/ });
  expect(button.closest('fieldset')?.disabled).toBe(false);
});

test('a failed Sync now says why instead of failing silently', async () => {
  const client = mount(on);
  client.syncBoardNow.mockImplementation(() =>
    Promise.reject(new Error('remote hung up'))
  );
  fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }));
  expect(await screen.findByText(/sync: remote hung up/)).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: /Sync now/ }).disabled
  ).toBe(false);
});

test('an unreachable remote and waiting changes are said plainly', async () => {
  mount({ ...on, lastError: 'Could not resolve host', pending: 2 });
  expect(await screen.findByText(/Could not resolve host/)).toBeTruthy();
  expect(screen.getByText(/2 changes waiting/)).toBeTruthy();
});

test('a clash is shown as something that needs a person', async () => {
  mount({
    ...on,
    problems: [
      {
        task: 't-abc12345',
        message: 'created separately on two machines',
        at: 'x',
      },
    ],
  });
  expect(
    await screen.findByText('Needs your attention: t-abc12345')
  ).toBeTruthy();
});

test('syncedWhen reads the states a person sees', () => {
  expect(syncedWhen({ enabled: false })).toBe('Off');
  expect(syncedWhen({ ...on, lastSyncAt: null })).toBe('Not synced yet');
  expect(syncedWhen(on)).toMatch(/^Synced /);
});

test('past the seats it says it is paused, not that the remote is down', async () => {
  mount({
    ...on,
    paused:
      'Board sync is paused on this machine: more people share this board than the license covers (the free plan covers 3).',
  });
  expect(
    await screen.findByText(/Board sync is paused on this machine/)
  ).toBeTruthy();
  expect(screen.queryByText(/reach the remote/)).toBeNull();
});
