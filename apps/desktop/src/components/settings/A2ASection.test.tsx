import type {
  A2AClientSummary,
  A2AListenerSettings,
  A2AListenerStatus,
  A2ATaskSummary,
  AuthTier,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { A2ASection } from './A2ASection';
import { dataWith } from './fixtures.test-helper';

const OFF: A2AListenerSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: null,
  publicUrl: null,
  tls: null,
  trustForwardedFor: false,
  standalone: false,
};

const CLOSED: A2AListenerStatus = {
  enabled: false,
  listening: false,
  url: null,
  error: null,
  warnings: [],
  legacyClients: [],
  settings: OFF,
  teamTls: null,
};

const WILDCARD: A2AListenerSettings = {
  enabled: true,
  host: '0.0.0.0',
  port: 8443,
  publicUrl: 'https://agent.example.com',
  tls: { certPath: '/c.pem', keyPath: '/k.pem' },
  trustForwardedFor: false,
  standalone: false,
};

const TUNNEL: A2AListenerSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 7450,
  publicUrl: 'https://agent.example.com',
  tls: null,
  trustForwardedFor: true,
  standalone: false,
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

const BASE_URL = 'http://127.0.0.1:1';
let queryClient: QueryClient;

function mount(
  myTier: AuthTier = 'operator',
  over: {
    status?: A2AListenerStatus;
    card?: Record<string, unknown>;
    clients?: A2AClientSummary[];
    tasks?: A2ATaskSummary[];
  } = {}
) {
  const status = over.status ?? CLOSED;
  const client = {
    baseUrl: BASE_URL,
    a2aListener: mock(() => Promise.resolve(status)),
    setA2AListener: mock((settings: A2AListenerSettings) =>
      Promise.resolve({
        ...CLOSED,
        enabled: true,
        listening: true,
        url: 'http://127.0.0.1:7450',
        settings,
      })
    ),
    disableA2AListener: mock(() =>
      Promise.resolve({
        ...CLOSED,
        settings: { ...status.settings, enabled: false },
      })
    ),
    a2aCard: mock(() =>
      Promise.resolve(
        over.card ?? { name: 'Acme API', skills: [{ id: 'ask' }] }
      )
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
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
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
      settings: { ...OFF, enabled: true, port: 7450 },
    },
  });
  await screen.findByText('Listening at http://127.0.0.1:7450');
  fireEvent.click(screen.getByRole('switch', { name: 'A2A listener' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  await waitFor(() => expect(client.disableA2AListener).toHaveBeenCalled());
  expect(client.setA2AListener).not.toHaveBeenCalled();
});

// Base UI commits a select item on a click that began on it, so press first.
function chooseOption(name: string) {
  const option = screen.getByRole('option', { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

const valueOf = (label: string) =>
  screen.getByLabelText<HTMLInputElement>(label).value;

test('shows a network listener as stored and saves it back unchanged', async () => {
  const client = mount('operator', {
    status: {
      ...CLOSED,
      enabled: true,
      listening: true,
      url: 'https://agent.example.com',
      settings: WILDCARD,
    },
  });
  await screen.findByText('Listening at https://agent.example.com');
  expect(screen.getByRole('combobox', { name: 'Host' }).textContent).toContain(
    'Every network interface'
  );
  expect(valueOf('Port')).toBe('8443');
  expect(valueOf('TLS certificate')).toBe('/c.pem');
  expect(valueOf('TLS key')).toBe('/k.pem');
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  await waitFor(() =>
    expect(client.setA2AListener).toHaveBeenCalledWith(WILDCARD)
  );
});

test('turning a disabled tunnel back on keeps its URL and X-Forwarded-For trust', async () => {
  const client = mount('operator', {
    status: { ...CLOSED, settings: TUNNEL },
  });
  await screen.findByText(/Off/);
  expect(valueOf('Public URL')).toBe('https://agent.example.com');
  fireEvent.click(screen.getByRole('switch', { name: 'A2A listener' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  await waitFor(() =>
    expect(client.setA2AListener).toHaveBeenCalledWith({
      ...TUNNEL,
      enabled: true,
    })
  );
});

test('moving to every network interface proposes the team-local cert', async () => {
  mount('operator', {
    status: {
      ...CLOSED,
      teamTls: { certPath: '/team/cert.pem', keyPath: '/team/key.pem' },
    },
  });
  await screen.findByText(/Off/);
  expect(valueOf('TLS certificate')).toBe('');
  fireEvent.click(screen.getByRole('combobox', { name: 'Host' }));
  chooseOption('Every network interface');
  expect(valueOf('TLS certificate')).toBe('/team/cert.pem');
  expect(valueOf('TLS key')).toBe('/team/key.pem');
});

test('after a save the form follows the daemon again', async () => {
  mount();
  await screen.findByText(/Off/);
  fireEvent.click(screen.getByRole('switch', { name: 'A2A listener' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  await screen.findByText('Listening at http://127.0.0.1:7450');
  // Another window (the CLI, a second desktop) moves the listener.
  act(() => {
    queryClient.setQueryData(['dispatch-a2a', BASE_URL, 'listener'], {
      ...CLOSED,
      settings: { ...OFF, port: 9000 },
    });
  });
  await waitFor(() => expect(valueOf('Port')).toBe('9000'));
  expect(
    screen
      .getByRole('switch', { name: 'A2A listener' })
      .getAttribute('aria-checked')
  ).toBe('false');
});

test('the card shows its endpoint only while the listener is open', async () => {
  const card = {
    name: 'Acme API',
    skills: [{ id: 'ask' }],
    supportedInterfaces: [{ url: 'http://127.0.0.1/a2a/v1' }],
  };
  mount('operator', { card });
  expect(await screen.findByText('Acme API')).toBeTruthy();
  await screen.findByText(/Off/);
  expect(screen.queryByText('Endpoint')).toBeNull();
  cleanup();
  mount('operator', {
    card: {
      ...card,
      supportedInterfaces: [{ url: 'http://127.0.0.1:7450/a2a/v1' }],
    },
    status: {
      ...CLOSED,
      enabled: true,
      listening: true,
      url: 'http://127.0.0.1:7450',
      settings: { ...OFF, enabled: true, port: 7450 },
    },
  });
  expect(await screen.findByText('http://127.0.0.1:7450/a2a/v1')).toBeTruthy();
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
