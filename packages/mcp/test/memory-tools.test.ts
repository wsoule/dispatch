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
const seen: { path: string; auth: string | null }[] = [];
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
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get('authorization'),
      });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
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

async function call(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const mcp = createDispatchMcpServer(root);
  const c = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([c.connect(a), mcp.connect(b)]);
  return (await c.callTool({ name, arguments: args })) as ToolCallResult;
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
});
