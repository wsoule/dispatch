import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath, serveArgs } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';
const APP_TOKEN = 'app-token-only-a-human-has';
const STATUS = {
  enabled: true,
  listening: true,
  url: 'http://127.0.0.1:7450',
  error: null,
  warnings: [],
  legacyClients: [],
};

const PEER = {
  alias: 'acme',
  cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
  interfaceUrl: 'https://agent.example.com/a2a/v1',
  binding: 'HTTP+JSON',
  status: 'active',
  name: 'Acme Planner',
  description: 'Plans.',
  skills: [],
  streaming: true,
  addedBy: 'human:wyat',
  addedTier: 'decide',
  fetchedAt: '2026-09-25T00:00:00Z',
  createdAt: '2026-09-25T00:00:00Z',
};

let root: string;
let home: string;
// What the fake daemon answers a listener write with.
let written: object;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let received: {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}[];
const originalHome = process.env.DISPATCH_HOME;
const originalApp = process.env.DISPATCH_APP_TOKEN;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

// A fake dispatchd answering the /api/a2a control routes with fixed shapes,
// recording each request's method, path, token and body.
function startFakeDaemon() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body =
        req.method === 'GET' ? null : await req.json().catch(() => null);
      received.push({
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get('authorization'),
        body,
      });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/a2a/listener') {
        if (req.method === 'DELETE')
          return Response.json({
            ...STATUS,
            enabled: false,
            listening: false,
            url: null,
          });
        return Response.json(req.method === 'PUT' ? written : STATUS);
      }
      if (url.pathname === '/api/a2a/card') {
        return Response.json({ name: 'Acme API' });
      }
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
      if (url.pathname === '/api/a2a/clients') {
        return Response.json({
          clients: [
            {
              address: 'agent:wyat/a2a.acme',
              name: 'a2a.acme',
              recipients: ['human:alice'],
              status: 'approved',
              createdBy: 'human:wyat',
              createdAt: '2026-09-25T00:00:00Z',
            },
          ],
        });
      }
      if (url.pathname === '/api/a2a/clients/acme/rotate') {
        return Response.json({ token: 'e'.repeat(64) });
      }
      if (url.pathname.startsWith('/api/agents/')) {
        return Response.json({ status: 'revoked' });
      }
      if (url.pathname === '/api/a2a/tasks') {
        return Response.json({
          tasks: [
            {
              id: 'm-1',
              client: 'agent:wyat/a2a.acme',
              contextId: 'm-1',
              skill: 'ask',
              state: 'WORKING',
              statusAt: '2026-09-25T00:00:00Z',
              dispatchTask: null,
            },
          ],
        });
      }
      if (url.pathname === '/api/a2a/peers' && req.method === 'GET')
        return Response.json({ peers: [PEER] });
      if (url.pathname === '/api/a2a/peers' && req.method === 'POST')
        return Response.json(PEER, { status: 201 });
      if (url.pathname === '/api/a2a/peers/acme' && req.method === 'DELETE')
        return new Response(null, { status: 204 });
      if (url.pathname.startsWith('/api/a2a/peers/acme/'))
        return Response.json({
          ...PEER,
          status: url.pathname.endsWith('/disable') ? 'disabled' : 'active',
        });
      if (url.pathname === '/api/a2a/hosts' && req.method === 'GET')
        return Response.json({
          standalone: false,
          hosts: [
            {
              id: 'h-1',
              name: 'relay',
              publicUrl: 'https://relay.example.com',
              createdBy: 'human:wyat',
              createdAt: '2026-09-25T00:00:00Z',
              revokedAt: null,
            },
          ],
        });
      if (url.pathname === '/api/a2a/hosts' && req.method === 'POST')
        return Response.json(
          {
            id: 'h-1',
            name: 'relay',
            publicUrl: 'https://relay.example.com',
            token: 'h'.repeat(64),
          },
          { status: 201 }
        );
      if (url.pathname === '/api/a2a/hosts/h-1' && req.method === 'DELETE')
        return new Response(null, { status: 204 });
      if (url.pathname === '/api/a2a/listener/standalone')
        return Response.json({
          standalone: (body as { enabled?: boolean } | null)?.enabled === true,
        });
      if (url.pathname === '/api/a2a/tasks/m-1/decline') {
        return Response.json({ id: 'm-1' });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-a2a-'));
  home = mkdtempSync(join(tmpdir(), 'dispatch-home-a2a-'));
  process.env.DISPATCH_HOME = home;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  received = [];
  written = STATUS;
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
  lines = [];
  server = startFakeDaemon();
  mkdirSync(join(home, '.dispatch', 'daemons'), { recursive: true });
  writeFileSync(
    daemonFilePath(root),
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: AGENT_TOKEN,
    })
  );
});

afterEach(() => {
  void server.stop(true);
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalApp === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalApp;
});

const a2aCalls = () =>
  received.filter(
    (r) => r.path.startsWith('/api/a2a') || r.path.startsWith('/api/agents')
  );

describe('dispatch a2a listen', () => {
  it('writes the listener settings with the app token and prints where it listens', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run(
      'a2a',
      'listen',
      '--port',
      '7450',
      '--public-url',
      'https://acme-agent.example.com',
      '--trust-forwarded-for'
    );
    expect(a2aCalls()).toEqual([
      {
        method: 'PUT',
        path: '/api/a2a/listener',
        auth: `Bearer ${APP_TOKEN}`,
        body: {
          enabled: true,
          host: '127.0.0.1',
          port: 7450,
          publicUrl: 'https://acme-agent.example.com',
          tls: null,
          trustForwardedFor: true,
          standalone: false,
        },
      },
    ]);
    expect(lines.join('\n')).toContain('http://127.0.0.1:7450');
  });

  it('fails when the daemon saved the settings but the listener did not open', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    written = { ...STATUS, listening: false, url: null, error: 'EADDRINUSE' };
    await expect(run('a2a', 'listen', '--port', '7450')).rejects.toThrow(
      CliError
    );
    expect(lines.join('\n')).toContain('closed (EADDRINUSE)');
  });

  it('never falls back to the agent token to open a listener', async () => {
    await expect(run('a2a', 'listen', '--port', '7450')).rejects.toThrow(
      CliError
    );
    expect(a2aCalls()).toEqual([]);
  });

  it('needs --port, and --tls-cert with --tls-key', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('a2a', 'listen')).rejects.toThrow(/--port/);
    await expect(
      run('a2a', 'listen', '--port', '7450', '--tls-cert', 'c.pem')
    ).rejects.toThrow(/go together/);
  });

  it('reads status with the agent token and turns the listener off with the app token', async () => {
    await run('a2a', 'listen', '--status');
    expect(a2aCalls()[0]).toMatchObject({
      method: 'GET',
      auth: `Bearer ${AGENT_TOKEN}`,
    });
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('a2a', 'listen', '--off');
    expect(a2aCalls()[1]).toMatchObject({
      method: 'DELETE',
      auth: `Bearer ${APP_TOKEN}`,
    });
  });
});

describe('dispatch a2a card', () => {
  it('prints the card read with the agent token', async () => {
    await run('a2a', 'card');
    expect(a2aCalls()).toEqual([
      {
        method: 'GET',
        path: '/api/a2a/card',
        auth: `Bearer ${AGENT_TOKEN}`,
        body: null,
      },
    ]);
    expect(lines.join('\n')).toContain('Acme API');
  });
});

describe('dispatch a2a clients', () => {
  it('adds a client with recipients and --approve, printing the token once', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run(
      'a2a',
      'clients',
      'add',
      'acme',
      '--to',
      'human:alice',
      '--to',
      'human:bob',
      '--approve'
    );
    expect(a2aCalls()[0]).toMatchObject({
      method: 'POST',
      path: '/api/a2a/clients',
      auth: `Bearer ${APP_TOKEN}`,
      body: { name: 'acme', to: ['human:alice', 'human:bob'], approve: true },
    });
    const out = lines.join('\n');
    expect(out).toContain('f'.repeat(64));
    expect(out).toContain('shown once');
  });

  it('adds without --approve on the agent token', async () => {
    await run('a2a', 'clients', 'add', 'acme');
    expect(a2aCalls()[0]).toMatchObject({
      auth: `Bearer ${AGENT_TOKEN}`,
      body: { name: 'acme' },
    });
  });

  it('never approves on the agent token', async () => {
    await expect(
      run('a2a', 'clients', 'add', 'acme', '--approve')
    ).rejects.toThrow(CliError);
    expect(a2aCalls()).toEqual([]);
  });

  it('lists, rotates and revokes', async () => {
    await run('a2a', 'clients', 'list');
    expect(lines.join('\n')).toContain('a2a.acme');
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('a2a', 'clients', 'rotate', 'acme');
    expect(a2aCalls().at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/a2a/clients/acme/rotate',
      auth: `Bearer ${APP_TOKEN}`,
    });
    expect(lines.join('\n')).toContain('e'.repeat(64));
    await run('a2a', 'clients', 'revoke', 'acme');
    expect(a2aCalls().at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/agents/${encodeURIComponent('agent:wyat/a2a.acme')}/revoke`,
      auth: `Bearer ${APP_TOKEN}`,
    });
  });

  it('revokes by the name as typed, normalized the way add normalizes it', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('a2a', 'clients', 'revoke', ' ACME');
    expect(a2aCalls().at(-1)).toMatchObject({
      path: `/api/agents/${encodeURIComponent('agent:wyat/a2a.acme')}/revoke`,
    });
  });

  it('refuses to revoke a name no client has', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('a2a', 'clients', 'revoke', 'nobody')).rejects.toThrow(
      /no A2A client nobody/
    );
    expect(a2aCalls().some((c) => c.path.startsWith('/api/agents'))).toBe(
      false
    );
  });
});

describe('dispatch a2a tasks', () => {
  it('lists tasks for a client and declines one', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('a2a', 'tasks', '--client', 'acme');
    expect(a2aCalls()[0]).toMatchObject({
      path: '/api/a2a/tasks?client=acme',
      auth: `Bearer ${APP_TOKEN}`,
    });
    expect(lines.join('\n')).toContain('m-1');
    await run('a2a', 'tasks', 'decline', 'm-1', '--reason', 'out of scope');
    expect(a2aCalls()[1]).toMatchObject({
      method: 'POST',
      path: '/api/a2a/tasks/m-1/decline',
      body: { reason: 'out of scope' },
    });
  });

  it('never lists tasks on the agent token', async () => {
    await expect(run('a2a', 'tasks')).rejects.toThrow(CliError);
    expect(a2aCalls()).toEqual([]);
  });
});

describe('dispatch serve', () => {
  it('passes the --a2a-* flags through to dispatchd', () => {
    expect(
      serveArgs('/r', {
        a2aHost: '0.0.0.0',
        a2aPort: '7450',
        a2aPublicUrl: 'https://x.example.com',
        a2aTlsCert: 'c.pem',
        a2aTlsKey: 'k.pem',
      })
    ).toEqual([
      '--root',
      '/r',
      '--a2a-host',
      '0.0.0.0',
      '--a2a-port',
      '7450',
      '--a2a-public-url',
      'https://x.example.com',
      '--a2a-tls-cert',
      'c.pem',
      '--a2a-tls-key',
      'k.pem',
    ]);
  });

  it('keeps the existing flags before the --a2a-* ones', () => {
    expect(
      serveArgs('/r', { port: '9000', tlsCert: 'a.pem', tlsKey: 'b.pem' })
    ).toEqual([
      '--root',
      '/r',
      '--port',
      '9000',
      '--tls-cert',
      'a.pem',
      '--tls-key',
      'b.pem',
    ]);
  });

  it('checks --a2a-tls-cert and --a2a-tls-key together', () => {
    expect(() => serveArgs('/r', { a2aTlsCert: 'c.pem' })).toThrow(
      /--a2a-tls-cert and --a2a-tls-key go together/
    );
  });
});

describe('dispatch a2a peers', () => {
  it('adds a peer with the credential read from stdin, never from argv', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    ctx.readStdin = () => Promise.resolve('peer-secret\n');
    await run(
      'a2a',
      'peers',
      'add',
      'acme',
      'https://agent.example.com/.well-known/agent-card.json',
      '--token-stdin',
      '--api-key-header',
      'X-API-Key'
    );
    expect(a2aCalls()[0]).toMatchObject({
      method: 'POST',
      path: '/api/a2a/peers',
      auth: `Bearer ${APP_TOKEN}`,
      body: {
        alias: 'acme',
        cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
        token: 'peer-secret',
        apiKeyHeader: 'X-API-Key',
      },
    });
    expect(lines.join('\n')).toContain('a2a:acme');
    expect(lines.join('\n')).not.toContain('peer-secret');
  });

  it('has no option that takes the credential on the command line', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(
      run(
        'a2a',
        'peers',
        'add',
        'acme',
        'https://x.example.com/card',
        '--peer-token',
        'peer-secret'
      )
    ).rejects.toThrow();
    expect(a2aCalls()).toEqual([]);
  });

  it('refuses an empty --token-stdin and never falls back to the agent token', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    ctx.readStdin = () => Promise.resolve('  \n');
    await expect(
      run(
        'a2a',
        'peers',
        'add',
        'acme',
        'https://x.example.com/card',
        '--token-stdin'
      )
    ).rejects.toThrow(/stdin/);
    delete process.env.DISPATCH_APP_TOKEN;
    await expect(
      run('a2a', 'peers', 'add', 'acme', 'https://x.example.com/card')
    ).rejects.toThrow(CliError);
    expect(a2aCalls()).toEqual([]);
  });

  it('passes --allow-http and --allow-origin through for the daemon to check the tier', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run(
      'a2a',
      'peers',
      'add',
      'intra',
      'http://10.0.0.5/card',
      '--allow-http',
      '--allow-origin'
    );
    expect(a2aCalls()[0].body).toMatchObject({
      alias: 'intra',
      allowHttp: true,
      allowOrigin: true,
    });
  });

  it('lists with the agent token, and refreshes, disables, enables with a new token and removes', async () => {
    await run('a2a', 'peers', 'list');
    expect(a2aCalls()[0]).toMatchObject({
      method: 'GET',
      auth: `Bearer ${AGENT_TOKEN}`,
    });
    expect(lines.join('\n')).toContain(
      'a2a:acme · active · Acme Planner · https://agent.example.com/a2a/v1'
    );
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    ctx.readStdin = () => Promise.resolve('new-secret');
    await run('a2a', 'peers', 'refresh', 'acme');
    await run('a2a', 'peers', 'disable', 'acme');
    await run('a2a', 'peers', 'enable', 'acme', '--token-stdin');
    await run('a2a', 'peers', 'remove', 'acme');
    expect(
      a2aCalls()
        .slice(1)
        .map((c) => `${c.method} ${c.path}`)
    ).toEqual([
      'POST /api/a2a/peers/acme/refresh',
      'POST /api/a2a/peers/acme/disable',
      'POST /api/a2a/peers/acme/enable',
      'DELETE /api/a2a/peers/acme',
    ]);
    expect(a2aCalls()[3].body).toEqual({ token: 'new-secret' });
    expect(lines.join('\n')).not.toContain('new-secret');
  });
});

describe('dispatch a2a hosts', () => {
  it('adds a host with the app token and prints its token once', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run(
      'a2a',
      'hosts',
      'add',
      'relay',
      '--public-url',
      'https://relay.example.com'
    );
    expect(a2aCalls()[0]).toMatchObject({
      method: 'POST',
      path: '/api/a2a/hosts',
      auth: `Bearer ${APP_TOKEN}`,
      body: { name: 'relay', publicUrl: 'https://relay.example.com' },
    });
    expect(lines.filter((l) => l.includes('h'.repeat(64)))).toHaveLength(1);
  });

  it('needs the public URL the host will serve on', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('a2a', 'hosts', 'add', 'relay')).rejects.toThrow();
    expect(a2aCalls()).toEqual([]);
  });

  it('allows and denies standalone hosts, lists and removes them', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('a2a', 'hosts', 'allow');
    await run('a2a', 'hosts', 'deny');
    await run('a2a', 'hosts', 'list');
    await run('a2a', 'hosts', 'remove', 'h-1');
    expect(a2aCalls().map((c) => [c.method, c.path, c.body])).toEqual([
      ['PUT', '/api/a2a/listener/standalone', { enabled: true }],
      ['PUT', '/api/a2a/listener/standalone', { enabled: false }],
      ['GET', '/api/a2a/hosts', null],
      ['DELETE', '/api/a2a/hosts/h-1', null],
    ]);
    expect(lines.join('\n')).toContain(
      'h-1 · relay · https://relay.example.com · active'
    );
  });

  it('never runs a hosts command on the agent token', async () => {
    for (const argv of [
      ['a2a', 'hosts', 'list'],
      ['a2a', 'hosts', 'add', 'relay', '--public-url', 'https://r.example'],
      ['a2a', 'hosts', 'allow'],
      ['a2a', 'hosts', 'remove', 'h-1'],
    ])
      await expect(run(...argv)).rejects.toThrow(CliError);
    expect(a2aCalls()).toEqual([]);
  });
});
