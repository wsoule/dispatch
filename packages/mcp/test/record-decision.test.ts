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

// Stands in for dispatchd's health check plus the three routes
// record_decision touches: the run, its task, and POST /api/ledger.
class FakeDaemon {
  run: { taskId: string } | null = { taskId: 't-caller1' };
  task: { meta: { parent: string | null } } | null = {
    meta: { parent: 'e-epic001' },
  };
  ledgerResult: { status: number; body: unknown } = {
    status: 201,
    body: { id: 'l-abc123' },
  };
  ledgerCalls: Record<string, unknown>[] = [];
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
        if (url.pathname === '/api/runs/r-self1' && req.method === 'GET') {
          return this.run === null
            ? Response.json({ error: 'not found' }, { status: 404 })
            : Response.json(this.run);
        }
        if (url.pathname === '/api/tasks/t-caller1' && req.method === 'GET') {
          return this.task === null
            ? Response.json({ error: 'not found' }, { status: 404 })
            : Response.json(this.task);
        }
        if (url.pathname === '/api/ledger' && req.method === 'POST') {
          this.ledgerCalls.push((await req.json()) as Record<string, unknown>);
          return Response.json(this.ledgerResult.body, {
            status: this.ledgerResult.status,
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-record-decision-'));
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

describe('record_decision input validation', () => {
  it('errors on empty title', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'record_decision',
      arguments: { kind: 'decision', title: '   ', detail: 'd' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/title must not be empty/);
  });

  it('errors when DISPATCH_RUN_ID is not set', async () => {
    delete process.env.DISPATCH_RUN_ID;
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'record_decision',
      arguments: { kind: 'hazard', title: 't', detail: 'd' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DISPATCH_RUN_ID/);
  });
});

describe('record_decision (no daemon running)', () => {
  it('errors with a "not running" message rather than a protocol failure', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'record_decision',
      arguments: { kind: 'hazard', title: 't', detail: 'd' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });
});

describe('record_decision (fake daemon)', () => {
  it('resolves the calling task and its epic, then posts to the ledger', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'record_decision',
      arguments: {
        kind: 'hazard',
        title: 'withActionFeedback swallows rejections',
        detail: 'every catch downstream of it is dead code',
      },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, id: 'l-abc123' });
    expect(daemon.ledgerCalls).toEqual([
      {
        epicId: 'e-epic001',
        sourceTaskId: 't-caller1',
        kind: 'hazard',
        title: 'withActionFeedback swallows rejections',
        detail: 'every catch downstream of it is dead code',
        appliesTo: [],
      },
    ]);
  });

  it('falls back to a project-wide, sourceless entry when the run cannot be resolved', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.run = null;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    await client.callTool({
      name: 'record_decision',
      arguments: { kind: 'decision', title: 't', detail: 'd' },
    });

    expect(daemon.ledgerCalls).toEqual([
      {
        epicId: null,
        sourceTaskId: null,
        kind: 'decision',
        title: 't',
        detail: 'd',
        appliesTo: [],
      },
    ]);
  });

  it("surfaces the daemon's own error message when the post fails", async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.ledgerResult = { status: 400, body: { error: 'invalid kind' } };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'record_decision',
      arguments: { kind: 'decision', title: 't', detail: 'd' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/invalid kind/);
  });
});
