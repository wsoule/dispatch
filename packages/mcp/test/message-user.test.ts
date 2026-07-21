import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';

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

// A minimal stand-in for dispatchd's /api/runs/:id/message-user route — the
// same shape agent-message.test.ts's own FakeDaemon uses for /inject, scoped
// down to just what message_user needs: a health check and the one route it
// proxies to.
class FakeDaemon {
  messageUserResult: { status: number; body: unknown } = {
    status: 200,
    body: { id: 'unused', state: 'running' },
  };
  messageUserCalls: { runId: string; text: string }[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') {
          return Response.json({ ok: true });
        }
        const match = /^\/api\/runs\/([^/]+)\/message-user$/.exec(url.pathname);
        if (match !== null && req.method === 'POST') {
          const body = (await req.json()) as { text: string };
          this.messageUserCalls.push({ runId: match[1], text: body.text });
          return Response.json(this.messageUserResult.body, {
            status: this.messageUserResult.status,
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
const originalRunId = process.env.DISPATCH_RUN_ID;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-message-user-'));
  TaskStore.init(root);
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  if (originalRunId === undefined) delete process.env.DISPATCH_RUN_ID;
  else process.env.DISPATCH_RUN_ID = originalRunId;
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

describe('message_user input validation', () => {
  it('errors on empty text', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'message_user',
      arguments: { text: '   ' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/text must not be empty/);
  });

  it('errors when DISPATCH_RUN_ID is not set — no run context to post from', async () => {
    delete process.env.DISPATCH_RUN_ID;
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'message_user',
      arguments: { text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DISPATCH_RUN_ID/);
  });
});

describe('message_user (no daemon running)', () => {
  it('errors with a "not running" message rather than a protocol failure', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'message_user',
      arguments: { text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });
});

describe('message_user (fake daemon)', () => {
  it("posts to this run's own message-user route, taken from DISPATCH_RUN_ID", async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'message_user',
      arguments: { text: 'need clarification on X' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, runId: 'r-self1' });
    expect(daemon.messageUserCalls).toEqual([
      { runId: 'r-self1', text: 'need clarification on X' },
    ]);
  });

  it("surfaces the daemon's own error message when the call fails", async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.messageUserResult = {
      status: 409,
      body: { error: 'run is not running: r-self1' },
    };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'message_user',
      arguments: { text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/run is not running: r-self1/);
  });
});
