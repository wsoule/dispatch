import { ApiError } from '@dispatch/client';
import type { TeamKeys } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { accessFor, SettingsAccessProvider } from './access';
import { dataWith } from './fixtures.test-helper';
import { MachinesGroup } from './MachinesGroup';

const base: TeamKeys = {
  machine: {
    replica: 'ada-0000000a',
    handle: 'ada',
    device: 'laptop',
    fingerprint: '7QX2-K9PA-M3TD-0W4R-HB8E-5NCF',
  },
  team: null,
  foundings: [],
  roster: [],
  waiting: [],
  invites: [],
  legacy: { until: null, closed: false, olderBuilds: [] },
  transport: {
    kind: 'git',
    lastExchangeAt: null,
    lastError: null,
    unpublished: 0,
    sizeBytes: null,
    readBytes: 0,
    acks: {},
  },
  license: null,
  pruningBlockers: [],
  originWarning: null,
  relayDisclosure: 'The relay can read everything that is not sealed',
  warnings: [],
  problems: [],
  pause: null,
};
const founded: TeamKeys = {
  ...base,
  // This machine is the team's admin, so its admin controls show.
  roster: [
    {
      replica: 'ada-0000000a',
      handle: 'ada',
      device: 'laptop',
      build: '0.40.0',
      role: 'admin',
      rank: 0,
      hosts: [],
      observer: false,
      recovered: false,
      fingerprint: base.machine.fingerprint,
      lastSeen: null,
      skewMs: null,
    },
  ],
  team: {
    id: 'a'.repeat(32),
    name: 'acme',
    founder: {
      replica: 'ada-0000000a',
      handle: 'ada',
      fingerprint: base.machine.fingerprint,
    },
  },
};

function mount(
  keys: TeamKeys | (() => Promise<TeamKeys>),
  tier: 'request' | 'decide' | 'operator' = 'operator'
) {
  const ok = () => Promise.resolve({ ok: true });
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    getTeamKeys: mock(
      typeof keys === 'function' ? keys : () => Promise.resolve(keys)
    ),
    foundTeam: mock(() =>
      Promise.resolve({
        teamId: 'a'.repeat(32),
        recoveryCode: '7QX2-K9PA-…',
        fingerprint: base.machine.fingerprint,
      })
    ),
    admitReplica: mock(ok),
    trustFounder: mock(ok),
    revokeReplica: mock(ok),
    dismissRosterOp: mock(ok),
    ackProblem: mock(() => Promise.resolve()),
    inviteToTeam: mock(() =>
      Promise.resolve({ code: 'di1.invite-code', expires: '2026-10-11' })
    ),
    newRecoveryCode: mock(() =>
      Promise.resolve({ recoveryCode: 'NEW-RECOVERY-CODE' })
    ),
    closeLegacy: mock(ok),
    setReplicaHosts: mock(ok),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsAccessProvider access={accessFor(tier, false)}>
        <MachinesGroup data={dataWith({ client: client as never })} />
      </SettingsAccessProvider>
    </QueryClientProvider>
  );
  return client;
}

test('before founding, it shows this machine and offers Found a team to the operator', async () => {
  const client = mount(base);
  expect(await screen.findByText('7QX2-K9PA-M3TD-0W4R-HB8E-5NCF')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Found a team' }));
  expect(
    await screen.findByText(
      /it is the only way back in if every admin machine is lost/
    )
  ).toBeTruthy();
  expect(client.foundTeam).toHaveBeenCalledTimes(1);
});

test('shows both fingerprints when two foundings compete, and trusts the one picked', async () => {
  const client = mount({
    ...base,
    foundings: [
      { replica: 'ada-0000000a', fingerprint: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' },
      { replica: 'bob-0000000b', fingerprint: 'BBBB-BBBB-BBBB-BBBB-BBBB-BBBB' },
    ],
  });
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Trust BBBB-BBBB-BBBB-BBBB-BBBB-BBBB',
    })
  );
  expect(client.trustFounder).toHaveBeenCalledWith(
    'BBBB-BBBB-BBBB-BBBB-BBBB-BBBB'
  );
});

test('admits a waiting machine only after its fingerprint is typed to match', async () => {
  const client = mount({
    ...founded,
    waiting: [
      {
        replica: 'cy-0000000c',
        handle: 'cy',
        device: 'mini',
        fingerprint: 'CCCC-CCCC-CCCC-CCCC-CCCC-CCCC',
        invitedBy: 'ada',
      },
    ],
  });
  expect(await screen.findByText('invited by ada')).toBeTruthy();
  const admit = screen.getByRole('button', { name: 'Admit cy' });
  expect(admit.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Fingerprint for cy'), {
    target: { value: 'cccc-cccc-cccc-cccc-cccc-cccc' },
  });
  expect(admit.hasAttribute('disabled')).toBe(false);
  fireEvent.click(admit);
  expect(client.admitReplica).toHaveBeenCalledWith('cy-0000000c', {
    fingerprint: 'CCCC-CCCC-CCCC-CCCC-CCCC-CCCC',
  });
});

test('shows the warnings and the origin warning, and hides every control below the operator tier', async () => {
  mount(
    {
      ...base,
      warnings: ['Only ada can admit, revoke or change the team.'],
      originWarning: 'Everyone with access to origin can read the whole board',
    },
    'decide'
  );
  expect(
    await screen.findByText('Only ada can admit, revoke or change the team.')
  ).toBeTruthy();
  expect(screen.getByText(/Everyone with access to origin/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Found a team' })).toBeNull();
});

test('shows the branch size and each pruning blocker, with Revoke it? for the operator', async () => {
  const client = mount({
    ...founded,
    transport: { ...base.transport, sizeBytes: 2 * 1024 * 1024 * 1024 },
    pruningBlockers: [
      {
        replica: 'bob-0000000b',
        handle: 'bob',
        lastAck: '2026-08-01T00:00:00.000Z',
      },
    ],
  });
  expect(await screen.findByText('Sync branch: 2.0 GiB')).toBeTruthy();
  expect(
    screen.getByText(
      'bob has not acknowledged since 2026-08-01; it blocks pruning.'
    )
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke bob?' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Confirm revoke' })
  );
  expect(client.revokeReplica).toHaveBeenCalledWith(
    'bob-0000000b',
    'blocked pruning'
  );
});

// FW-R2/R8: the pause names its op; an admin dismisses it from here.
test('offers Dismiss on a roster pause, and Acknowledge on a race note', async () => {
  const hash = 'h'.repeat(64);
  const client = mount({
    ...founded,
    pause: { replica: 'bob-0000000b', seq: 4, hash },
    problems: [
      {
        subject: 'op:bob-0000000b:4',
        message: "a teammate's newer Dispatch changed the roster",
        at: 'x',
      },
      {
        subject: 'team:race:bob-0000000b',
        message: 'bob touched t-1 above the cut',
        at: 'x',
      },
    ],
  });
  fireEvent.click(
    await screen.findByRole('button', { name: "Dismiss bob-0000000b's op" })
  );
  await waitFor(() =>
    expect(client.dismissRosterOp).toHaveBeenCalledWith('bob-0000000b', 4, hash)
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Acknowledge team:race:bob-0000000b' })
  );
  await waitFor(() =>
    expect(client.ackProblem).toHaveBeenCalledWith('team:race:bob-0000000b')
  );
});

test('says why when the team keys cannot be read', async () => {
  mount(() => Promise.reject(new Error('dispatchd refused')));
  expect(await screen.findByText(/dispatchd refused/)).toBeTruthy();
});

test('shows nothing while board sync is off', async () => {
  const client = mount(() => Promise.reject(new Error('board sync is not on')));
  await waitFor(() => expect(client.getTeamKeys).toHaveBeenCalled());
  expect(screen.queryByText(/board sync is not on/)).toBeNull();
});

test('hides Dismiss below the operator tier and says to ask an admin', async () => {
  mount(
    {
      ...founded,
      pause: { replica: 'bob-0000000b', seq: 4, hash: 'h'.repeat(64) },
    },
    'decide'
  );
  expect(
    await screen.findByText(/ask an admin to dismiss the op/)
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: "Dismiss bob-0000000b's op" })
  ).toBeNull();
});

test("hides admin controls on a member's machine", async () => {
  const member = {
    ...founded,
    roster: founded.roster.map((m) => ({ ...m, role: 'member' as const })),
    waiting: [
      {
        replica: 'cy-0000000c',
        handle: 'cy',
        device: 'mini',
        fingerprint: 'CCCC-CCCC-CCCC-CCCC-CCCC-CCCC',
        invitedBy: null,
      },
    ],
  };
  mount(member);
  expect(await screen.findByText('Waiting: cy on mini')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Admit cy' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create invite' })).toBeNull();
});

test('invites a handle and shows the code once; makes a new recovery code', async () => {
  const client = mount(founded);
  fireEvent.change(await screen.findByLabelText('Handle to invite'), {
    target: { value: 'dee' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
  expect(await screen.findByText('di1.invite-code')).toBeTruthy();
  expect(client.inviteToTeam).toHaveBeenCalledWith('dee');
  fireEvent.click(screen.getByRole('button', { name: 'New recovery code' }));
  expect(await screen.findByText('NEW-RECOVERY-CODE')).toBeTruthy();
});

test('closes the legacy window and sets the hosts a machine serves', async () => {
  const client = mount({
    ...founded,
    legacy: {
      until: '2026-10-26T00:00:00.000Z',
      closed: false,
      olderBuilds: [],
    },
    roster: [
      ...founded.roster,
      {
        replica: 'box-0000000d',
        handle: 'box',
        device: 'server',
        build: '0.40.0',
        role: 'member',
        rank: null,
        hosts: [],
        observer: false,
        recovered: false,
        fingerprint: 'DDDD',
        lastSeen: null,
        skewMs: null,
      },
    ],
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Close now' }));
  await waitFor(() => expect(client.closeLegacy).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Hosts for box'), {
    target: { value: 'eve, fay' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save hosts for box' }));
  await waitFor(() =>
    expect(client.setReplicaHosts).toHaveBeenCalledWith('box-0000000d', [
      'eve',
      'fay',
    ])
  );
});

test('titles each problem by its source in words', async () => {
  mount({
    ...founded,
    problems: [
      { subject: 'halt:bob-0000000b', message: 'fails verification', at: 'x' },
    ],
  });
  expect(
    await screen.findByText('Log stopped verifying: bob-0000000b')
  ).toBeTruthy();
});

test('explains the tier instead of showing a refused request', async () => {
  const refused = new ApiError(
    'needs the decide tier',
    403,
    'auth_insufficient_tier'
  );
  mount(() => Promise.reject(refused));
  expect(
    await screen.findByText(/Changing settings needs Can approve access/)
  ).toBeTruthy();
});

// Minor (1): an operator on a member's machine sees no admin control.
test("shows a member's operator no admin controls", async () => {
  const [me] = founded.roster;
  if (me === undefined) throw new Error('no roster entry for this machine');
  mount({
    ...founded,
    roster: [
      { ...me, role: 'member' },
      {
        replica: 'bob-0000000b',
        handle: 'bob',
        device: 'desk',
        build: '0.40.0',
        role: 'member',
        rank: null,
        hosts: [],
        observer: false,
        recovered: false,
        fingerprint: 'BBBB',
        lastSeen: null,
        skewMs: null,
      },
    ],
    legacy: {
      until: '2026-10-26T00:00:00.000Z',
      closed: false,
      olderBuilds: [],
    },
    pause: { replica: 'bob-0000000b', seq: 4, hash: 'h'.repeat(64) },
  });
  expect(await screen.findByText('bob on desk')).toBeTruthy();
  for (const name of [
    'Make admin',
    'Make member',
    'Revoke',
    'New recovery code',
    'Save hosts for bob',
    'Close now',
    "Dismiss bob-0000000b's op",
  ])
    expect(screen.queryByRole('button', { name })).toBeNull();
});

// Minor (1): an uncheckable revocation is the operator's to acknowledge.
test('hides the team:cut Acknowledge below the operator tier', async () => {
  mount(
    {
      ...founded,
      problems: [
        {
          subject: 'team:cut:bob-0000000b',
          message: 'cannot be checked',
          at: 'x',
        },
        { subject: 'team:race:bob-0000000b', message: 'raced', at: 'x' },
      ],
    },
    'decide'
  );
  expect(
    await screen.findByRole('button', {
      name: 'Acknowledge team:race:bob-0000000b',
    })
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Acknowledge team:cut:bob-0000000b' })
  ).toBeNull();
});

// Minor (5): a field-cap note on a task has a title of its own.
test('titles a task field-cap note', async () => {
  mount({
    ...founded,
    problems: [
      { subject: 'task:t-00000a01', message: 'field over the cap', at: 'x' },
    ],
  });
  expect(
    await screen.findByText('Task change too large: t-00000a01')
  ).toBeTruthy();
});
