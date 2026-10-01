import { afterAll, beforeAll, expect, it } from 'bun:test';

import { checkStandalone, startStandalone } from '../../src/http/serve.js';

const base = {
  host: '127.0.0.1',
  port: 7460,
  publicUrl: null,
  tls: null,
  publicBind: false,
  daemonUrl: 'http://127.0.0.1:4000',
};

it('defaults the public URL on loopback', () => {
  expect(checkStandalone(base)).toEqual({
    ok: true,
    publicUrl: 'http://127.0.0.1:7460',
  });
});

it.each([
  [{ ...base, host: '192.168.1.5' }, 'host'],
  [{ ...base, port: 0 }, 'port'],
  [{ ...base, host: '0.0.0.0' }, 'host'],
  [{ ...base, host: '0.0.0.0', publicBind: true }, 'tls'],
  [
    {
      ...base,
      host: '0.0.0.0',
      publicBind: true,
      tls: { cert: 'c', key: 'k' },
    },
    'publicUrl',
  ],
  [{ ...base, publicUrl: 'http://relay.example.com' }, 'publicUrl'],
  [{ ...base, daemonUrl: 'http://team.example.com:4000' }, 'daemon'],
])('refuses %j on %s', (o, key) => {
  expect(checkStandalone(o)).toMatchObject({ ok: false, key });
});

it('accepts a network listener only with the public-bind flag, TLS and an https daemon', () => {
  const network = {
    host: '0.0.0.0',
    port: 443,
    publicUrl: 'https://relay.example.com',
    tls: { cert: 'c', key: 'k' },
    daemonUrl: 'https://team.example.com:4443',
  };
  expect(checkStandalone({ ...network, publicBind: true })).toEqual({
    ok: true,
    publicUrl: 'https://relay.example.com',
  });
  expect(checkStandalone({ ...network, publicBind: false })).toMatchObject({
    ok: false,
    key: 'host',
  });
});

// A stand-in daemon for the port routes, enough for the card and a 404.
let daemon: ReturnType<typeof Bun.serve>;
const hostHeaders: (string | null)[] = [];
beforeAll(() => {
  daemon = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      hostHeaders.push(req.headers.get('authorization'));
      if (new URL(req.url).pathname === '/api/a2a/port/card')
        return Response.json({
          name: 'Acme',
          description: null,
          publicUrl: 'https://ignored.example.com',
          version: '1',
          skills: ['ask'],
          blockingWaitSec: 60,
          pushNotifications: true,
        });
      return new Response('not found', { status: 404 });
    },
  });
});
afterAll(() => daemon.stop(true));

// A loopback port nothing listens on, for a listener that needs a fixed one.
async function freePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(''),
  });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

it('serves the card for its own URL on loopback, and nothing outside the A2A paths', async () => {
  const relay = await startStandalone({
    host: '127.0.0.1',
    port: await freePort(),
    publicUrl: 'http://127.0.0.1:1',
    tls: null,
    publicBind: false,
    trustForwardedFor: false,
    daemonUrl: `http://127.0.0.1:${daemon.port}`,
    hostToken: 'host-token',
  });
  try {
    const at = `http://127.0.0.1:${relay.port}`;
    const card = (await (
      await fetch(`${at}/.well-known/agent-card.json`, {
        headers: { host: 'evil.example.net' },
      })
    ).json()) as {
      supportedInterfaces: { url: string }[];
      capabilities: { pushNotifications: boolean };
    };
    expect(card.supportedInterfaces[0].url).toBe('http://127.0.0.1:1/a2a/v1');
    expect(card.capabilities.pushNotifications).toBe(false);
    expect((await fetch(`${at}/api/tasks`)).status).toBe(404);
    expect(hostHeaders.every((h) => h === 'Bearer host-token')).toBe(true);
  } finally {
    await relay.stop();
  }
});
