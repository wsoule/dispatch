import type {
  A2AClientSummary,
  A2AListenerStatus,
  A2ATaskSummary,
  AuthTier,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { A2ASection } from './A2ASection';
import { dataWith } from './fixtures.test-helper';

const CLOSED: A2AListenerStatus = {
  enabled: false,
  listening: false,
  url: null,
  error: null,
  warnings: [],
  legacyClients: [],
};

const ACME: A2AClientSummary = {
  address: 'agent:wyat/a2a.acme',
  name: 'a2a.acme',
  recipients: ['human:alice'],
  status: 'approved',
  createdBy: 'human:wyat',
  createdAt: '2026-09-25T10:00:00.000Z',
};

const ASK: A2ATaskSummary = {
  id: 'm-7',
  client: 'agent:wyat/a2a.acme',
  contextId: 'm-7',
  skill: 'ask',
  dispatchTask: null,
  gate: null,
  state: 'WORKING',
  statusAt: '2026-09-25T10:00:00.000Z',
  canceledAt: null,
  declinedAt: null,
  createdAt: '2026-09-25T10:00:00.000Z',
};

function mount(
  myTier: AuthTier = 'operator',
  over: {
    status?: A2AListenerStatus;
    clients?: A2AClientSummary[];
    tasks?: A2ATaskSummary[];
  } = {}
) {
  const status = over.status ?? CLOSED;
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    a2aListener: mock(() => Promise.resolve(status)),
    setA2AListener: mock((_s: unknown) =>
      Promise.resolve({
        ...CLOSED,
        enabled: true,
        listening: true,
        url: 'http://127.0.0.1:7450',
      })
    ),
    disableA2AListener: mock(() => Promise.resolve(CLOSED)),
    a2aCard: mock(() =>
      Promise.resolve({ name: 'Acme API', skills: [{ id: 'ask' }] })
    ),
    a2aClients: mock(() => Promise.resolve({ clients: over.clients ?? [] })),
    addA2AClient: mock((_input: unknown) =>
      Promise.resolve({
        address: 'agent:wyat/a2a.acme',
        token: 'f'.repeat(64),
        status: 'approved',
      })
    ),
    rotateA2AClient: mock((_name: string) =>
      Promise.resolve({ token: 'e'.repeat(64) })
    ),
    revokeAgent: mock((_address: string) => Promise.resolve({})),
    approveAgent: mock((_address: string) => Promise.resolve({})),
    a2aTasks: mock(() => Promise.resolve({ tasks: over.tasks ?? [] })),
  };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <A2ASection data={dataWith({ client: client as never, myTier })} />
    </QueryClientProvider>
  );
  return client;
}

test('the listener is off by default and turning it on sends loopback settings', async () => {
  const client = mount();
  expect(await screen.findByText(/Off/)).toBeTruthy();
  fireEvent.click(screen.getByRole('switch', { name: 'A2A listener' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  await waitFor(() =>
    expect(client.setA2AListener).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, host: '127.0.0.1', port: 7450 })
    )
  );
  expect(
    await screen.findByText('Listening at http://127.0.0.1:7450')
  ).toBeTruthy();
});

test('only the operator can change the listener', async () => {
  mount('decide');
  expect(await screen.findByText(/needs the operator tier/i)).toBeTruthy();
  expect(
    screen
      .getByRole('switch', { name: 'A2A listener' })
      .hasAttribute('data-disabled')
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Save listener' })
      .disabled
  ).toBe(true);
});

test('a form the daemon would refuse names the field and sends nothing', async () => {
  const client = mount();
  await screen.findByText(/Off/);
  fireEvent.click(screen.getByRole('switch', { name: 'A2A listener' }));
  fireEvent.change(screen.getByLabelText('Port'), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/port/i);
  expect(client.setA2AListener).not.toHaveBeenCalled();
});

test('turning a running listener off disables it', async () => {
  const client = mount('operator', {
    status: {
      ...CLOSED,
      enabled: true,
      listening: true,
      url: 'http://127.0.0.1:7450',
    },
  });
  await screen.findByText('Listening at http://127.0.0.1:7450');
  fireEvent.click(screen.getByRole('switch', { name: 'A2A listener' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  await waitFor(() => expect(client.disableA2AListener).toHaveBeenCalled());
  expect(client.setA2AListener).not.toHaveBeenCalled();
});

test('shows the card the listener serves', async () => {
  mount();
  expect(await screen.findByText('Acme API')).toBeTruthy();
  expect(screen.getByText('ask')).toBeTruthy();
});

test('adding a client shows its token once with a copy button', async () => {
  const client = mount();
  fireEvent.change(await screen.findByLabelText('Client name'), {
    target: { value: 'acme' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
  expect(await screen.findByText('f'.repeat(64))).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy token' })).toBeTruthy();
  expect(client.addA2AClient).toHaveBeenCalledWith({
    name: 'acme',
    approve: true,
  });
});

test('below decide a new client waits for approval and names its recipients', async () => {
  const client = mount('request');
  fireEvent.change(await screen.findByLabelText('Client name'), {
    target: { value: 'acme' },
  });
  fireEvent.change(screen.getByLabelText('May also address'), {
    target: { value: 'alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
  await waitFor(() =>
    expect(client.addA2AClient).toHaveBeenCalledWith({
      name: 'acme',
      to: ['human:alice'],
    })
  );
});

test('rotating a client shows the new token once', async () => {
  const client = mount('decide', { clients: [ACME] });
  fireEvent.click(
    await screen.findByRole('button', { name: 'Rotate agent:wyat/a2a.acme' })
  );
  expect(await screen.findByText('e'.repeat(64))).toBeTruthy();
  expect(client.rotateA2AClient).toHaveBeenCalledWith('agent:wyat/a2a.acme');
});

test('lists the open tasks under their client', async () => {
  mount('decide', { clients: [ACME], tasks: [ASK] });
  expect(await screen.findByText(/m-7/)).toBeTruthy();
});
