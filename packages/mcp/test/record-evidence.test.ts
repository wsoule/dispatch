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

// Stands in for dispatchd's health check plus the two routes
// record_evidence/record_mutation touch.
class FakeDaemon {
  evidenceResult: { status: number; body: unknown } = {
    status: 201,
    body: {
      command: 'bun test',
      exitCode: 0,
      durationMs: 10,
      summary: 'ok',
      at: 't1',
    },
  };
  mutationResult: { status: number; body: unknown } = {
    status: 201,
    body: { guard: 'g', file: 'f.ts', testsFailed: 0, at: 't1' },
  };
  evidenceCalls: Record<string, unknown>[] = [];
  mutationCalls: Record<string, unknown>[] = [];
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
        if (
          url.pathname === '/api/runs/r-self1/evidence' &&
          req.method === 'POST'
        ) {
          this.evidenceCalls.push(
            (await req.json()) as Record<string, unknown>
          );
          return Response.json(this.evidenceResult.body, {
            status: this.evidenceResult.status,
          });
        }
        if (
          url.pathname === '/api/runs/r-self1/mutations' &&
          req.method === 'POST'
        ) {
          this.mutationCalls.push(
            (await req.json()) as Record<string, unknown>
          );
          return Response.json(this.mutationResult.body, {
            status: this.mutationResult.status,
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-record-evidence-'));
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

describe('record_evidence input validation', () => {
  it('errors on empty command', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'record_evidence',
      arguments: { command: '  ', exitCode: 0, durationMs: 1, summary: 'ok' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/command must not be empty/);
  });

  it('errors when DISPATCH_RUN_ID is not set', async () => {
    delete process.env.DISPATCH_RUN_ID;
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'record_evidence',
      arguments: {
        command: 'bun test',
        exitCode: 0,
        durationMs: 1,
        summary: 'ok',
      },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DISPATCH_RUN_ID/);
  });
});

describe('record_evidence (fake daemon)', () => {
  it('posts the command to the calling run', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'record_evidence',
      arguments: {
        command: 'bun test',
        exitCode: 0,
        durationMs: 4200,
        summary: '158 pass, 0 fail',
      },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true });
    expect(daemon.evidenceCalls).toEqual([
      {
        command: 'bun test',
        exitCode: 0,
        durationMs: 4200,
        summary: '158 pass, 0 fail',
      },
    ]);
  });

  it("surfaces the daemon's own error message when the post fails", async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.evidenceResult = { status: 404, body: { error: 'run not found' } };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'record_evidence',
      arguments: {
        command: 'bun test',
        exitCode: 0,
        durationMs: 1,
        summary: 'ok',
      },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/run not found/);
  });
});

describe('record_mutation (fake daemon)', () => {
  it('posts the mutation result to the calling run, testsFailed 0 included', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'record_mutation',
      arguments: {
        guard: 'null check on foo()',
        file: 'src/foo.ts',
        testsFailed: 0,
      },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true });
    expect(daemon.mutationCalls).toEqual([
      { guard: 'null check on foo()', file: 'src/foo.ts', testsFailed: 0 },
    ]);
  });

  it('errors when DISPATCH_RUN_ID is not set', async () => {
    delete process.env.DISPATCH_RUN_ID;
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'record_mutation',
      arguments: { guard: 'g', file: 'f.ts', testsFailed: 1 },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DISPATCH_RUN_ID/);
  });
});
