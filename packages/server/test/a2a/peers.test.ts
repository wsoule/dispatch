import { readPeerCredential } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  addPeer,
  markAuthFailed,
  peerClientFor,
  refreshDuePeers,
  refreshPeer,
  removePeer,
  setPeerEnabled,
} from '../../src/a2a/peers.js';
import { HUMAN, useTempProject, waitFor } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
beforeEach(async () => {
  f = await bridgeFixture(project.root());
});
afterEach(() => f.close());

const CARD_URL = 'https://agent.example.com/.well-known/agent-card.json';
const CARD = {
  name: 'Acme Planner',
  description: 'Plans.',
  version: '1',
  capabilities: { streaming: true },
  skills: [],
  supportedInterfaces: [
    {
      url: 'https://agent.example.com/a2a/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    },
  ],
  securitySchemes: {
    bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
  },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
};
const DECIDE = { tier: 'decide' as const, ref: 'human:wyat' };
const OPERATOR = { tier: 'operator' as const, ref: 'human:wyat' };
const publicDns = () => Promise.resolve(['93.184.216.34']);
const privateDns = () => Promise.resolve(['10.0.0.9']);

// A fake card server that also records the URL each request was sent to.
function serveCard(
  card: object,
  opts: { etag?: string; status?: number; seen?: string[] } = {}
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    opts.seen?.push(String(input instanceof Request ? input.url : input));
    if (opts.status !== undefined)
      return Promise.resolve(new Response('no', { status: opts.status }));
    if (
      opts.etag !== undefined &&
      new Headers(init?.headers).get('if-none-match') === opts.etag
    )
      return Promise.resolve(new Response(null, { status: 304 }));
    return Promise.resolve(
      Response.json(card, {
        headers: opts.etag === undefined ? {} : { etag: opts.etag },
      })
    );
  }) as typeof fetch;
}
const ownerNotices = () =>
  f.messaging.engine
    .inbox('human:wyat')
    .filter(({ message }) => message.kind === 'notice')
    .map(({ message }) => message.body);

describe('owner notices', () => {
  it('name the Settings page as well as the CLI, never a CLI-only flag', async () => {
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    markAuthFailed(f.peerDeps(), f.notices, 'acme');
    await refreshPeer(
      f.peerDeps({
        fetchImpl: serveCard(CARD),
        lookup: () => Promise.resolve(['169.254.169.254']),
      }),
      f.notices,
      'acme'
    );
    await waitFor(() => ownerNotices().length >= 2);
    for (const body of ownerNotices()) {
      expect(body).toContain('Settings → A2A → Peers');
      expect(body).not.toContain('--token-stdin');
    }
  });
});

describe('adding a peer', () => {
  it('lets a decide-tier human add a public https peer, the credential kept out of a2a.db', async () => {
    const seen: string[] = [];
    const row = await addPeer(
      f.peerDeps({
        fetchImpl: serveCard(CARD, { etag: '"v1"', seen }),
        lookup: publicDns,
      }),
      { alias: 'acme', cardUrl: CARD_URL, token: 'peer-secret' },
      DECIDE
    );
    expect(row).toMatchObject({
      alias: 'acme',
      status: 'active',
      binding: 'HTTP+JSON',
      interfaceUrl: 'https://agent.example.com/a2a/v1',
      addedTier: 'decide',
      etag: '"v1"',
    });
    expect(readPeerCredential(project.root(), 'acme')).toEqual({
      scheme: 'bearer',
      token: 'peer-secret',
    });
    expect(JSON.stringify(f.store.getPeer('acme'))).not.toContain(
      'peer-secret'
    );
    // The card fetch itself went to the checked address, not the name.
    expect(seen).toEqual(['https://93.184.216.34/.well-known/agent-card.json']);
  });

  it('refuses a decide-tier add that resolves to a private address, or asks for --allow-http', async () => {
    await expect(
      addPeer(
        f.peerDeps({ fetchImpl: serveCard(CARD), lookup: privateDns }),
        { alias: 'acme', cardUrl: CARD_URL, token: 't' },
        DECIDE
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'cardUrl' });
    await expect(
      addPeer(
        f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
        { alias: 'acme', cardUrl: CARD_URL, token: 't', allowHttp: true },
        DECIDE
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'allowHttp' });
  });

  it('refuses a decide-tier add whose interface resolves privately', async () => {
    const card = {
      ...CARD,
      supportedInterfaces: [
        {
          url: 'https://agent.example.com/a2a/v1',
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
        },
      ],
    };
    let lookups = 0;
    // Public for the card fetch, private by the interface check.
    const flipping = () =>
      Promise.resolve(lookups++ < 2 ? ['93.184.216.34'] : ['192.168.1.4']);
    await expect(
      addPeer(
        f.peerDeps({ fetchImpl: serveCard(card), lookup: flipping }),
        { alias: 'acme', cardUrl: CARD_URL, token: 't' },
        DECIDE
      )
    ).rejects.toMatchObject({ code: 'invalid', field: 'cardUrl' });
    expect(f.store.getPeer('acme')).toBeNull();
  });

  it('lets the operator add a private peer', async () => {
    const card = {
      ...CARD,
      supportedInterfaces: [
        {
          url: 'https://agent.internal.example/a2a/v1',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
      ],
    };
    const row = await addPeer(
      f.peerDeps({ fetchImpl: serveCard(card), lookup: privateDns }),
      {
        alias: 'intra',
        cardUrl: 'https://agent.internal.example/.well-known/agent-card.json',
        token: 't',
      },
      OPERATOR
    );
    expect(row).toMatchObject({ addedTier: 'operator', binding: 'JSONRPC' });
  });

  it('needs a token when the card asks for one, and refuses a used alias', async () => {
    const deps = f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns });
    await expect(
      addPeer(deps, { alias: 'acme', cardUrl: CARD_URL }, DECIDE)
    ).rejects.toMatchObject({ field: 'token' });
    expect(f.store.getPeer('acme')).toBeNull();
    await addPeer(
      deps,
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    await expect(
      addPeer(deps, { alias: 'acme', cardUrl: CARD_URL, token: 't' }, DECIDE)
    ).rejects.toMatchObject({ code: 'conflict', field: 'alias' });
  });
});

describe('refreshing a peer', () => {
  it('sends If-None-Match and keeps the card on 304', async () => {
    const deps = f.peerDeps({
      fetchImpl: serveCard(CARD, { etag: '"v1"' }),
      lookup: publicDns,
    });
    const added = await addPeer(
      deps,
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    const refreshed = await refreshPeer(deps, f.notices, 'acme');
    expect(refreshed).toMatchObject({
      etag: '"v1"',
      cardJson: added.cardJson,
      status: 'active',
    });
  });

  it('disables a peer whose card moved its interface origin, and tells the owner once', async () => {
    await addPeer(
      f.peerDeps({
        fetchImpl: serveCard({
          ...CARD,
          supportedInterfaces: [
            {
              url: 'https://other.example.com/a2a/v1',
              protocolBinding: 'HTTP+JSON',
              protocolVersion: '1.0',
            },
          ],
        }),
        lookup: publicDns,
      }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't', allowOrigin: true },
      OPERATOR
    );
    const moved = {
      ...CARD,
      supportedInterfaces: [
        {
          url: 'https://evil.example.net/a2a/v1',
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
        },
      ],
    };
    const deps = f.peerDeps({ fetchImpl: serveCard(moved), lookup: publicDns });
    expect((await refreshPeer(deps, f.notices, 'acme')).status).toBe(
      'disabled'
    );
    await refreshPeer(deps, f.notices, 'acme');
    await waitFor(() => ownerNotices().length > 0);
    expect(
      ownerNotices().filter(
        (b) => b.includes('a2a:acme') && b.includes('https://evil.example.net')
      )
    ).toHaveLength(1);
    expect(f.store.getPeer('acme')?.interfaceUrl).toBe(
      'https://other.example.com/a2a/v1'
    );
  });

  it('disables a decide-tier peer whose name now resolves privately, without fetching', async () => {
    const seen: string[] = [];
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    const row = await refreshPeer(
      f.peerDeps({
        fetchImpl: serveCard(CARD, { seen }),
        lookup: () => Promise.resolve(['169.254.169.254']),
      }),
      f.notices,
      'acme'
    );
    expect(row.status).toBe('disabled');
    expect(seen).toEqual([]);
    await waitFor(() =>
      ownerNotices().some((b) => b.includes('a2a:acme is disabled'))
    );
  });

  it('disables a decide-tier peer whose card fetch is refused after the pre-check', async () => {
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    let calls = 0;
    const seen: string[] = [];
    const row = await refreshPeer(
      f.peerDeps({
        fetchImpl: serveCard(CARD, { seen }),
        // Public for the pre-check, private by the pinned fetch.
        lookup: () =>
          Promise.resolve(calls++ === 0 ? ['93.184.216.34'] : ['10.0.0.9']),
      }),
      f.notices,
      'acme'
    );
    expect(row.status).toBe('disabled');
    expect(seen).toEqual([]);
    await waitFor(() =>
      ownerNotices().some((b) => b.includes('a2a:acme is disabled'))
    );
  });

  it('skips a refresh while the peer’s name does not resolve, keeping it active', async () => {
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    await expect(
      refreshPeer(
        f.peerDeps({
          fetchImpl: serveCard(CARD),
          lookup: () => Promise.reject(new Error('EAI_AGAIN')),
        }),
        f.notices,
        'acme'
      )
    ).rejects.toMatchObject({ status: null });
    expect(f.store.getPeer('acme')?.status).toBe('active');
    await Bun.sleep(20);
    expect(ownerNotices()).toEqual([]);
  });

  it('marks a peer auth-failed when its card answers 401, and refreshes only stale peers', async () => {
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    const later = () => new Date(Date.now() + 25 * 3_600_000);
    const deps = f.peerDeps({
      fetchImpl: serveCard(CARD, { status: 401 }),
      lookup: publicDns,
      now: later,
    });
    expect(
      await refreshDuePeers(
        f.peerDeps({
          fetchImpl: serveCard(CARD, { status: 401 }),
          lookup: publicDns,
        }),
        f.notices
      )
    ).toBe(0);
    expect(await refreshDuePeers(deps, f.notices)).toBe(1);
    expect(f.store.getPeer('acme')?.status).toBe('auth-failed');
    await waitFor(() =>
      ownerNotices().some(
        (b) => b.includes('a2a:acme') && b.includes('credential')
      )
    );
  });
});

describe('enabling and removing', () => {
  it('re-enables with a new token and removes the row with its credential', async () => {
    const deps = f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns });
    await addPeer(
      deps,
      { alias: 'acme', cardUrl: CARD_URL, token: 'old' },
      DECIDE
    );
    f.store.setPeerStatus('acme', 'auth-failed');
    expect((await setPeerEnabled(deps, 'acme', true, 'new')).status).toBe(
      'active'
    );
    expect(readPeerCredential(project.root(), 'acme')?.token).toBe('new');
    expect(removePeer(deps, 'acme')).toBe(true);
    expect(readPeerCredential(project.root(), 'acme')).toBeNull();
  });

  it('re-checks a decide-tier peer before enabling it', async () => {
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    f.store.setPeerStatus('acme', 'disabled');
    await expect(
      setPeerEnabled(f.peerDeps({ lookup: privateDns }), 'acme', true)
    ).rejects.toMatchObject({ code: 'invalid', field: 'cardUrl' });
    expect(f.store.getPeer('acme')?.status).toBe('disabled');
  });

  it('builds a guarded client for a decide-tier peer', async () => {
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias: 'acme', cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
    const seen: string[] = [];
    const client = peerClientFor(
      f.peerDeps({ fetchImpl: serveCard(CARD, { seen }), lookup: privateDns }),
      f.store.getPeer('acme')!
    );
    await expect(client.getTask('pt-1')).rejects.toMatchObject({
      reason: 'ADDRESS_REFUSED',
    });
    expect(seen).toEqual([]);
  });
});

describe('admission', () => {
  async function active(alias: string) {
    await addPeer(
      f.peerDeps({ fetchImpl: serveCard(CARD), lookup: publicDns }),
      { alias, cardUrl: CARD_URL, token: 't' },
      DECIDE
    );
  }

  it('fails a direct send to an absent or inactive peer, and skips it in a channel with one notice a day', async () => {
    await expect(
      f.messaging.engine.send(
        { to: ['a2a:ghost'], kind: 'message', body: 'hi' },
        HUMAN
      )
    ).rejects.toMatchObject({ code: 'not-found', field: 'to[0]' });
    await active('acme');
    f.store.setPeerStatus('acme', 'disabled');
    await expect(
      f.messaging.engine.send(
        { to: ['human:alice', 'a2a:acme'], kind: 'message', body: 'hi' },
        HUMAN
      )
    ).rejects.toMatchObject({ field: 'to[1]' });
    f.messaging.engine.join('ops', 'a2a:acme');
    f.messaging.engine.join('ops', 'human:alice');
    for (const body of ['one', 'two']) {
      const { deliveries } = await f.messaging.engine.send(
        { to: ['channel:ops'], kind: 'message', body },
        HUMAN
      );
      expect(deliveries.map((d) => d.recipient)).toEqual(['human:alice']);
    }
    await waitFor(() =>
      ownerNotices().some((b) => b.includes('a2a:acme is disabled'))
    );
    expect(
      ownerNotices().filter((b) => b.includes('a2a:acme is disabled'))
    ).toHaveLength(1);
  });

  it('does not count sends dated after now against outboundPerHour', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, outboundPerHour: 1 });
    await active('acme');
    await f.messaging.engine.send(
      { to: ['a2a:acme'], kind: 'message', body: 'first' },
      HUMAN
    );
    // The clock jumped forward for the first send and came back.
    f.deps.now = () => new Date(Date.now() - 365 * 86_400_000);
    await expect(
      f.messaging.engine.send(
        { to: ['a2a:acme'], kind: 'message', body: 'second' },
        HUMAN
      )
    ).resolves.toBeDefined();
  });

  it('refuses a direct send over outboundPerHour and holds a channel one', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, outboundPerHour: 1 });
    await active('acme');
    await f.messaging.engine.send(
      { to: ['a2a:acme'], kind: 'message', body: 'first' },
      HUMAN
    );
    const before = f.messaging.store.countDeliveredTo(
      'a2a:acme',
      '1970-01-01T00:00:00.000Z'
    );
    await expect(
      f.messaging.engine.send(
        { to: ['a2a:acme'], kind: 'message', body: 'second' },
        HUMAN
      )
    ).rejects.toMatchObject({ code: 'limited', field: 'to[0]' });
    expect(
      f.messaging.store.countDeliveredTo('a2a:acme', '1970-01-01T00:00:00.000Z')
    ).toBe(before);
    f.messaging.engine.join('ops', 'a2a:acme');
    const { deliveries } = await f.messaging.engine.send(
      { to: ['channel:ops'], kind: 'message', body: 'standup' },
      HUMAN
    );
    expect(deliveries).toMatchObject([
      { recipient: 'a2a:acme', state: 'held', via: 'channel' },
    ]);
  });

  it('never lets gate data reach a channel that holds a peer', async () => {
    await active('acme');
    f.messaging.engine.join('ops', 'a2a:acme');
    await expect(
      f.messaging.engine.send(
        {
          to: ['channel:ops'],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          body: 'wake?',
          data: { type: 'wake', target: 'task:t-000001', message: 'm-x' },
        },
        { address: 'agent:dispatch', canDecide: true }
      )
    ).rejects.toMatchObject({ code: 'forbidden', field: 'data' });
  });
});

describe('a card that asks for no credential', () => {
  const OPEN_CARD = {
    ...CARD,
    securitySchemes: undefined,
    securityRequirements: undefined,
  };

  it('refuses a token rather than dropping it silently', async () => {
    const deps = f.peerDeps({
      fetchImpl: serveCard(OPEN_CARD),
      lookup: publicDns,
    });
    await expect(
      addPeer(deps, { alias: 'open', cardUrl: CARD_URL, token: 't' }, DECIDE)
    ).rejects.toMatchObject({ code: 'invalid', field: 'token' });
    expect(f.store.getPeer('open')).toBeNull();
    await addPeer(deps, { alias: 'open', cardUrl: CARD_URL }, DECIDE);
    await expect(setPeerEnabled(deps, 'open', true, 't')).rejects.toMatchObject(
      { code: 'invalid', field: 'token' }
    );
    expect(readPeerCredential(project.root(), 'open')).toBeNull();
  });
});
