import type { TeamStatus } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import { accessFor, SettingsAccessProvider } from './access';
import { dataWith } from './fixtures.test-helper';
import { TeamSetupGroup } from './TeamSetupGroup';

function status(over: Partial<TeamStatus> = {}): TeamStatus {
  return {
    state: 'none',
    line: 'Not in a team yet · start one, or join with an invite link',
    team: null,
    role: null,
    seats: null,
    sync: null,
    teammates: [],
    check: null,
    problems: [],
    ...over,
  };
}

const MEMBER = status({
  state: 'member',
  line: "Team 'acme' · 2 of 3 seats · syncing via relay.dispatch.foo · last sync 4s ago",
  team: { id: 'a'.repeat(32), name: 'acme' },
  role: 'admin',
  seats: { used: 2, total: 3 },
  teammates: [
    { handle: 'ada', device: 'laptop', role: 'admin', you: true, check: null },
    {
      handle: 'bob',
      device: 'desk',
      role: 'member',
      you: false,
      check: '123 456',
    },
  ],
});

function client(initial: TeamStatus) {
  return {
    baseUrl: 'http://127.0.0.1:1',
    getTeamStatus: mock(() => Promise.resolve(initial)),
    startTeam: mock(() =>
      Promise.resolve({
        teamId: 'a'.repeat(32),
        name: 'acme',
        recoveryCode: 'RECOVERY-CODE',
        fingerprint: 'FP',
        transport: { kind: 'relay', url: 'wss://relay.dispatch.foo' },
        notice: null,
      })
    ),
    inviteToTeam: mock((handle: string) =>
      Promise.resolve({
        code: 'di1.x',
        expires: '2026-10-13T00:00:00.000Z',
        handle,
        link: 'dispatch-team:LINK',
      })
    ),
    joinTeam: mock(() =>
      Promise.resolve({
        team: { id: 'a'.repeat(32), name: 'acme' },
        by: 'ada',
        check: '654 321',
      })
    ),
  };
}

function mount(c: ReturnType<typeof client>, tier: 'operator' | 'decide') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsAccessProvider access={accessFor(tier, false)}>
        <TeamSetupGroup
          data={dataWith({ presence: [], myTier: tier, client: c as never })}
        />
      </SettingsAccessProvider>
    </QueryClientProvider>
  );
}

describe('TeamSetupGroup', () => {
  test('starts a team in one press, beside the relay disclosure, and shows the recovery code', async () => {
    const c = client(status());
    mount(c, 'operator');
    await screen.findByTestId('team-status-line');
    expect(screen.getByText(/The relay can read everything/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('team-start'));
    await waitFor(() =>
      expect(screen.getByTestId('team-recovery-code').textContent).toBe(
        'RECOVERY-CODE'
      )
    );
    expect(c.startTeam).toHaveBeenCalledWith({ confirmed: true });
  });

  test('offers start and join while team sync is still off', async () => {
    mount(client(status({ state: 'off' })), 'operator');
    expect(await screen.findByTestId('team-start')).toBeTruthy();
    expect(screen.getByTestId('team-join')).toBeTruthy();
  });

  test('joins with a pasted link and shows the optional check', async () => {
    const c = client(status());
    mount(c, 'operator');
    fireEvent.change(await screen.findByLabelText('Invite link'), {
      target: { value: '  dispatch-team:LINK ' },
    });
    fireEvent.click(screen.getByTestId('team-join'));
    await waitFor(() =>
      expect(screen.getByTestId('team-join-check').textContent).toContain(
        '654 321'
      )
    );
    expect(c.joinTeam).toHaveBeenCalledWith('dispatch-team:LINK');
  });

  test('a member sees the status line, each teammate’s check, and invites with one link to copy', async () => {
    const c = client(MEMBER);
    mount(c, 'operator');
    expect((await screen.findByTestId('team-status-line')).textContent).toBe(
      MEMBER.line
    );
    expect(screen.getByText(/optional check 123 456/)).toBeTruthy();
    expect(screen.queryByTestId('team-start')).toBeNull();
    expect(screen.queryByTestId('team-join')).toBeNull();
    fireEvent.change(screen.getByLabelText('Email or handle to invite'), {
      target: { value: 'cy@example.com' },
    });
    fireEvent.click(screen.getByTestId('team-invite'));
    await waitFor(() =>
      expect(screen.getByTestId('team-invite-link').textContent).toBe(
        'dispatch-team:LINK'
      )
    );
    expect(c.inviteToTeam).toHaveBeenCalledWith('cy@example.com');
    expect(
      screen.getByRole('button', { name: 'Copy invite link' })
    ).toBeTruthy();
    // Beside the link: where the invited person pastes it.
    expect(
      screen.getByText(
        /go to Settings → Members, and paste it under Join a team/
      )
    ).toBeTruthy();
  });

  test('below operator it shows the status but offers no start, join or invite', async () => {
    mount(client(status()), 'decide');
    await screen.findByTestId('team-status-line');
    expect(screen.queryByTestId('team-start')).toBeNull();
    expect(screen.queryByTestId('team-join')).toBeNull();
  });

  test('shows a problem and its fix as plain text', async () => {
    mount(
      client(
        status({
          ...MEMBER,
          problems: [
            {
              message: '<b>not bold</b>',
              fix: 'dispatch sync now',
            },
          ],
        })
      ),
      'operator'
    );
    expect(await screen.findByText('<b>not bold</b>')).toBeTruthy();
    expect(screen.getByText('dispatch sync now')).toBeTruthy();
  });
});
