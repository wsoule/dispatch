import type { TeamStatus } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { DaemonTakeover } from '../../lib/daemonAuth';
import {
  accessFor,
  ATTACHED_BACKGROUND_READ_ONLY,
  SettingsAccessProvider,
} from './access';
import { dataWith, testConfig } from './fixtures.test-helper';
import {
  takeoverBusyReason,
  takeoverParkedConfirm,
  takeoverWaitingNotice,
} from './TakeOverDaemon';
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

function mount(
  c: ReturnType<typeof client>,
  tier: 'operator' | 'decide' | 'request',
  attached: Partial<DispatchProjectData> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const takeover = attached.takeover ?? null;
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsAccessProvider
        access={accessFor(
          tier,
          takeover !== null,
          takeover?.background === true
        )}
      >
        <TeamSetupGroup
          data={dataWith({
            presence: [],
            myTier: tier,
            client: c as never,
            ...attached,
          })}
        />
      </SettingsAccessProvider>
    </QueryClientProvider>
  );
}

const IDLE: DaemonTakeover = {
  background: false,
  busy: [],
  parked: 0,
  waiting: 0,
};

describe('TeamSetupGroup', () => {
  test('starts a team in a separate board repo, beside the relay disclosure, and shows the recovery code', async () => {
    const c = client(status());
    mount(c, 'operator');
    await screen.findByTestId('team-status-line');
    expect(screen.getByText(/The relay can read everything/)).toBeTruthy();
    // Nowhere chosen yet: a board repo URL comes first.
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(
      true
    );
    fireEvent.change(screen.getByLabelText('Board repo URL'), {
      target: { value: ' git@example.com:acme/board.git ' },
    });
    fireEvent.click(screen.getByTestId('team-start'));
    await waitFor(() =>
      expect(screen.getByTestId('team-recovery-code').textContent).toBe(
        'RECOVERY-CODE'
      )
    );
    expect(c.startTeam).toHaveBeenCalledWith({
      confirmed: true,
      repo: 'git@example.com:acme/board.git',
    });
  });

  test('or on a branch of this project’s repo', async () => {
    const c = client(status());
    mount(c, 'operator');
    fireEvent.click(
      await screen.findByRole('radio', { name: /This project’s repo/ })
    );
    expect(screen.queryByLabelText('Board repo URL')).toBeNull();
    fireEvent.click(screen.getByTestId('team-start'));
    await waitFor(() =>
      expect(c.startTeam).toHaveBeenCalledWith({
        confirmed: true,
        remote: 'origin',
      })
    );
  });

  test('starts where config.yml already keeps the board, and says where', async () => {
    const c = client(status());
    mount(c, 'operator', {
      config: {
        ...testConfig,
        sync: {
          enabled: true,
          repo: 'git@example.com:acme/board.git',
          branch: 'dispatch-sync',
          intervalSec: 30,
        },
      },
    });
    expect(
      (await screen.findByTestId('team-start-place')).textContent
    ).toContain('git@example.com:acme/board.git');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.click(screen.getByTestId('team-start'));
    await waitFor(() =>
      expect(c.startTeam).toHaveBeenCalledWith({ confirmed: true })
    );
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

  // The invite chose a local or private repo: say so, and join only on a yes.
  test('holds a link whose board repo is local until Join anyway', async () => {
    const c = client(status());
    c.joinTeam
      .mockImplementationOnce(() =>
        Promise.reject(
          new ApiError(
            "This invite keeps the team's board at /srv/board.git, a path on this machine.",
            409,
            'confirm_repo'
          )
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          team: { id: 'a'.repeat(32), name: 'acme' },
          by: 'ada',
          check: '654 321',
        })
      );
    mount(c, 'operator');
    fireEvent.change(await screen.findByLabelText('Invite link'), {
      target: { value: 'dispatch-team:LINK' },
    });
    fireEvent.click(screen.getByTestId('team-join'));
    expect(
      (await screen.findByTestId('team-join-repo-warning')).textContent
    ).toContain('/srv/board.git');
    expect(screen.queryByTestId('team-join-check')).toBeNull();
    fireEvent.click(screen.getByTestId('team-join-confirm-repo'));
    await waitFor(() =>
      expect(screen.getByTestId('team-join-check').textContent).toContain(
        '654 321'
      )
    );
    expect(c.joinTeam).toHaveBeenLastCalledWith('dispatch-team:LINK', {
      confirmRepo: true,
    });
    expect(screen.queryByTestId('team-join-repo-warning')).toBeNull();
  });

  test('while a join waits to be let in, it offers no second join or start', async () => {
    mount(
      client(status({ state: 'joining', line: 'Joining team acme' })),
      'operator'
    );
    expect((await screen.findByTestId('team-status-line')).textContent).toBe(
      'Joining team acme'
    );
    expect(screen.queryByTestId('team-join')).toBeNull();
    expect(screen.queryByTestId('team-start')).toBeNull();
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

  // The owner's own window, attached to a daemon it did not start: the start
  // and join rows give way to the restart that unlocks them, not to nothing.
  test('an attached window offers the restart where start and join would be', async () => {
    const restart = mock(() => Promise.resolve());
    mount(client(status()), 'request', {
      takeover: IDLE,
      handleRestartDaemon: restart,
    });
    fireEvent.click(await screen.findByTestId('daemon-takeover'));
    expect(screen.getByText('Start or join a team')).toBeTruthy();
    expect(screen.queryByTestId('team-start')).toBeNull();
    expect(screen.queryByTestId('team-join')).toBeNull();
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  test('names a background CLI daemon and the items waiting behind it', async () => {
    mount(client(status()), 'request', {
      takeover: { ...IDLE, background: true, waiting: 2 },
    });
    expect(await screen.findByText(ATTACHED_BACKGROUND_READ_ONLY)).toBeTruthy();
    expect(screen.getByText(takeoverWaitingNotice(2))).toBeTruthy();
  });

  test('holds the restart back while the daemon is busy, and says why', async () => {
    mount(client(status()), 'request', {
      takeover: { ...IDLE, busy: ['1 live run', '1 terminal'] },
    });
    expect(
      await screen.findByText(takeoverBusyReason(['1 live run', '1 terminal']))
    ).toBeTruthy();
    expect(screen.queryByTestId('daemon-takeover')).toBeNull();
  });

  test('shows the refusal the restart came back with', async () => {
    const refusal =
      'Dispatch for this project is busy with 1 browser. Restarting it from this app would stop that, so try again once it finishes.';
    mount(client(status()), 'request', {
      takeover: IDLE,
      handleRestartDaemon: () => Promise.reject(new Error(refusal)),
    });
    fireEvent.click(await screen.findByTestId('daemon-takeover'));
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
  });

  test('confirms first when runs wait on a human, then restarts', async () => {
    const restart = mock(() => Promise.resolve());
    mount(client(status()), 'request', {
      takeover: { ...IDLE, parked: 2, waiting: 2 },
      handleRestartDaemon: restart,
    });
    fireEvent.click(await screen.findByTestId('daemon-takeover'));
    expect(screen.getByText(takeoverParkedConfirm(2))).toBeTruthy();
    expect(takeoverParkedConfirm(2)).toBe(
      "2 runs are waiting on you; they'll pick up again after the restart. Questions stay open; tool approvals will be asked again."
    );
    expect(restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('daemon-takeover-confirm'));
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  test('a cancelled confirm restarts nothing', async () => {
    const restart = mock(() => Promise.resolve());
    mount(client(status()), 'request', {
      takeover: { ...IDLE, parked: 1 },
      handleRestartDaemon: restart,
    });
    fireEvent.click(await screen.findByTestId('daemon-takeover'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByTestId('daemon-takeover')).toBeTruthy();
    expect(restart).not.toHaveBeenCalled();
  });

  test('a teammate below operator, not attached, sees no restart', async () => {
    mount(client(status()), 'decide');
    await screen.findByTestId('team-status-line');
    expect(screen.queryByTestId('daemon-takeover')).toBeNull();
  });
});
