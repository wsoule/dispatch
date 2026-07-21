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

// A minimal stand-in for dispatchd's HTTP surface, giving full deterministic
// control over run state and inject() outcomes — the real Orchestrator's
// FakeExecutor (production default, no approval gate) finishes synchronously
// before an HTTP response even lands, so it can never stay "live" long
// enough for agent_message's live-run filtering to observe it; this fake
// server is what makes that filtering (and the inject round trip) testable
// at all without changing production wiring just for a test.
class FakeDaemon {
  runs: { id: string; taskId: string; taskTitle: string; state: string }[] = [];
  injectResult: { status: number; body: unknown } = {
    status: 200,
    body: { id: 'unused', state: 'running' },
  };
  injectedTexts: string[] = [];
  // Full request bodies for every /inject call — agent-message.test.ts's
  // own fromRunId tests need to see whether `fromRunId` rode along, not
  // just the text `injectedTexts` already tracks.
  injectedBodies: { text: string; fromRunId?: string }[] = [];
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
        if (url.pathname === '/api/runs' && req.method === 'GET') {
          return Response.json(this.runs);
        }
        const injectMatch = /^\/api\/runs\/([^/]+)\/inject$/.exec(url.pathname);
        if (injectMatch !== null && req.method === 'POST') {
          const body = (await req.json()) as {
            text: string;
            fromRunId?: string;
          };
          this.injectedTexts.push(body.text);
          this.injectedBodies.push(body);
          return Response.json(this.injectResult.body, {
            status: this.injectResult.status,
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-agent-message-'));
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

// Writes a daemon file pointing at `port` — the exact shape
// packages/server/src/daemonfile.ts's writer produces, reproduced by hand
// here since @dispatch/mcp's runtime code never imports @dispatch/server
// (Bun-only, no importable exports beyond package.json — see daemon.ts's own
// doc comment on why this scheme is duplicated rather than shared).
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

describe('agent_message input validation (no daemon required)', () => {
  it('errors when both runId and taskId are given', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-111111', taskId: 't-111111', text: 'hi' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/exactly one of runId or taskId/);
  });

  it('errors when neither runId nor taskId is given', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { text: 'hi' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/exactly one of runId or taskId/);
  });

  it('errors on empty text', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-111111', text: '   ' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/text must not be empty/);
  });
});

describe('agent_message (no daemon running)', () => {
  it('errors with a "not running" message rather than a protocol failure', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-111111', text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });
});

describe('agent_message (fake live daemon)', () => {
  it('reports "no live runs at all" when nothing is live', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-anything', text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no live runs at all/);
  });

  it('lists live runs (id + task title) when the runId target does not match one', async () => {
    daemon = new FakeDaemon();
    daemon.runs = [
      {
        id: 'r-live1',
        taskId: 't-aaa',
        taskTitle: 'Alpha task',
        state: 'running',
      },
      {
        id: 'r-done1',
        taskId: 't-bbb',
        taskTitle: 'Done task',
        state: 'finished',
      },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-wrong', text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('r-live1');
    expect(result.content[0]?.text).toContain('Alpha task');
    // The terminal run must not be offered as a live target.
    expect(result.content[0]?.text).not.toContain('r-done1');
  });

  it('delivers to a run targeted by runId', async () => {
    daemon = new FakeDaemon();
    daemon.runs = [
      {
        id: 'r-live1',
        taskId: 't-aaa',
        taskTitle: 'Alpha task',
        state: 'running',
      },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-live1', text: 'hello from another agent' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, runId: 'r-live1' });
    expect(daemon.injectedTexts).toEqual(['hello from another agent']);
  });

  it("resolves a taskId target to that task's live run", async () => {
    daemon = new FakeDaemon();
    daemon.runs = [
      {
        id: 'r-live1',
        taskId: 't-aaa',
        taskTitle: 'Alpha task',
        state: 'running',
      },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { taskId: 't-aaa', text: 'hello via task' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, runId: 'r-live1' });
  });

  it('reports no live target for a taskId with no live run', async () => {
    daemon = new FakeDaemon();
    daemon.runs = [
      {
        id: 'r-done1',
        taskId: 't-bbb',
        taskTitle: 'Done task',
        state: 'finished',
      },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { taskId: 't-bbb', text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no live run for t-bbb/);
  });

  it("surfaces the daemon's own error message when inject itself fails", async () => {
    daemon = new FakeDaemon();
    daemon.runs = [
      {
        id: 'r-live1',
        taskId: 't-aaa',
        taskTitle: 'Alpha task',
        state: 'running',
      },
    ];
    daemon.injectResult = {
      status: 409,
      body: { error: 'run is not running: r-live1' },
    };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-live1', text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/run is not running: r-live1/);
  });

  // agent-comms: ClaudeExecutor sets DISPATCH_RUN_ID to the calling agent's
  // own run id in this MCP server's env (see packages/server/src/
  // orchestrator/executors/claude.ts) — agent_message reads it back out and
  // passes it through as `fromRunId` on the /inject request so dispatchd
  // can resolve a real sender label instead of falling back to a generic
  // one.
  it('passes DISPATCH_RUN_ID through as fromRunId when set', async () => {
    process.env.DISPATCH_RUN_ID = 'r-caller1';
    daemon = new FakeDaemon();
    daemon.runs = [
      {
        id: 'r-live1',
        taskId: 't-aaa',
        taskTitle: 'Alpha task',
        state: 'running',
      },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-live1', text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(daemon.injectedBodies).toEqual([
      { text: 'hello', fromRunId: 'r-caller1' },
    ]);
  });

  it('omits fromRunId when DISPATCH_RUN_ID is unset', async () => {
    delete process.env.DISPATCH_RUN_ID;
    daemon = new FakeDaemon();
    daemon.runs = [
      {
        id: 'r-live1',
        taskId: 't-aaa',
        taskTitle: 'Alpha task',
        state: 'running',
      },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'agent_message',
      arguments: { runId: 'r-live1', text: 'hello' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(daemon.injectedBodies).toEqual([{ text: 'hello' }]);
  });
});
