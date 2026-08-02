import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';
import type { ScopeTiming } from '../src/index.js';

// Milliseconds everywhere instead of the production minutes, so the loop's
// real exit conditions run in test time.
const FAST_TIMING: ScopeTiming = {
  totalWaitMs: 400,
  requestTimeoutMs: 200,
  retryDelayMs: 10,
  errorDelayMs: 10,
};

async function connectClient(
  rootDir: string,
  timing: ScopeTiming = FAST_TIMING
): Promise<Client> {
  const server = createDispatchMcpServer(rootDir, { scopeTiming: timing });
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

// A stand-in for dispatchd's scope-request routes. `decideAfterPolls` polls
// come back undecided first, which exercises the tool's re-poll loop.
class FakeDaemon {
  postStatus = 201;
  postBody: unknown = {
    id: 'sr-abc123',
    runId: 'r-self1',
    granted: null,
    decisionReason: null,
  };
  decideAfterPolls = 1;
  decision = true;
  pollStatus = 200;
  // When not 200, /decide rejects the tool's self-deny attempt — models a
  // real decision (from a human or the orchestrator) landing first.
  decideStatus = 200;
  // When > 0, /decide stalls past the tool's own request timeout, so its
  // fetch rejects instead of returning any status at all.
  decideHangsMs = 0;
  // What a 200 /decide echoes back, when the daemon does not simply mirror
  // what was posted — `granted: null` is a daemon that recorded nothing.
  decideEcho: {
    granted: boolean | null;
    decisionReason: string | null;
  } | null = null;
  // When true, a "decided" poll answers with a non-boolean `granted` — a
  // daemon whose payload does not match the contract.
  pollsGarbage = false;
  // When set, every GET after the first /decide call fails with this status —
  // the refetch that a 409 sends us back for, unreachable.
  pollStatusAfterDecide: number | null = null;
  // Once set, every GET after the first /decide call returns this instead
  // of the normal poll-count logic — the "real decision" a race exposes.
  raceWinner: { granted: boolean | null; reason: string } | null = null;
  decidePosted = false;
  posted: { runId: string; paths: string[]; reason: string }[] = [];
  decided: { id: string; granted: boolean; reason?: string }[] = [];
  polls = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') return Response.json({ ok: true });

        const create = /^\/api\/runs\/([^/]+)\/scope-requests$/.exec(
          url.pathname
        );
        if (create !== null && req.method === 'POST') {
          const body = (await req.json()) as {
            paths: string[];
            reason: string;
          };
          this.posted.push({ runId: create[1], ...body });
          return Response.json(this.postBody, { status: this.postStatus });
        }

        const decideRoute =
          /^\/api\/runs\/([^/]+)\/scope-requests\/([^/]+)\/decide$/.exec(
            url.pathname
          );
        if (decideRoute !== null && req.method === 'POST') {
          this.decidePosted = true;
          const body = (await req.json()) as {
            granted: boolean;
            reason?: string;
          };
          if (this.decideHangsMs > 0) await Bun.sleep(this.decideHangsMs);
          if (this.decideStatus !== 200) {
            return Response.json(
              { error: `scope request already decided: ${decideRoute[2]}` },
              { status: this.decideStatus }
            );
          }
          this.decided.push({ id: decideRoute[2], ...body });
          return Response.json({
            id: decideRoute[2],
            runId: decideRoute[1],
            granted:
              this.decideEcho === null ? body.granted : this.decideEcho.granted,
            decisionReason:
              this.decideEcho === null
                ? (body.reason ?? null)
                : this.decideEcho.decisionReason,
          });
        }

        const one = /^\/api\/runs\/([^/]+)\/scope-requests\/([^/]+)$/.exec(
          url.pathname
        );
        if (one !== null && req.method === 'GET') {
          this.polls += 1;
          if (this.decidePosted && this.pollStatusAfterDecide !== null) {
            return Response.json(
              { error: 'scope request unavailable' },
              { status: this.pollStatusAfterDecide }
            );
          }
          if (this.pollStatus !== 200) {
            return Response.json(
              { error: 'scope request not found' },
              { status: this.pollStatus }
            );
          }
          if (this.decidePosted && this.raceWinner !== null) {
            return Response.json({
              id: one[2],
              runId: one[1],
              granted: this.raceWinner.granted,
              decisionReason: this.raceWinner.reason,
            });
          }
          const decided = this.polls > this.decideAfterPolls;
          return Response.json({
            id: one[2],
            runId: one[1],
            granted: decided
              ? this.pollsGarbage
                ? 'yes'
                : this.decision
              : null,
            decisionReason: decided ? 'reviewed' : null,
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-request-scope-'));
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

describe('request_scope input validation', () => {
  it('errors on empty paths', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: [], reason: 'need it' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/paths must not be empty/);
  });

  it('errors on an empty reason', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['a.ts'], reason: '   ' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/reason must not be empty/);
  });

  it('errors when DISPATCH_RUN_ID is not set', async () => {
    delete process.env.DISPATCH_RUN_ID;
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['a.ts'], reason: 'need it' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DISPATCH_RUN_ID/);
  });

  it('errors when no daemon is running', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['a.ts'], reason: 'need it' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });
});

describe('request_scope (fake daemon)', () => {
  it('posts the request and re-polls past an undecided poll to return the grant', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.decideAfterPolls = 2;
    daemon.decision = true;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['a.ts', 'b.ts'], reason: 'shared barrel gap' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      granted: true,
      reason: 'reviewed',
    });
    expect(daemon.posted).toEqual([
      {
        runId: 'r-self1',
        paths: ['a.ts', 'b.ts'],
        reason: 'shared barrel gap',
      },
    ]);
    expect(daemon.polls).toBe(3);
    expect(daemon.decided).toEqual([]);
  });

  it('returns a real denial from the daemon without self-deciding', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.decideAfterPolls = 0;
    daemon.decision = false;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['a.ts'], reason: 'need it' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      granted: false,
      reason: 'reviewed',
    });
    expect(daemon.decided).toEqual([]);
  });

  it('gives up at the total budget and denies itself, never granting on a timeout', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.decideAfterPolls = Number.MAX_SAFE_INTEGER;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool(
      {
        name: 'request_scope',
        arguments: { paths: ['a.ts'], reason: 'need it' },
      },
      undefined,
      { timeout: 10_000 }
    )) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.granted).toBe(false);
    expect(result.content[0]?.text).toMatch(/denied/);
    expect(result.content[0]?.text).toMatch(/original fence/);
    expect(daemon.decided).toEqual([
      {
        id: 'sr-abc123',
        granted: false,
        reason: expect.stringMatching(/denied/),
      },
    ]);
  });

  it('honors a real grant that lands the instant before the self-deny call, instead of the canned denial', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.decideAfterPolls = Number.MAX_SAFE_INTEGER;
    daemon.decideStatus = 409;
    daemon.raceWinner = { granted: true, reason: 'granted just in time' };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool(
      {
        name: 'request_scope',
        arguments: { paths: ['a.ts'], reason: 'need it' },
      },
      undefined,
      { timeout: 10_000 }
    )) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      granted: true,
      reason: 'granted just in time',
    });
    // The self-deny POST was attempted and rejected — never recorded as a
    // decision, so the daemon's own record of what happened stays honest.
    expect(daemon.decided).toEqual([]);
  });

  // Every way the self-deny can fail to come back with a decision. These are
  // what make "expiry denies, never grants" true rather than merely intended.
  describe('when the self-deny cannot be confirmed', () => {
    async function expireWith(
      configure: (d: FakeDaemon) => void
    ): Promise<ToolCallResult> {
      process.env.DISPATCH_RUN_ID = 'r-self1';
      daemon = new FakeDaemon();
      daemon.decideAfterPolls = Number.MAX_SAFE_INTEGER;
      configure(daemon);
      writeFakeDaemonFile(daemon.start());
      const client = await connectClient(root);
      return (await client.callTool(
        {
          name: 'request_scope',
          arguments: { paths: ['a.ts'], reason: 'need it' },
        },
        undefined,
        { timeout: 10_000 }
      )) as ToolCallResult;
    }

    it('denies when the daemon rejects the self-deny with a plain error', async () => {
      const result = await expireWith((d) => {
        d.decideStatus = 500;
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.granted).toBe(false);
      expect(result.content[0]?.text).toMatch(/original fence/);
      expect(daemon?.decided).toEqual([]);
    });

    it('denies when the daemon never answers the self-deny at all', async () => {
      const result = await expireWith((d) => {
        // Longer than requestTimeoutMs, so the tool's own fetch aborts.
        d.decideHangsMs = 2000;
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.granted).toBe(false);
      expect(result.content[0]?.text).toMatch(/original fence/);
    });

    it('denies when a 409 sends it back for a decision it then cannot read', async () => {
      const result = await expireWith((d) => {
        d.decideStatus = 409;
        d.pollStatusAfterDecide = 503;
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.granted).toBe(false);
      expect(result.content[0]?.text).toMatch(/original fence/);
    });

    it('denies when the daemon accepts the self-deny but records no decision', async () => {
      const result = await expireWith((d) => {
        d.decideEcho = { granted: null, decisionReason: null };
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.granted).toBe(false);
      expect(result.content[0]?.text).toMatch(/original fence/);
    });

    it('denies rather than passing through a non-boolean decision', async () => {
      const result = await expireWith((d) => {
        d.decideAfterPolls = 0;
        d.pollsGarbage = true;
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.granted).toBe(false);
      // Still self-denied, so the request does not stay open server-side.
      expect(daemon?.decided).toEqual([
        {
          id: 'sr-abc123',
          granted: false,
          reason: expect.stringMatching(/denied/),
        },
      ]);
    });

    it('denies when a 409 refetch shows the request still undecided', async () => {
      const result = await expireWith((d) => {
        d.decideStatus = 409;
        d.raceWinner = { granted: null, reason: 'still open' };
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.granted).toBe(false);
      expect(result.structuredContent?.reason).toBe('still open');
    });
  });

  it('denies locally when the daemon no longer knows the request', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.pollStatus = 404;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['a.ts'], reason: 'need it' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.granted).toBe(false);
    expect(daemon.polls).toBe(1);
    // Already gone from the daemon's registry — nothing left to decide.
    expect(daemon.decided).toEqual([]);
  });

  it("surfaces the daemon's own error when the request can't be posted", async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.postStatus = 404;
    daemon.postBody = { error: 'run is not running: r-self1' };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['a.ts'], reason: 'need it' },
    })) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/run is not running: r-self1/);
  });
});
