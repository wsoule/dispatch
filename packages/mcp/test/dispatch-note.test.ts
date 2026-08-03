import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

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
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

// Stands in for dispatchd's health check plus POST /api/inbox, whose real
// body is whatever InboxStore.add() stored — an array that can be empty.
class FakeDaemon {
  inboxResult: { status: number; body: unknown } = {
    status: 201,
    body: [{ id: 'i-abc123' }],
  };
  posted: Record<string, unknown>[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (url.pathname === '/api/inbox' && req.method === 'POST') {
          this.posted.push((await req.json()) as Record<string, unknown>);
          return Response.json(this.inboxResult.body, {
            status: this.inboxResult.status,
          });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    return this.server.port ?? 0;
  }

  stop(): void {
    void this.server?.stop(true);
  }
}

let fakeHome: string;
let root: string;
let daemon: FakeDaemon | undefined;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-dispatch-note-'));
  TaskStore.init(root);
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeFakeDaemonFile(port: number): void {
  const path = daemonFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
    })
  );
}

describe('dispatch_note', () => {
  it('errors on an empty title without touching the daemon', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: '   ' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/title must not be empty/);
    expect(daemon.posted).toEqual([]);
  });

  it('errors with a "not running" message when there is no daemon', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: 'something' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });

  it('captures a note and returns the created id', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'triage', title: 'huge file', body: 'split tools.ts' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, id: 'i-abc123' });
    expect(daemon.posted).toEqual([
      { kind: 'task', text: 'huge file — split tools.ts' },
    ]);
  });

  // A title of pure bullet punctuation is accepted and stores nothing, and
  // `id: null` against `id: z.string()` is a protocol error no agent can act on.
  it('reports a tool error when the daemon stored nothing', async () => {
    daemon = new FakeDaemon();
    daemon.inboxResult = { status: 201, body: [] };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: '-' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/nothing was captured/);
    expect(result.structuredContent).toBeUndefined();
  });

  it("surfaces the daemon's own error when the post fails", async () => {
    daemon = new FakeDaemon();
    daemon.inboxResult = { status: 400, body: { error: 'text is required' } };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: 'x' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/text is required/);
  });
});
