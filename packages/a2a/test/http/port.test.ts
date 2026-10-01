import { afterAll, beforeAll, expect, it } from 'bun:test';

import { HttpBridgePort } from '../../src/http/port.js';
import { PORT_CLIENT_HEADER } from '../../src/http/wire.js';

const seen: {
  method: string;
  path: string;
  host: string | null;
  client: string | null;
  body: unknown;
}[] = [];
let watchConnections = 0;
let server: ReturnType<typeof Bun.serve>;
let port: HttpBridgePort;
const caller = {
  address: 'agent:wyat/a2a.acme',
  name: 'a2a.acme',
  credential: 'client-token',
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace('/api/a2a/port', '');
      seen.push({
        method: req.method,
        path: path + url.search,
        host: req.headers.get('authorization'),
        client: req.headers.get(PORT_CLIENT_HEADER),
        body:
          req.method === 'GET' || req.method === 'DELETE'
            ? null
            : await req.json(),
      });
      if (path === '/whoami')
        return Response.json({
          ok: true,
          caller: { address: 'agent:wyat/a2a.acme', name: 'a2a.acme' },
        });
      if (path === '/admit') return Response.json({ ok: true, lease: 'l-1' });
      if (path === '/card')
        return Response.json({
          name: 'Acme',
          description: null,
          publicUrl: 'https://something-else.example.com',
          version: '1',
          skills: ['ask'],
          blockingWaitSec: 60,
          pushNotifications: true,
        });
      if (path === '/tasks/m-gone')
        return Response.json(
          {
            error: {
              kind: 'a2a',
              reason: 'TASK_NOT_FOUND',
              message: 'task not found',
            },
          },
          { status: 404 }
        );
      if (path === '/open')
        return Response.json(
          {
            error: {
              kind: 'messaging',
              code: 'forbidden',
              message: 'not reachable',
              field: 'to[0]',
            },
          },
          { status: 403 }
        );
      if (path === '/tasks/m-1/watch') {
        watchConnections += 1;
        // One change, then the stream ends: the port must reconnect.
        return new Response('data: change\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(null, { status: 204 });
    },
  });
  port = new HttpBridgePort({
    daemonUrl: `http://127.0.0.1:${server.port}`,
    hostToken: 'host-token',
    publicUrl: 'https://relay.example.com',
    reconnectMs: 10,
  });
});
afterAll(() => server.stop(true));

it('sends its host token and forwards the client bearer it authenticated', async () => {
  const auth = await port.authenticate('client-token');
  expect(auth).toEqual({ ok: true, caller });
  expect(seen.at(-1)).toMatchObject({
    path: '/whoami',
    host: 'Bearer host-token',
    client: 'Bearer client-token',
  });
});

it('asks for its own public URL, with push off, and sends no client bearer for the card', async () => {
  const card = await port.card();
  expect(card).toMatchObject({
    publicUrl: 'https://relay.example.com',
    pushNotifications: false,
  });
  expect(seen.at(-1)).toMatchObject({
    path: `/card?publicUrl=${encodeURIComponent('https://relay.example.com')}`,
    client: null,
  });
});

it('releases a stream lease with DELETE', async () => {
  const admitted = await port.admit(caller, 'stream');
  expect(admitted.ok).toBe(true);
  if (admitted.ok) admitted.release?.();
  await Bun.sleep(20);
  expect(
    seen.some((s) => s.method === 'DELETE' && s.path === '/admit/l-1')
  ).toBe(true);
});

it('rebuilds the daemon’s errors and reads a missing task as null', async () => {
  expect(await port.facts(caller, 'm-gone')).toBeNull();
  await expect(
    port.open(caller, {
      clientMessageId: 'c-1',
      contextId: null,
      kind: 'ask',
      to: ['human:bob'],
      replyTo: null,
      body: 'hi',
      refs: [],
    })
  ).rejects.toMatchObject({ code: 'forbidden', field: 'to[0]' });
});

it('turns the watch stream into change calls and reconnects when it ends', async () => {
  let changes = 0;
  const stop = port.watch(caller, 'm-1', () => {
    changes += 1;
  });
  await Bun.sleep(150);
  stop();
  expect(watchConnections).toBeGreaterThan(1);
  expect(changes).toBeGreaterThan(1);
});

it('has no push configs', () => {
  const asPort: import('../../src/port.js').BridgePort = port;
  expect(asPort.pushConfigs).toBeUndefined();
});
