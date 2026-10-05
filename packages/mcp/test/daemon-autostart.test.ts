import { TaskStore } from '@dispatch-foo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath, setDaemonStarter } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

// A background daemon exits after it sits unused, so `dispatch mcp` hands the
// server a starter for the tools that cannot work without one. These pin
// which tools use it: the ones with no other way forward, and never a
// file-backed read that already works without a daemon.

async function connectClient(rootDir: string): Promise<Client> {
  const server = createDispatchMcpServer(rootDir);
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

let fakeHome: string;
let root: string;
let daemon: ReturnType<typeof Bun.serve> | undefined;
let starts: string[];
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-autostart-'));
  TaskStore.init(root);
  starts = [];
});

afterEach(() => {
  setDaemonStarter(null);
  void daemon?.stop(true);
  daemon = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// What a real start leaves behind: a daemon answering health and the inbox,
// and the daemon file that points at it.
function startFakeDaemon(rootDir: string): void {
  daemon = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/inbox' && req.method === 'POST') {
        return Response.json([{ id: 'i-started' }], { status: 201 });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  const path = daemonFilePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port: daemon.port,
      pid: process.pid,
      rootDir,
      startedAt: new Date().toISOString(),
      agentToken: 'test-agent-token',
    })
  );
}

function markDatabaseBacked(): void {
  writeFileSync(
    join(root, '.dispatch', 'storage.json'),
    JSON.stringify({ backend: 'sqlite' })
  );
}

describe('starting dispatchd on demand', () => {
  it('starts a daemon for dispatch_note, which has no direct path', async () => {
    setDaemonStarter((rootDir) => {
      starts.push(rootDir);
      startFakeDaemon(rootDir);
      return Promise.resolve();
    });
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: 'after the daemon idled out' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(starts).toEqual([root]);
  });

  it('does not start one for a file-backed read that works without it', async () => {
    setDaemonStarter((rootDir) => {
      starts.push(rootDir);
      return Promise.resolve();
    });
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'task_list',
      arguments: {},
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(starts).toEqual([]);
  });

  it('tries to start one for a database-backed project, and says so when it cannot', async () => {
    markDatabaseBacked();
    setDaemonStarter((rootDir) => {
      starts.push(rootDir);
      return Promise.reject(new Error('bun is not installed'));
    });
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'task_list',
      arguments: {},
    })) as ToolCallResult;

    expect(starts).toEqual([root]);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd is not running/);
  });

  it('keeps the old "not running" answer when no starter was given', async () => {
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: 'something' },
    })) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });
});
