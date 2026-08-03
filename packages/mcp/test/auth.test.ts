import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';
import type { ScopeTiming } from '../src/index.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';
const APP_TOKEN = 'app-token-mcp-must-never-reach';

// Milliseconds instead of the production minutes, so the scope loop reaches
// its expiry path in test time.
const FAST_SCOPE_TIMING: ScopeTiming = {
  totalWaitMs: 300,
  requestTimeoutMs: 200,
  retryDelayMs: 10,
  errorDelayMs: 10,
};

async function connectClient(rootDir: string): Promise<Client> {
  const server = createDispatchMcpServer(rootDir, {
    scopeTiming: FAST_SCOPE_TIMING,
  });
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

// Enforces the real tier split so a tool that sent the wrong credential (or
// none) fails here exactly as it would against a real daemon.
class FakeDaemon {
  seen: { path: string; method: string; auth: string | null }[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const url = new URL(req.url);
        const auth = req.headers.get('authorization');
        this.seen.push({ path: url.pathname, method: req.method, auth });
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (auth !== `Bearer ${AGENT_TOKEN}`) {
          return Response.json(
            { error: 'missing daemon token', code: 'auth_missing_token' },
            { status: 401 }
          );
        }
        if (url.pathname.endsWith('/decide')) {
          return Response.json(
            { error: 'needs the app token', code: 'auth_insufficient_tier' },
            { status: 403 }
          );
        }
        if (url.pathname === '/api/runs') return Response.json([]);
        if (url.pathname === '/api/inbox') {
          return Response.json([{ id: 'i-1' }], { status: 201 });
        }
        if (url.pathname.endsWith('/scope-requests')) {
          return Response.json({
            id: 'sr-1',
            granted: null,
            decisionReason: null,
          });
        }
        // A scope-request read-back: still undecided.
        return Response.json({
          id: 'sr-1',
          granted: null,
          decisionReason: null,
        });
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
let daemon: FakeDaemon;
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalRunId = process.env.DISPATCH_RUN_ID;
const originalAppToken = process.env.DISPATCH_APP_TOKEN;

// The daemon file carries an `appToken` a real daemon never writes, so a tool
// that reached for one would be caught rather than silently finding nothing.
function writeDaemonFile(port: number): void {
  const path = daemonFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: AGENT_TOKEN,
      appToken: APP_TOKEN,
    })
  );
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-auth-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-auth-'));
  TaskStore.init(root);
  daemon = new FakeDaemon();
  writeDaemonFile(daemon.start());
});

afterEach(() => {
  daemon.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  if (originalRunId === undefined) delete process.env.DISPATCH_RUN_ID;
  else process.env.DISPATCH_RUN_ID = originalRunId;
  if (originalAppToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalAppToken;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('the token MCP tools present', () => {
  it('is the agent token, on a read', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'run_list',
      arguments: {},
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const runs = daemon.seen.find((r) => r.path === '/api/runs');
    expect(runs?.auth).toBe(`Bearer ${AGENT_TOKEN}`);
  });

  it('is the agent token, on a write', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: 'something to look at' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    const note = daemon.seen.find((r) => r.path === '/api/inbox');
    expect(note?.auth).toBe(`Bearer ${AGENT_TOKEN}`);
  });

  it('is never the app token, even when one sits in the daemon file', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    await client.callTool({ name: 'run_list', arguments: {} });
    await client.callTool({
      name: 'dispatch_note',
      arguments: { kind: 'note', title: 'something to look at' },
    });
    expect(daemon.seen.length).toBeGreaterThan(0);
    expect(daemon.seen.filter((r) => r.auth === `Bearer ${APP_TOKEN}`)).toEqual(
      []
    );
  });

  it('is absent from the open health probe', async () => {
    const client = await connectClient(root);
    await client.callTool({ name: 'run_list', arguments: {} });
    const health = daemon.seen.find((r) => r.path === '/api/health');
    expect(health?.auth).toBeNull();
  });
});

describe('no path from this package to an app token', () => {
  // A source scan, because the guarantee is structural: no runtime test can
  // prove the absence of a code path that reads one.
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('never names an app token anywhere in src/', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const offenders = sourceFiles(src).filter((file) =>
      /appToken|DISPATCH_APP_TOKEN/i.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});

describe('an expired scope request', () => {
  it('denies locally when the daemon refuses its self-denial', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'request_scope',
      arguments: { paths: ['src/a.ts'], reason: 'needed for the fix' },
    })) as ToolCallResult;
    // The daemon refused to record the denial; the agent is still denied.
    expect(result.structuredContent?.granted).toBe(false);
    const decide = daemon.seen.find((r) => r.path.endsWith('/decide'));
    expect(decide?.auth).toBe(`Bearer ${AGENT_TOKEN}`);
  }, 20_000);
});
