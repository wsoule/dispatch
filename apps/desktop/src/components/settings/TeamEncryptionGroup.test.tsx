import type { ContentE2eStatus, TeamStatus } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import { accessFor, OPERATOR_ONLY, SettingsAccessProvider } from './access';
import { dataWith } from './fixtures.test-helper';
import {
  LEGACY_OPEN,
  NEEDS_UPDATE,
  NOT_ADMIN,
  TeamEncryptionGroup,
} from './TeamEncryptionGroup';

const TEAM: TeamStatus = {
  state: 'member',
  line: "Team 'acme' · 2 of 3 seats",
  team: { id: 'a'.repeat(32), name: 'acme' },
  role: 'admin',
  seats: { used: 2, total: 3 },
  sync: null,
  teammates: [],
  check: null,
  problems: [],
};

const READY: ContentE2eStatus = {
  on: false,
  since: null,
  sinceAt: null,
  current: null,
  epochs: [],
  missing: [],
  lacking: [],
  legacyClosed: true,
};

const ON: ContentE2eStatus = {
  on: true,
  since: 'a'.repeat(64),
  sinceAt: '2026-10-20T12:00:00.000Z',
  current: 'a'.repeat(64),
  epochs: [{ epoch: 'a'.repeat(64), held: true }],
  missing: [],
  lacking: [],
  legacyClosed: true,
};

const E2E_DISCLOSURE =
  'Team content is end-to-end encrypted. The relay can read the roster.';

function client(e2e: ContentE2eStatus | Error, team: TeamStatus = TEAM) {
  let current = e2e;
  return {
    baseUrl: 'http://127.0.0.1:1',
    getTeamStatus: mock(() => Promise.resolve(team)),
    getContentE2e: mock(() =>
      current instanceof Error
        ? Promise.reject(current)
        : Promise.resolve(current)
    ),
    getTeamKeys: mock(() =>
      Promise.resolve({ relayDisclosure: E2E_DISCLOSURE })
    ),
    enableContentE2e: mock(() => {
      current = ON;
      return Promise.resolve({ ...ON, ok: true as const });
    }),
  };
}

function mount(
  c: ReturnType<typeof client>,
  tier: 'operator' | 'decide' = 'operator'
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsAccessProvider access={accessFor(tier, false)}>
        <TeamEncryptionGroup
          data={dataWith({ presence: [], myTier: tier, client: c as never })}
        />
      </SettingsAccessProvider>
    </QueryClientProvider>
  );
}

const button = () => screen.getByTestId('team-e2e-on');

describe('TeamEncryptionGroup', () => {
  test('off and ready: the admin confirms the limits, then it turns on', async () => {
    const c = client(READY);
    mount(c);
    await screen.findByText('Every teammate’s build reads encrypted content.');
    expect(button().hasAttribute('disabled')).toBe(false);
    fireEvent.click(button());
    expect(await screen.findByText(/no forward secrecy/)).toBeTruthy();
    expect(screen.getByText(/stays readable on the relay/)).toBeTruthy();
    expect(c.enableContentE2e).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('team-e2e-confirm'));
    await waitFor(() => expect(c.enableContentE2e).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('team-e2e-disclosure')).textContent).toBe(
      E2E_DISCLOSURE
    );
    expect(screen.getByText('This machine holds every key')).toBeTruthy();
  });

  test('off and not ready: names who must update and why the switch is off', async () => {
    mount(
      client({
        ...READY,
        legacyClosed: false,
        lacking: [
          { replica: 'bob-0000000b', handle: 'bob' },
          { replica: 'cy-0000000c', handle: 'cy' },
        ],
      })
    );
    expect((await screen.findByTestId('team-e2e-lacking')).textContent).toBe(
      'Still need to update: bob, cy'
    );
    expect(screen.getByText(LEGACY_OPEN)).toBeTruthy();
    expect(button().hasAttribute('disabled')).toBe(true);
  });

  test('a teammate on an older build alone blocks it', async () => {
    mount(
      client({
        ...READY,
        lacking: [{ replica: 'bob-0000000b', handle: 'bob' }],
      })
    );
    expect(await screen.findByText(NEEDS_UPDATE)).toBeTruthy();
    expect(button().hasAttribute('disabled')).toBe(true);
  });

  test('a member who is not an admin sees it but cannot press it', async () => {
    mount(client(READY, { ...TEAM, role: 'member' }));
    expect(await screen.findByText(NOT_ADMIN)).toBeTruthy();
    expect(button().hasAttribute('disabled')).toBe(true);
  });

  test('below the operator tier the switch is locked with the reason', async () => {
    mount(client(READY), 'decide');
    expect(await screen.findByText(OPERATOR_ONLY)).toBeTruthy();
    expect(button().hasAttribute('disabled')).toBe(true);
  });

  test('on, with a key still missing: waits for a teammate', async () => {
    mount(
      client({
        ...ON,
        epochs: [...ON.epochs, { epoch: 'b'.repeat(64), held: false }],
        current: 'b'.repeat(64),
        missing: ['b'.repeat(64)],
      })
    );
    expect(
      await screen.findByText('Waiting for a key from a teammate')
    ).toBeTruthy();
    expect(screen.getByText('1 of 2 keys')).toBeTruthy();
    expect(screen.getByText(/^On since /)).toBeTruthy();
    expect(screen.queryByTestId('team-e2e-on')).toBeNull();
  });

  test('a refused switch shows the daemon’s reason', async () => {
    const c = client(READY);
    c.enableContentE2e = mock(() =>
      Promise.reject(
        new ApiError('close the legacy window first', 409, 'conflict')
      )
    );
    mount(c);
    fireEvent.click(await screen.findByTestId('team-e2e-on'));
    fireEvent.click(await screen.findByTestId('team-e2e-confirm'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'close the legacy window first'
    );
  });

  test('renders nothing outside a team', async () => {
    const c = client(READY, { ...TEAM, state: 'none', role: null });
    const { container } = mount(c);
    await waitFor(() => expect(c.getTeamStatus).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    expect(c.getContentE2e).not.toHaveBeenCalled();
  });
});
