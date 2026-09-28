import { afterAll, beforeAll, expect, it } from 'bun:test';

import { createApiClient } from '../src/api';

const seen: { method: string; path: string; body: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        body: text === '' ? null : (JSON.parse(text) as unknown),
      });
      if (url.pathname === '/api/a2a/clients' && req.method === 'POST') {
        return Response.json(
          {
            address: 'agent:wyat/a2a.acme',
            token: 'f'.repeat(64),
            status: 'approved',
          },
          { status: 201 }
        );
      }
      return Response.json({
        enabled: false,
        listening: false,
        url: null,
        error: null,
        warnings: [],
        legacyClients: [],
      });
    },
  });
});
afterAll(() => server.stop(true));

it('speaks the /api/a2a routes with the bodies the daemon reads', async () => {
  seen.length = 0;
  const client = createApiClient(`http://127.0.0.1:${server.port}`);
  expect(
    await client.addA2AClient({
      name: 'acme',
      to: ['human:alice'],
      approve: true,
    })
  ).toMatchObject({ address: 'agent:wyat/a2a.acme' });
  await client.declineA2ATask('m-1', 'x');
  await client.rotateA2AClient('acme');
  await client.disableA2AListener();
  expect(seen).toEqual([
    {
      method: 'POST',
      path: '/api/a2a/clients',
      body: { name: 'acme', to: ['human:alice'], approve: true },
    },
    {
      method: 'POST',
      path: '/api/a2a/tasks/m-1/decline',
      body: { reason: 'x' },
    },
    { method: 'POST', path: '/api/a2a/clients/acme/rotate', body: null },
    { method: 'DELETE', path: '/api/a2a/listener', body: null },
  ]);
});

it('reads the listener, card, clients and tasks, and writes the listener', async () => {
  seen.length = 0;
  const client = createApiClient(`http://127.0.0.1:${server.port}`);
  await client.a2aListener();
  await client.setA2AListener({
    enabled: true,
    host: '127.0.0.1',
    port: 7450,
    publicUrl: null,
    tls: null,
    trustForwardedFor: false,
    standalone: false,
  });
  await client.a2aCard();
  await client.a2aClients();
  await client.a2aTasks();
  await client.a2aTasks('a2a.acme');
  await client.declineA2ATask('m/2');
  expect(seen).toEqual([
    { method: 'GET', path: '/api/a2a/listener', body: null },
    {
      method: 'PUT',
      path: '/api/a2a/listener',
      body: {
        enabled: true,
        host: '127.0.0.1',
        port: 7450,
        publicUrl: null,
        tls: null,
        trustForwardedFor: false,
        standalone: false,
      },
    },
    { method: 'GET', path: '/api/a2a/card', body: null },
    { method: 'GET', path: '/api/a2a/clients', body: null },
    { method: 'GET', path: '/api/a2a/tasks', body: null },
    { method: 'GET', path: '/api/a2a/tasks?client=a2a.acme', body: null },
    { method: 'POST', path: '/api/a2a/tasks/m%2F2/decline', body: {} },
  ]);
});
