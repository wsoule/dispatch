import { TaskStore } from '@dispatch-foo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

// task_next through a live daemon carries the daemon's readiness reading on
// each summary, and omits the key when the daemon sent none.

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

// Serves /api/health and a fixed /api/tasks/ready body.
class FakeDaemon {
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(private readonly ready: unknown[]) {}

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (url.pathname === '/api/tasks/ready')
          return Response.json(this.ready);
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-task-next-'));
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
      // Required, or the tools treat the file as stale and read the files.
      agentToken: 'a'.repeat(64),
    })
  );
}

describe('task_next readiness (fake daemon)', () => {
  it('passes the daemon reading through and omits it when absent', async () => {
    const store = new TaskStore(root);
    const judged = store.create({ title: 'Judged' });
    const plain = store.create({ title: 'Plain' });
    const reading = {
      level: 0,
      label: 'Only a title; nothing says what done looks like',
      confidence: 0.9,
      splitProbability: 0.1,
    };
    daemon = new FakeDaemon([{ ...judged, readiness: reading }, plain]);
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'task_next',
      arguments: {},
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const tasks = result.structuredContent?.tasks as {
      id: string;
      readiness?: unknown;
    }[];
    expect(tasks.map((t) => t.id)).toEqual([judged.meta.id, plain.meta.id]);
    expect(tasks[0].readiness).toEqual(reading);
    expect('readiness' in tasks[1]).toBe(false);
  });
});
