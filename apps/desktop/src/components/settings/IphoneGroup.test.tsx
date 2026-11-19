import type { RemoteAccessStatus } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { dataWith } from './fixtures.test-helper';
import { IphoneGroup, relayChip } from './IphoneGroup';

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
}

function remoteClient(status: Partial<RemoteAccessStatus> = {}) {
  return {
    fetchRemoteAccess: mock(() =>
      Promise.resolve({
        enabled: true,
        relay: 'wss://remote.dispatch.foo',
        link: { kind: 'connected', daemonId: 'd', sessions: 1 },
        devices: [
          {
            id: 'p-1',
            name: "Ada's iPhone",
            pairedAt: '2026-11-01T00:00:00.000Z',
            lastSeenAt: null,
          },
        ],
        offerExpiresAt: null,
        ...status,
      } satisfies RemoteAccessStatus)
    ),
    offerPhonePairing: mock(() =>
      Promise.resolve({
        url: 'dispatch-remote://pair?c=abc',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })
    ),
    unpairPhone: mock(() => Promise.resolve()),
  };
}

function data(
  client: ReturnType<typeof remoteClient>,
  overrides: Partial<DispatchProjectData> = {}
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

test('the owner shows a QR code and its link for the iPhone app', async () => {
  const client = remoteClient();
  wrap(<IphoneGroup data={data(client)} />);
  expect(await screen.findByText("Ada's iPhone")).toBeDefined();
  expect(screen.getByText('Connected')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: /Show code/ }));
  expect(
    await screen.findByRole('img', { name: 'Pairing code for your iPhone' })
  ).toBeDefined();
  expect(screen.getByText('dispatch-remote://pair?c=abc')).toBeDefined();
  expect(client.offerPhonePairing).toHaveBeenCalledTimes(1);
});

test('a paired phone can be unpaired', async () => {
  const client = remoteClient();
  wrap(<IphoneGroup data={data(client)} />);
  fireEvent.click(
    await screen.findByRole('button', { name: "Unpair Ada's iPhone" })
  );
  expect(client.unpairPhone).toHaveBeenCalledWith('p-1');
});

test('a teammate is told who pairs a phone, and nothing is fetched', () => {
  const client = remoteClient();
  wrap(
    <IphoneGroup
      data={data(client, { ownerCredential: false, myTier: 'decide' })}
    />
  );
  expect(
    screen.getByText('Only the person running this daemon pairs a phone')
  ).toBeDefined();
  expect(client.fetchRemoteAccess).not.toHaveBeenCalled();
});

test('the relay link reads as a status chip', () => {
  expect(relayChip({ kind: 'connecting' }).tone).toBe('info');
  expect(relayChip({ kind: 'error', message: 'x' }).tone).toBe('danger');
  expect(relayChip({ kind: 'stopped' }).label).toBe('Idle');
});
