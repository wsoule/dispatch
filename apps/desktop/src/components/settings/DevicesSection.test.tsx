import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { DevicesSection } from './DevicesSection';
import { dataWith } from './fixtures.test-helper';

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
}

function devicesClient() {
  return {
    offerPairing: mock(() =>
      Promise.resolve({
        code: 'ABCD-EFGH',
        tier: 'operator',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        shared: false,
        origins: [],
      })
    ),
    fetchDevices: mock(() =>
      Promise.resolve([
        {
          id: 'd-1',
          name: 'phone',
          tier: 'decide',
          pairedAt: '2026-10-20T00:00:00.000Z',
          lastUsedAt: null,
        },
      ])
    ),
    revokeDevice: mock(() => Promise.resolve()),
  };
}

function data(
  overrides: Partial<DispatchProjectData>,
  client: ReturnType<typeof devicesClient>
): DispatchProjectData {
  return dataWith({
    port: 4771,
    myTier: 'operator',
    remoteOrigin: null,
    ownerCredential: true,
    ...overrides,
    client: client as unknown as DispatchProjectData['client'],
  });
}

test('the owner gets a code and the loopback link to reach this daemon', async () => {
  const client = devicesClient();
  wrap(<DevicesSection data={data({}, client)} savedRemotes={() => []} />);
  fireEvent.click(screen.getByRole('button', { name: /Get a code/ }));
  expect(await screen.findByText('ABCD-EFGH')).toBeDefined();
  expect(
    screen.getByText(
      `dispatch://pair?url=${encodeURIComponent('http://127.0.0.1:4771')}&code=ABCD-EFGH`
    )
  ).toBeDefined();
  expect(client.offerPairing).toHaveBeenCalledWith({ tier: 'operator' });
  expect(await screen.findByText('phone')).toBeDefined();
});

test('a teammate is told who pairs devices instead of offered a 403', () => {
  const client = devicesClient();
  wrap(
    <DevicesSection
      data={data({ ownerCredential: false, myTier: 'decide' }, client)}
      savedRemotes={() => []}
    />
  );
  expect(
    screen.getByText('Only the person running this daemon pairs devices')
  ).toBeDefined();
  expect(screen.queryByRole('button', { name: /Get a code/ })).toBeNull();
  expect(client.fetchDevices).not.toHaveBeenCalled();
});

test('a saved remote can be forgotten', () => {
  const client = devicesClient();
  const remote = {
    id: 'd-9',
    name: 'api',
    baseUrl: 'https://devbox:4771',
    token: 't',
    tier: 'decide' as const,
    handle: 'owner',
    deviceId: 'd-9',
    remoteRoot: '/srv/api',
    addedAt: '2026-10-20T00:00:00.000Z',
  };
  let saved = [remote];
  const forget = mock((id: string) => {
    saved = saved.filter((r) => r.id !== id);
  });
  wrap(
    <DevicesSection
      data={data({}, client)}
      savedRemotes={() => saved}
      forgetRemote={forget}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Forget api' }));
  expect(forget).toHaveBeenCalledWith('d-9');
  expect(screen.getByText('None yet')).toBeDefined();
});
