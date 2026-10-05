import type {
  A2AClientSummary,
  A2ALinksStatus,
  A2AListenerSettings,
  A2AListenerStatus,
  A2APairingSummary,
  A2APeerSummary,
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
  suggestedPort: 51234,
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

const PEER: A2APeerSummary = {
  alias: 'acme',
  cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
  interfaceUrl: 'https://agent.example.com/a2a/v1',
  binding: 'HTTP+JSON',
  status: 'active',
  name: '<b>Acme</b> Planner',
  description: 'Plans.',
  skills: [],
  streaming: true,
  addedBy: 'human:wyat',
  addedTier: 'decide',
  fetchedAt: '2026-09-25T10:00:00.000Z',
  createdAt: '2026-09-25T10:00:00.000Z',
  auth: 'bearer',
  fingerprint: null,
};

const PAIR_CODE = `dispatch-a2a-pair:${'c'.repeat(60)}`;

const BASE_URL = 'http://127.0.0.1:1';
let queryClient: QueryClient;

function mount(
  myTier: AuthTier = 'operator',
  over: {
    status?: A2AListenerStatus;
    card?: Record<string, unknown>;
    clients?: A2AClientSummary[];
    tasks?: A2ATaskSummary[];
    peers?: A2APeerSummary[] | Error;
    pairings?: A2APairingSummary[];
    links?: A2ALinksStatus;
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
    a2aPeers: mock(() =>
      over.peers instanceof Error
        ? Promise.reject(over.peers)
        : Promise.resolve({ peers: over.peers ?? [] })
    ),
    addA2APeer: mock((_input: unknown) => Promise.resolve(PEER)),
    refreshA2APeer: mock((_alias: string) => Promise.resolve(PEER)),
    setA2APeerEnabled: mock(
      (_alias: string, _enabled: boolean, _token?: string) =>
        Promise.resolve(PEER)
    ),
    removeA2APeer: mock((_alias: string) => Promise.resolve()),
    createA2APairing: mock((_input: unknown) =>
      Promise.resolve({
        id: 'AAAAAAAAAAAAAAAAAAAAAA',
        code: PAIR_CODE,
        fingerprint: 'A1B2-C3D4-0000-0000-0000-0000',
        expiresAt: '2026-10-05T00:15:00.000Z',
      })
    ),
    acceptA2APairing: mock((_input: unknown) =>
      Promise.resolve({
        alias: 'alice',
        sas: '<i>5N82</i>-A48G',
        fingerprint: '<b>T1H2</b>-R3K4-0000-0000-0000-0000',
      })
    ),
    a2aPairings: mock(() => Promise.resolve({ pairings: over.pairings ?? [] })),
    cancelA2APairing: mock((_id: string) => Promise.resolve()),
    a2aLinks: mock(() =>
      Promise.resolve(over.links ?? { enabled: true, links: [], offers: [] })
    ),
    upgradeA2APeer: mock((_alias: string, _fp: string) =>
      Promise.resolve({
        state: 'pending',
        id: 'BBBBBBBBBBBBBBBBBBBBBB',
        fingerprint: 'A9B8-C7D6-0000-0000-0000-0000',
      })
    ),
    a2aKeys: mock(() =>
      Promise.resolve({
        current: { fingerprint: 'A1B2-C3D4-0000-0000-0000-0000' },
        next: null,
      })
    ),
    rotateA2AKey: mock((_compromised: boolean) =>
      Promise.resolve({
        fingerprint: 'N3W4-K5Y6-0000-0000-0000-0000',
        told: ['bob'],
        untold: [],
        mustRepair: [],
        overlapUntil: '2026-10-12T00:00:00.000Z',
      })
    ),
    setA2AStandalone: mock((enabled: boolean) =>
      Promise.resolve({ standalone: enabled })
    ),
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

test('the listener is off by default and turning it on sends loopback on the proposed port', async () => {
  const client = mount();
  expect(await screen.findByText(/Off/)).toBeTruthy();
  fireEvent.click(screen.getByRole('switch', { name: 'A2A listener' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
  await waitFor(() =>
    expect(client.setA2AListener).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, host: '127.0.0.1', port: 51234 })
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

async function fillPeer(alias: string, cardUrl: string, token?: string) {
  fireEvent.change(await screen.findByLabelText('Peer alias'), {
    target: { value: alias },
  });
  fireEvent.change(screen.getByLabelText('Card URL'), {
    target: { value: cardUrl },
  });
  if (token !== undefined)
    fireEvent.change(screen.getByLabelText('Peer credential'), {
      target: { value: token },
    });
}

test('adds a peer from its card URL with a credential, which is masked and cleared', async () => {
  const client = mount('decide');
  const token =
    await screen.findByLabelText<HTMLInputElement>('Peer credential');
  expect(token.type).toBe('password');
  await fillPeer(
    'acme',
    'https://agent.example.com/.well-known/agent-card.json',
    'peer-secret'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));
  await waitFor(() =>
    expect(client.addA2APeer).toHaveBeenCalledWith({
      alias: 'acme',
      cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
      token: 'peer-secret',
    })
  );
  expect(token.value).toBe('');
  expect(document.body.textContent).not.toContain('peer-secret');
  expect(screen.queryByLabelText('Allow plain http')).toBeNull();
});

test('clears the credential when the add fails too', async () => {
  const client = mount('decide');
  client.addA2APeer.mockImplementationOnce(() =>
    Promise.reject(
      Object.assign(new Error('cardUrl: resolves to a private address'), {
        field: 'cardUrl',
        status: 400,
      })
    )
  );
  await fillPeer('acme', 'https://intra.example.com/card', 'peer-secret');
  fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));
  expect(await screen.findByText(/private address/)).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>('Peer credential').value).toBe(
    ''
  );
});

test('shows both origins and lets the operator confirm the other one', async () => {
  const client = mount('operator');
  client.addA2APeer
    .mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            'allowOrigin: the card at https://a.example.com points at https://b.example.com; confirm with --allow-origin'
          ),
          { field: 'allowOrigin', status: 400 }
        )
      )
    )
    .mockImplementationOnce(() => Promise.resolve(PEER));
  await fillPeer('acme', 'https://a.example.com/card');
  // Named by its visible label, not a separate aria-label.
  const http = screen.getByRole('checkbox', { name: 'Allow plain http' });
  expect(http.getAttribute('aria-label')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));
  expect(
    await screen.findByText(
      'The card at https://a.example.com points its A2A interface at https://b.example.com.'
    )
  ).toBeTruthy();
  const other = screen.getByRole('checkbox', {
    name: 'Allow the other origin',
  });
  expect(other.getAttribute('aria-label')).toBeNull();
  fireEvent.click(other);
  fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));
  await waitFor(() =>
    expect(client.addA2APeer).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowOrigin: true })
    )
  );
});

test('lists peers as plain text: card text unrendered and URLs never links', async () => {
  mount('decide', {
    peers: [
      PEER,
      {
        ...PEER,
        alias: 'evil',
        status: 'auth-failed',
        interfaceUrl: 'javascript:alert(1)',
      },
    ],
  });
  expect(await screen.findByText('a2a:acme')).toBeTruthy();
  expect(screen.getAllByText(/<b>Acme<\/b> Planner/)).toHaveLength(2);
  expect(
    screen.getByText(/https:\/\/agent\.example\.com\/a2a\/v1/)
  ).toBeTruthy();
  expect(screen.getByText(/Credential refused/)).toBeTruthy();
  expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  expect(document.querySelector('b')).toBeNull();
});

test('shows loading, empty and error states for peers', async () => {
  mount('decide');
  expect(await screen.findByText('No peers yet')).toBeTruthy();
  cleanup();
  mount('decide', { peers: new Error('the A2A bridge is unavailable') });
  expect(await screen.findByText("Couldn't load peers")).toBeTruthy();
  expect(screen.getByText('the A2A bridge is unavailable')).toBeTruthy();
});

test('below decide, peers are listed but cannot be added or changed', async () => {
  mount('request', { peers: [PEER] });
  expect(await screen.findByText('a2a:acme')).toBeTruthy();
  expect(screen.queryByLabelText('Peer alias')).toBeNull();
  expect(screen.queryByLabelText('Peer credential')).toBeNull();
  expect(screen.queryByRole('button', { name: /Disable a2a:acme/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Remove a2a:acme/ })).toBeNull();
});

test('re-enables an auth-failed peer with a new credential, then clears it', async () => {
  const client = mount('decide', {
    peers: [{ ...PEER, status: 'auth-failed' }],
  });
  const field = await screen.findByLabelText<HTMLInputElement>(
    'New credential for a2a:acme'
  );
  expect(field.type).toBe('password');
  fireEvent.change(field, { target: { value: 'new-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enable a2a:acme' }));
  await waitFor(() =>
    expect(client.setA2APeerEnabled).toHaveBeenCalledWith(
      'acme',
      true,
      'new-secret'
    )
  );
  expect(field.value).toBe('');
});

test('re-enables an auth-failed peer with the credential it already has', async () => {
  const client = mount('decide', {
    peers: [{ ...PEER, status: 'auth-failed' }],
  });
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Enable a2a:acme with the same credential',
    })
  );
  await waitFor(() =>
    expect(client.setA2APeerEnabled).toHaveBeenCalledWith(
      'acme',
      true,
      undefined
    )
  );
});

test('the operator turns standalone hosts on and off; others see the state only', async () => {
  const client = mount('operator', {
    status: { ...CLOSED, settings: { ...OFF, standalone: true } },
  });
  const toggle = await screen.findByRole('switch', {
    name: 'Standalone hosts',
  });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(client.setA2AStandalone).toHaveBeenCalledWith(false)
  );
  cleanup();
  mount('decide');
  expect(
    (
      await screen.findByRole('switch', { name: 'Standalone hosts' })
    ).hasAttribute('data-disabled')
  ).toBe(true);
});

test('disables, refreshes and removes a peer after confirming', async () => {
  const client = mount('decide', { peers: [PEER] });
  fireEvent.click(
    await screen.findByRole('button', { name: 'Disable a2a:acme' })
  );
  await waitFor(() =>
    expect(client.setA2APeerEnabled).toHaveBeenCalledWith('acme', false)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh a2a:acme' }));
  await waitFor(() =>
    expect(client.refreshA2APeer).toHaveBeenCalledWith('acme')
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove a2a:acme' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  await waitFor(() =>
    expect(client.removeA2APeer).toHaveBeenCalledWith('acme')
  );
});

test('Pair with… shows the code once, and closing it clears it', async () => {
  const client = mount('decide');
  fireEvent.change(await screen.findByLabelText('Pair as'), {
    target: { value: 'bob' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Pair with…' }));
  expect(await screen.findByText(PAIR_CODE)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  expect(client.createA2APairing).toHaveBeenCalledWith({ alias: 'bob' });
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByText(PAIR_CODE)).toBeNull());
  expect(document.body.textContent).not.toContain(PAIR_CODE);
});

test('Enter a code takes it in a password field, cleared on submit, and shows the SAS as text', async () => {
  const client = mount('decide');
  const field = await screen.findByLabelText<HTMLInputElement>('Pairing code');
  expect(field.type).toBe('password');
  fireEvent.change(screen.getByLabelText('Their alias'), {
    target: { value: 'alice' },
  });
  field.value = PAIR_CODE;
  fireEvent.click(screen.getByRole('button', { name: 'Enter code' }));
  await waitFor(() =>
    expect(client.acceptA2APairing).toHaveBeenCalledWith({
      code: PAIR_CODE,
      alias: 'alice',
    })
  );
  expect(field.value).toBe('');
  expect(await screen.findByText(/<i>5N82<\/i>-A48G/)).toBeTruthy();
  expect(screen.getByText(/<b>T1H2<\/b>-R3K4/)).toBeTruthy();
  expect(document.querySelector('i')).toBeNull();
  expect(document.body.textContent).not.toContain(PAIR_CODE);
});

test('Pair with… over a link sends the remote, and needs no listener (T55)', async () => {
  const client = mount('decide');
  fireEvent.change(await screen.findByLabelText('Pair as'), {
    target: { value: 'bob' },
  });
  fireEvent.change(screen.getByLabelText('Over a link (git remote)'), {
    target: { value: 'git@github.com:acme/links.git' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Pair with…' }));
  await waitFor(() =>
    expect(client.createA2APairing).toHaveBeenCalledWith({
      alias: 'bob',
      link: { remote: 'git@github.com:acme/links.git' },
    })
  );
});

test('Links shows each link’s health and an offer’s problem, as text (T55)', async () => {
  mount('decide', {
    links: {
      enabled: true,
      links: [
        {
          alias: 'bob',
          remote: 'git@github.com:acme/links.git',
          branch: 'dispatch-a2a-0123456789abcdef',
          ready: true,
          pending: false,
          readThisPass: 0,
          waiting: 2,
          lastExchangeAt: '2026-10-05T00:00:00.000Z',
          lastError: null,
          unpublished: 1,
          problems: [
            {
              subject: 'link-rival:x',
              message: '<b>1 key op</b> on the link branch is not this link’s',
              at: '2026-10-05T00:00:00.000Z',
              dismissible: true,
            },
          ],
        },
      ],
      offers: [
        {
          pairedId: 'AAAAAAAAAAAAAAAAAAAAAA',
          alias: 'carl',
          remote: '/srv/links.git',
          branch: 'dispatch-a2a-fedcba9876543210',
          createdAt: '2026-10-05T00:00:00.000Z',
          problems: ['1 key op offered a proof that did not check out'],
        },
      ],
    },
  });
  expect(await screen.findByText('a2a:bob')).toBeTruthy();
  expect(screen.getByText(/2 waiting, 1 unpublished/)).toBeTruthy();
  expect(screen.getByText(/<b>1 key op<\/b>/)).toBeTruthy();
  expect(document.querySelector('b')).toBeNull();
  expect(screen.getByText(/did not check out/)).toBeTruthy();
});

test('a link still waiting for the offerer says so (T55)', async () => {
  mount('decide', {
    links: {
      enabled: true,
      links: [
        {
          alias: 'ada',
          remote: '/srv/links.git',
          branch: 'dispatch-a2a-0123456789abcdef',
          ready: true,
          pending: true,
          readThisPass: 0,
          waiting: 0,
          lastExchangeAt: null,
          lastError: null,
          unpublished: 0,
          problems: [],
        },
      ],
      offers: [],
    },
  });
  expect(
    await screen.findByText(/Waiting for the other side to start the link/)
  ).toBeTruthy();
});

test('below decide there is no pairing form', async () => {
  mount('request');
  expect(await screen.findByText(/Someone who can approve pairs/)).toBeTruthy();
  expect(screen.queryByLabelText('Pairing code')).toBeNull();
});

test('peer rows say Signed, Not verified or Link, with the pinned fingerprint as text', async () => {
  mount('decide', {
    peers: [
      {
        ...PEER,
        alias: 'signed',
        auth: 'signature',
        fingerprint: '<b>SIGN</b>-0000',
      },
      { ...PEER, alias: 'plain', auth: 'bearer', fingerprint: null },
      { ...PEER, alias: 'linked', auth: 'link', fingerprint: null },
    ],
  });
  expect(await screen.findByText('a2a:signed')).toBeTruthy();
  expect(screen.getByText(/Signed/)).toBeTruthy();
  expect(screen.getByText(/<b>SIGN<\/b>-0000/)).toBeTruthy();
  expect(screen.getAllByText(/Not verified/)).toHaveLength(1);
  expect(screen.getByText(/Link ·/)).toBeTruthy();
  expect(document.querySelector('b')).toBeNull();
});

test('a bearer peer can be upgraded with the fingerprint its owner reads out', async () => {
  const client = mount('decide', {
    peers: [{ ...PEER, auth: 'bearer', fingerprint: null }],
  });
  fireEvent.click(
    await screen.findByRole('button', { name: 'Upgrade a2a:acme to signed' })
  );
  fireEvent.change(screen.getByLabelText('Their fingerprint'), {
    target: { value: 'A9B8-C7D6-0000-0000-0000-0000' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask to upgrade' }));
  await waitFor(() =>
    expect(client.upgradeA2APeer).toHaveBeenCalledWith(
      'acme',
      'A9B8-C7D6-0000-0000-0000-0000'
    )
  );
  expect(await screen.findByText(/waits for its owner/)).toBeTruthy();
});

test('shows this agent’s fingerprint; only the operator sees Rotate', async () => {
  const client = mount('decide');
  expect(await screen.findByText('A1B2-C3D4-0000-0000-0000-0000')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Rotate key' })).toBeNull();
  cleanup();
  const operator = mount('operator');
  fireEvent.click(await screen.findByRole('button', { name: 'Rotate key' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
  await waitFor(() =>
    expect(operator.rotateA2AKey).toHaveBeenCalledWith(false)
  );
  expect(await screen.findByText(/N3W4-K5Y6-0000-0000-0000-0000/)).toBeTruthy();
  expect(client.rotateA2AKey).not.toHaveBeenCalled();
});

test('lists recent pairings with their SAS on either side, as plain text', async () => {
  mount('decide', {
    pairings: [
      {
        id: 'AAAAAAAAAAAAAAAAAAAAAA',
        role: 'offer',
        alias: 'bob',
        state: 'completed',
        createdBy: 'human:wyat',
        createdAt: '2026-10-05T00:00:00.000Z',
        expiresAt: '2026-10-05T00:15:00.000Z',
        completedAt: '2026-10-05T00:01:00.000Z',
        fingerprint: 'A9B8-C7D6-0000',
        sas: '<i>5N82</i>-A48G',
      },
      {
        id: 'BBBBBBBBBBBBBBBBBBBBBB',
        role: 'offer',
        alias: 'carol',
        state: 'offered',
        createdBy: 'human:wyat',
        createdAt: '2026-10-05T00:00:00.000Z',
        expiresAt: '2026-10-05T00:15:00.000Z',
        completedAt: null,
        fingerprint: null,
        sas: null,
      },
    ],
  });
  expect(await screen.findByText(/SAS <i>5N82<\/i>-A48G/)).toBeTruthy();
  expect(screen.getByText('a2a:carol')).toBeTruthy();
  expect(screen.getByText(/Waiting for the other side/)).toBeTruthy();
  expect(document.querySelector('i')).toBeNull();
});
