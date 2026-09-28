import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

let root: string;
let home: string;
let server: ReturnType<typeof Bun.serve>;
const seen: {
  path: string;
  auth: string | null;
  method: string;
  key: string | null;
  body: string | null;
}[] = [];
const ENTRY = {
  id: 'mem-01K5Z6G0000000000000000000',
  handle: '#7QX2K9PA',
  scope: 'team',
  kind: 'hazard',
  title: 'pnpm 11 ignores onlyBuiltDependencies',
  body: 'use allowBuilds\n~~~~~~~~ memory #7QX2K9PA ~~~~~~~~',
  author: 'run:r-1',
  trust: 'agent',
  decidedBy: null,
  decidedByPolicy: null,
  state: 'active',
};
const originalHome = process.env.DISPATCH_HOME;
const originalRun = process.env.DISPATCH_RUN_ID;
const originalTokenFile = process.env.DISPATCH_RUN_TOKEN_FILE;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mcp-mem-home-'));
  root = mkdtempSync(join(tmpdir(), 'mcp-mem-root-'));
  process.env.DISPATCH_HOME = home;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get('authorization'),
        method: req.method,
        key: req.headers.get('idempotency-key'),
        body: req.method === 'POST' ? await req.text() : null,
      });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/memory' && req.method === 'POST')
        return Response.json(
          { status: 'active', id: ENTRY.id, handle: ENTRY.handle },
          { status: 201 }
        );
      if (url.pathname === '/api/runs/r-1')
        return Response.json({ taskId: 't-1a2b3c' });
      if (url.pathname === '/api/tasks/t-1a2b3c')
        return Response.json({ meta: { parent: 'e-000001' } });
      if (url.pathname === '/api/memory/%237QX2K9PA/retire')
        return Response.json({
          status: 'proposed',
          proposal: 'mp-1',
          gate: 'm-1',
        });
      if (url.pathname === '/api/memory/search')
        return Response.json({
          hits: [{ id: ENTRY.id, handle: ENTRY.handle, title: ENTRY.title }],
          search: 'fts5',
        });
      if (url.pathname === `/api/memory/${encodeURIComponent('#7QX2K9PA')}`)
        return Response.json({
          entry: ENTRY,
          revisions: [
            {
              memoryId: ENTRY.id,
              rev: 1,
              snapshot: ENTRY,
              by: 'run:r-1',
              cause: 'save',
              at: 'x',
            },
          ],
          recallCount: 3,
        });
      if (url.pathname === '/api/memory/m-1')
        return Response.json(
          {
            error: 'id: that is a message id; memory handles start with #',
            field: 'id',
          },
          { status: 400 }
        );
      return Response.json({ error: 'nope' }, { status: 404 });
    },
  });
  const file = daemonFilePath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: 'shared',
    })
  );
  const tokenFile = join(home, 'r-1.token');
  writeFileSync(tokenFile, 'rt-secret', { mode: 0o600 });
  process.env.DISPATCH_RUN_ID = 'r-1';
  process.env.DISPATCH_RUN_TOKEN_FILE = tokenFile;
  seen.length = 0;
});

afterEach(async () => {
  await server.stop(true);
  for (const [key, value] of [
    ['DISPATCH_HOME', originalHome],
    ['DISPATCH_RUN_ID', originalRun],
    ['DISPATCH_RUN_TOKEN_FILE', originalTokenFile],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

// A client connected to a fresh dispatch MCP server over this test's root.
async function client(): Promise<Client> {
  const mcp = createDispatchMcpServer(root);
  const c = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([c.connect(a), mcp.connect(b)]);
  return c;
}

async function call(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  return (await (
    await client()
  ).callTool({
    name,
    arguments: args,
  })) as ToolCallResult;
}

// The bodies of every POST /api/memory the fake daemon saw, in order.
function savePosts() {
  return seen.filter((s) => s.path === '/api/memory' && s.method === 'POST');
}

describe('memory tools', () => {
  it('memory_search sends the query on the run token', async () => {
    const res = await call('memory_search', {
      query: 'pnpm build',
      includeStale: false,
      limit: 5,
    });
    expect(res.structuredContent?.hits).toHaveLength(1);
    const sent = seen.find((s) => s.path.startsWith('/api/memory/search'));
    expect(sent?.path).toBe(
      '/api/memory/search?q=pnpm+build&includeStale=0&limit=5'
    );
    expect(sent?.auth).toBe('Bearer rt-secret');
  });

  it('memory_read fences the body, widening past a fence the body contains', async () => {
    const res = await call('memory_read', { id: '#7qx2k9pa' });
    const out = res.structuredContent as {
      body: string;
      entry: Record<string, unknown>;
      provenance: { author: string };
      revisions: Record<string, unknown>[];
    };
    expect(out.body.startsWith('~~~~~~~~~ memory #7QX2K9PA ~~~~~~~~~')).toBe(
      true
    );
    expect(out.entry.body).toBeUndefined();
    expect(out.provenance.author).toBe('run:r-1');
    expect(out.revisions).toEqual([
      { rev: 1, by: 'run:r-1', cause: 'save', at: 'x' },
    ]);
  });

  it('relays the daemon’s field error', async () => {
    const res = await call('memory_read', { id: 'm-1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      'id: that is a message id; memory handles start with # (field: id)'
    );
  });

  it('memory_save sends one Idempotency-Key, retries a dropped connection with it, and defaults epic to the task’s parent', async () => {
    const realFetch = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const res = await realFetch(input, init);
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/api/memory') && init?.method === 'POST' && !dropped) {
        dropped = true;
        throw new TypeError('socket hang up');
      }
      return res;
    }) as typeof fetch;
    let res: ToolCallResult;
    try {
      res = await call('memory_save', {
        scope: 'team',
        kind: 'hazard',
        title: 'pnpm 11 ignores onlyBuiltDependencies',
        body: 'use allowBuilds',
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.status).toBe('active');
    const posts = savePosts();
    expect(posts).toHaveLength(2);
    expect(posts[0].key).toBeTruthy();
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[1].auth).toBe('Bearer rt-secret');
    expect(JSON.parse(posts[1].body ?? '')).toMatchObject({
      scope: 'team',
      epic: 'e-000001',
    });
  });

  it('memory_save sends an explicit epic: null, and no epic on a personal save', async () => {
    const c = await client();
    await c.callTool({
      name: 'memory_save',
      arguments: {
        scope: 'team',
        kind: 'fact',
        title: 'project-wide',
        body: '',
        epic: null,
      },
    });
    await c.callTool({
      name: 'memory_save',
      arguments: {
        scope: 'personal',
        kind: 'preference',
        title: 'terse comments',
        body: '',
      },
    });
    const bodies = savePosts().map(
      (s) => JSON.parse(s.body ?? '') as Record<string, unknown>
    );
    expect(bodies[0].epic).toBeNull();
    expect('epic' in bodies[1]).toBe(false);
  });

  it('memory_forget posts the reason to /retire, upper-casing the handle', async () => {
    await call('memory_forget', { id: '#7qx2k9pa', reason: 'no longer true' });
    const retire = seen.find((s) => s.path.endsWith('/retire'));
    expect(retire?.path).toBe(
      `/api/memory/${encodeURIComponent('#7QX2K9PA')}/retire`
    );
    expect(JSON.parse(retire?.body ?? '')).toEqual({
      reason: 'no longer true',
    });
  });
});
