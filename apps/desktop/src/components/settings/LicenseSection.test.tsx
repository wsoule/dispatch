import type { AuthTier, LicenseStatus, TeamKeys } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { OPERATOR_ONLY } from './fields';
import { dataWith } from './fixtures.test-helper';
import { LicenseSection, planLine } from './LicenseSection';

const FREE: LicenseStatus = {
  kind: 'free',
  seats: 3,
  used: 2,
  org: null,
  expiresAt: null,
  reason: null,
};

function mount(
  status: LicenseStatus,
  myTier: AuthTier = 'operator',
  install: (key: string) => Promise<LicenseStatus> = () =>
    Promise.resolve(status)
) {
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    fetchLicense: mock(() => Promise.resolve(status)),
    installLicense: mock(install),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LicenseSection data={dataWith({ client: client as never, myTier })} />
    </QueryClientProvider>
  );
  return client;
}

test('the free plan says how many people it fits and how many are here', async () => {
  mount(FREE);
  expect(await screen.findByText('Free plan: up to 3 people')).toBeTruthy();
  expect(screen.getByText(/2 of 3 seats used/)).toBeTruthy();
});

test('a licensed plan names who it is for and until when', () => {
  expect(
    planLine({
      ...FREE,
      kind: 'licensed',
      seats: 10,
      org: 'Acme',
      expiresAt: '2027-09-23T00:00:00.000Z',
    })
  ).toBe('Licensed to Acme for 10 people, until 2027-09-23');
});

test('installing a key shows the new plan at once', async () => {
  const licensed: LicenseStatus = {
    ...FREE,
    kind: 'licensed',
    seats: 10,
    org: 'Acme',
  };
  const client = mount(FREE, 'operator', () => Promise.resolve(licensed));
  fireEvent.change(await screen.findByLabelText('Paste a key'), {
    target: { value: '  dispatch1.abc.def  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Install/ }));
  expect(
    await screen.findByText('Licensed to Acme for 10 people')
  ).toBeTruthy();
  expect(client.installLicense).toHaveBeenCalledWith('dispatch1.abc.def');
});

test('a key that does not verify says why, and the plan stays', async () => {
  mount(FREE, 'operator', () =>
    Promise.reject(new Error('the signature does not match'))
  );
  fireEvent.change(await screen.findByLabelText('Paste a key'), {
    target: { value: 'dispatch1.abc.def' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Install/ }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'signature does not match'
  );
  expect(screen.getByText('Free plan: up to 3 people')).toBeTruthy();
});

test('below the operator tier there is nothing to install with', async () => {
  mount(FREE, 'decide');
  expect(
    await screen.findByText(/Ask the person running Dispatch/)
  ).toBeTruthy();
  expect(screen.getAllByLabelText(OPERATOR_ONLY).length).toBeGreaterThan(0);
  await waitFor(() =>
    expect(screen.queryByLabelText('Paste a key')).toBeNull()
  );
});

// Task 13: a founded team shares one key; these mount with the team keys.
function mountTeam(status: LicenseStatus, keys: TeamKeys) {
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    fetchLicense: mock(() => Promise.resolve(status)),
    installLicense: mock(() => Promise.resolve(status)),
    getTeamKeys: mock(() => Promise.resolve(keys)),
    shareTeamLicense: mock(() => Promise.resolve({ ok: true })),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LicenseSection
        data={dataWith({ client: client as never, myTier: 'operator' })}
      />
    </QueryClientProvider>
  );
  return client;
}

function teamKeys(
  role: 'admin' | 'member',
  license: TeamKeys['license']
): TeamKeys {
  return {
    machine: {
      replica: 'ada-0000000a',
      handle: 'ada',
      device: 'laptop',
      fingerprint: 'F',
    },
    team: {
      id: 'a'.repeat(32),
      name: 'acme',
      founder: { replica: 'ada-0000000a', handle: 'ada', fingerprint: 'F' },
    },
    foundings: [],
    roster: [
      {
        replica: 'ada-0000000a',
        handle: 'ada',
        device: 'laptop',
        build: '0.40.0',
        role,
        rank: role === 'admin' ? 0 : null,
        hosts: [],
        observer: false,
        recovered: false,
        fingerprint: 'F',
        lastSeen: null,
        skewMs: null,
      },
    ],
    waiting: [],
    invites: [],
    legacy: { until: null, closed: true, olderBuilds: [] },
    transport: {
      kind: 'git',
      lastExchangeAt: null,
      lastError: null,
      unpublished: 0,
      sizeBytes: null,
      readBytes: 0,
      acks: {},
    },
    license,
    pruningBlockers: [],
    originWarning: null,
    relayDisclosure: 'R',
    warnings: [],
    problems: [],
    pause: null,
  };
}
const ACME: LicenseStatus = {
  ...FREE,
  kind: 'licensed',
  seats: 10,
  org: 'Acme',
};

test("offers Share with the team on an admin's machine of a founded team with a key installed", async () => {
  const client = mountTeam(
    ACME,
    teamKeys('admin', { seats: 3, org: null, sharedBy: null })
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Share with the team' })
  );
  await waitFor(() => expect(client.shareTeamLicense).toHaveBeenCalledTimes(1));
});

test('asks a member to have an admin share the key instead', async () => {
  mountTeam(ACME, teamKeys('member', { seats: 3, org: null, sharedBy: null }));
  expect(
    await screen.findByText('Ask an admin to share this key with your team')
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Share with the team' })
  ).toBeNull();
});

test('names whose key the team uses', async () => {
  mountTeam(
    FREE,
    teamKeys('member', { seats: 10, org: 'Acme', sharedBy: 'bob' })
  );
  expect(
    await screen.findByText("Your team uses bob's key: Acme, 10 people")
  ).toBeTruthy();
});
