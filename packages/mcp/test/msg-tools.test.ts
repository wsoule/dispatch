import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { agentName, agentTokenFilePath } from '../src/identity.js';
import { createDispatchMcpServer } from '../src/index.js';
import type { MessageBlockingTiming } from '../src/index.js';
import { withBearer } from '../src/messaging.js';

// humanTotalWaitMs and defaultAgentTotalWaitMs are deliberately different
// (not just both "small") so a test that checks the agent-recipient fallback
// path can tell it apart from an accidental human-budget mix-up: if the two
// numbers were equal, a bug that used the wrong one would still pass.
// requestTimeoutMs is generous (well above what a local loopback fetch ever
// needs) so a slow CI host never trips it and turns a same-process 4xx into
// a spurious retry; the polls in these tests are paced by retryDelayMs, not
// by requestTimeoutMs, so this doesn't slow anything down.
const FAST_TIMING: MessageBlockingTiming = {
  humanTotalWaitMs: 500,
  defaultAgentTotalWaitMs: 200,
  requestTimeoutMs: 3000,
  retryDelayMs: 10,
  errorDelayMs: 10,
};

async function connectClient(
  rootDir: string,
  timing: MessageBlockingTiming = FAST_TIMING
): Promise<Client> {
  const server = createDispatchMcpServer(rootDir, { blockingTiming: timing });
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

const SHARED_AGENT_TOKEN = 'shared-agent-token';

const DEFAULT_SEND_BODY = {
  message: {
    id: 'm-1',
    thread: 't-1',
    from: 'run:r-self1',
    to: ['human:wyat'],
  },
  deliveries: [{ id: 'd-1', messageId: 'm-1', recipient: 'human:wyat' }],
  downgraded: false,
};

// A minimal stand-in for dispatchd's messaging surface
// (packages/server/src/messaging/routes.ts) — enough of every route
// msg_send/msg_reply/inbox_read/thread_read/channel_*/agents/register proxy
// to drive each tool's request shaping, response handling, and the
// identity-401 self-heal/revoked paths deterministically.
class FakeDaemon {
  // Each authorized POST /api/messages consumes the next entry; the last one
  // repeats once exhausted.
  sendResponses: { status: number; body: unknown }[] = [
    { status: 201, body: DEFAULT_SEND_BODY },
  ];
  sendCalls: {
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[] = [];

  answerStatus = 200;
  answerAfterPolls = 0;
  answerValue: unknown = {
    id: 'm-2',
    kind: 'answer',
    body: 'yes',
    choice: 'yes',
  };
  answerPolls = 0;
  /** Holds each answer poll open this long, to test client-side cancellation. */
  answerPollDelayMs = 0;

  replyStatus = 201;
  replyBody: unknown = {
    message: { id: 'm-3' },
    deliveries: [],
    downgraded: false,
  };
  replyCalls: { id: string; body: Record<string, unknown> }[] = [];

  mailboxBody: unknown = { items: [] };
  mailboxStateSeen: string | null = null;
  markReadCalls: string[] = [];

  threadBody: unknown = { messages: [], deliveries: [] };

  channelsBody: unknown = { channels: [] };
  joinCalls: { name: string; body: Record<string, unknown> }[] = [];
  leaveCalls: { name: string; addr: string }[] = [];
  selfLeaveCalls: string[] = [];

  configStatus = 200;
  configBody: unknown = { messaging: { agentBlockingTimeoutSec: 600 } };

  registerStatus = 201;
  registerBody: unknown = {
    address: 'agent:wyat/x',
    token: 'agent-token-value-2',
  };
  registerCalls: { name: string; client: string }[] = [];

  /** Bearer tokens messaging routes accept; a successful register adds its own. */
  messagingTokens = new Set<string>(['rt-secret']);
  revokedTokens = new Set<string>();
  /** Every bearer a route turned away, in arrival order. */
  rejectedTokens: string[] = [];
  /** Runs as a token is turned away, before the 401 goes out. */
  onReject: ((token: string) => void) | null = null;

  private server: ReturnType<typeof Bun.serve> | undefined;

  // Register and config take only the shared agentToken; every other route is
  // a messaging route and takes only a run or approved agent token.
  private authFailure(req: Request, url: URL): Response | null {
    const token = (req.headers.get('authorization') ?? '').replace(
      /^Bearer /,
      ''
    );
    const sharedOnly =
      url.pathname === '/api/config' || url.pathname === '/api/agents/register';
    if (
      sharedOnly
        ? token === SHARED_AGENT_TOKEN
        : this.messagingTokens.has(token)
    ) {
      return null;
    }
    this.rejectedTokens.push(token);
    this.onReject?.(token);
    if (!sharedOnly && this.revokedTokens.has(token)) {
      return Response.json(
        {
          error: "this agent's access was revoked",
          code: 'auth_agent_revoked',
        },
        { status: 401 }
      );
    }
    return Response.json(
      { error: 'unknown token', code: 'auth_invalid_token' },
      { status: 401 }
    );
  }

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        const denied = this.authFailure(req, url);
        if (denied !== null) return denied;

        if (url.pathname === '/api/messages' && req.method === 'POST') {
          const body = (await req.json()) as Record<string, unknown>;
          this.sendCalls.push({
            headers: Object.fromEntries(req.headers.entries()),
            body,
          });
          const idx = Math.min(
            this.sendCalls.length - 1,
            this.sendResponses.length - 1
          );
          const resp = this.sendResponses[idx];
          return Response.json(resp.body, { status: resp.status });
        }

        const answer = /^\/api\/messages\/([^/]+)\/answer$/.exec(url.pathname);
        if (answer !== null && req.method === 'GET') {
          this.answerPolls += 1;
          if (this.answerPollDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.answerPollDelayMs));
          }
          if (this.answerStatus !== 200) {
            return Response.json(
              { error: 'no' },
              { status: this.answerStatus }
            );
          }
          const ready = this.answerPolls > this.answerAfterPolls;
          return Response.json({ answer: ready ? this.answerValue : null });
        }

        const reply = /^\/api\/messages\/([^/]+)\/reply$/.exec(url.pathname);
        if (reply !== null && req.method === 'POST') {
          const body = (await req.json()) as Record<string, unknown>;
          this.replyCalls.push({ id: reply[1], body });
          return Response.json(this.replyBody, { status: this.replyStatus });
        }

        if (url.pathname === '/api/mailbox' && req.method === 'GET') {
          this.mailboxStateSeen = url.searchParams.get('state');
          return Response.json(this.mailboxBody);
        }

        const read = /^\/api\/deliveries\/([^/]+)\/read$/.exec(url.pathname);
        if (read !== null && req.method === 'POST') {
          this.markReadCalls.push(read[1]);
          return Response.json({ id: read[1], state: 'read' });
        }

        const thread = /^\/api\/threads\/([^/]+)$/.exec(url.pathname);
        if (thread !== null && req.method === 'GET') {
          return Response.json(this.threadBody);
        }

        if (url.pathname === '/api/channels' && req.method === 'GET') {
          return Response.json(this.channelsBody);
        }

        const join = /^\/api\/channels\/([^/]+)\/members$/.exec(url.pathname);
        if (join !== null && req.method === 'POST') {
          const body = (await req.json()) as Record<string, unknown>;
          this.joinCalls.push({ name: join[1], body });
          return new Response(null, { status: 204 });
        }
        if (join !== null && req.method === 'DELETE') {
          this.selfLeaveCalls.push(join[1]);
          return new Response(null, { status: 204 });
        }

        const leave = /^\/api\/channels\/([^/]+)\/members\/([^/]+)$/.exec(
          url.pathname
        );
        if (leave !== null && req.method === 'DELETE') {
          this.leaveCalls.push({ name: leave[1], addr: leave[2] });
          return new Response(null, { status: 204 });
        }

        if (url.pathname === '/api/config' && req.method === 'GET') {
          return Response.json(this.configBody, { status: this.configStatus });
        }

        if (url.pathname === '/api/agents/register' && req.method === 'POST') {
          const body = (await req.json()) as { name: string; client: string };
          this.registerCalls.push(body);
          const minted = (this.registerBody as { token?: unknown }).token;
          if (this.registerStatus === 201 && typeof minted === 'string') {
            this.messagingTokens.add(minted);
          }
          return Response.json(this.registerBody, {
            status: this.registerStatus,
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
const originalEnv = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_RUN_TOKEN_FILE: process.env.DISPATCH_RUN_TOKEN_FILE,
  DISPATCH_RUN_ID: process.env.DISPATCH_RUN_ID,
};

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-msg-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-msg-root-'));
  process.env.DISPATCH_HOME = fakeHome;
  const tokenFile = join(fakeHome, 'r-self1.token');
  writeFileSync(tokenFile, 'rt-secret', { mode: 0o600 });
  process.env.DISPATCH_RUN_TOKEN_FILE = tokenFile;
  process.env.DISPATCH_RUN_ID = 'r-self1';
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
      agentToken: SHARED_AGENT_TOKEN,
    })
  );
}

// Pre-caches an agent identity for this root/client so a test can exercise
// the agent-credential path (self-heal, revoked) without a live run token.
function writeCachedAgentToken(
  clientName: string,
  token: string,
  address: string
): string {
  delete process.env.DISPATCH_RUN_TOKEN_FILE;
  delete process.env.DISPATCH_RUN_ID;
  const name = agentName(process.env, clientName, hostname());
  const path = agentTokenFilePath(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ token, address }));
  return path;
}

describe('msg_send (no daemon running)', () => {
  it('errors with a "not running" message rather than a protocol failure', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });
});

describe('msg_send (fake daemon, run identity)', () => {
  it("sends with this run's own bearer token and a per-call Idempotency-Key", async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'status update' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.message).toEqual({
      id: 'm-1',
      thread: 't-1',
      from: 'run:r-self1',
      to: ['human:wyat'],
    });
    expect(daemon.sendCalls.length).toBe(1);
    expect(daemon.sendCalls[0]?.headers.authorization).toBe('Bearer rt-secret');
    expect(daemon.sendCalls[0]?.headers['idempotency-key']).toBeTruthy();
    expect(daemon.sendCalls[0]?.body).toMatchObject({
      to: ['human:wyat'],
      kind: 'message',
      body: 'status update',
    });
  });

  it('sends no session: a run is its own session', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    });
    expect(daemon.sendCalls[0]?.body).not.toHaveProperty('session');
  });

  it('rejects a kind that is neither a built-in nor a valid x-slug', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'not-a-kind', body: 'hi' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(daemon.sendCalls.length).toBe(0);
  });

  it('accepts a custom x-slug kind', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'x-custom', body: 'hi' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(daemon.sendCalls[0]?.body.kind).toBe('x-custom');
  });

  it('surfaces the server error text, including the offending field', async () => {
    daemon = new FakeDaemon();
    daemon.sendResponses = [
      {
        status: 400,
        body: {
          error: 'invalid to: expected a list of addresses',
          field: 'to',
        },
      },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      'invalid to: expected a list of addresses (field: to)'
    );
  });

  it('passes an "awaiting approval" 403 through verbatim', async () => {
    daemon = new FakeDaemon();
    daemon.sendResponses = [
      { status: 403, body: { error: 'awaiting approval in Dispatch' } },
    ];
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('awaiting approval in Dispatch');
  });
});

describe('msg_send (self-heal on an unknown cached agent token)', () => {
  it('drops the stale token, re-registers once, and retries the send once', async () => {
    const tokenPath = writeCachedAgentToken(
      'test-client',
      'stale-token',
      'agent:wyat/old'
    );
    daemon = new FakeDaemon();
    daemon.registerBody = { address: 'agent:wyat/new', token: 'fresh-token' };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(daemon.rejectedTokens).toEqual(['stale-token']);
    expect(daemon.sendCalls.length).toBe(1);
    expect(daemon.sendCalls[0]?.headers.authorization).toBe(
      'Bearer fresh-token'
    );
    expect(daemon.registerCalls.length).toBe(1);
    expect(JSON.parse(readFileSync(tokenPath, 'utf8'))).toEqual({
      token: 'fresh-token',
      address: 'agent:wyat/new',
    });
  });

  it('keeps a fresh token a parallel heal cached, instead of deleting it and registering again', async () => {
    const tokenPath = writeCachedAgentToken(
      'test-client',
      'stale-token',
      'agent:wyat/old'
    );
    daemon = new FakeDaemon();
    daemon.messagingTokens.add('parallel-token');
    daemon.onReject = () => {
      writeFileSync(
        tokenPath,
        JSON.stringify({ token: 'parallel-token', address: 'agent:wyat/x' })
      );
    };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(daemon.registerCalls).toEqual([]);
    expect(daemon.sendCalls[0]?.headers.authorization).toBe(
      'Bearer parallel-token'
    );
    expect(JSON.parse(readFileSync(tokenPath, 'utf8'))).toEqual({
      token: 'parallel-token',
      address: 'agent:wyat/x',
    });
  });

  it("returns the re-registration's own error when the heal cannot register", async () => {
    const tokenPath = writeCachedAgentToken(
      'test-client',
      'stale-token',
      'agent:wyat/old'
    );
    daemon = new FakeDaemon();
    daemon.registerStatus = 409;
    daemon.registerBody = { error: 'already registered (pending)' };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;

    const name = agentName(process.env, 'test-client', hostname());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `${name} is already registered; revoke it in Dispatch → Settings → Agents, then delete ${tokenPath}`
    );
  });
});

describe('msg_send (network error)', () => {
  it('retries a send whose response was lost with the same Idempotency-Key', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);
    const realFetch = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = (async (input, init) => {
      const res = await realFetch(input, init);
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const isSend = url.endsWith('/api/messages') && init?.method === 'POST';
      if (isSend && !dropped) {
        dropped = true;
        throw new TypeError('socket hang up');
      }
      return res;
    }) as typeof fetch;

    let result: ToolCallResult;
    try {
      result = (await client.callTool({
        name: 'msg_send',
        arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
      })) as ToolCallResult;
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(result.isError).toBeUndefined();
    expect(daemon.sendCalls.length).toBe(2);
    const [first, second] = daemon.sendCalls;
    expect(first?.headers['idempotency-key']).toBeTruthy();
    expect(second?.headers['idempotency-key']).toBe(
      first?.headers['idempotency-key']
    );
  });
});

describe('msg_send (revoked agent)', () => {
  it('reports a clear revoked error and does not re-register', async () => {
    const tokenPath = writeCachedAgentToken(
      'test-client',
      'revoked-token',
      'agent:wyat/old'
    );
    daemon = new FakeDaemon();
    daemon.revokedTokens.add('revoked-token');
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `This agent's access to ${root} was revoked. To ask for approval again, delete ${tokenPath} and retry.`
    );
    expect(daemon.registerCalls.length).toBe(0);
    expect(daemon.rejectedTokens).toEqual(['revoked-token']);
  });
});

describe('msg_send (blocking)', () => {
  it('long-polls past an unanswered poll and returns the answer, noting it was also pushed', async () => {
    daemon = new FakeDaemon();
    daemon.answerAfterPolls = 1;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: {
        to: ['human:wyat'],
        kind: 'question',
        body: 'which db?',
        blocking: true,
        choices: ['sqlite', 'postgres'],
      },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.answer).toEqual(daemon.answerValue);
    expect(result.structuredContent?.note).toMatch(
      /also delivered to your session/
    );
    expect(daemon.answerPolls).toBe(2);
  });

  it('gives up at the human total-wait budget with answer: null', async () => {
    daemon = new FakeDaemon();
    daemon.answerAfterPolls = Number.MAX_SAFE_INTEGER;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool(
      {
        name: 'msg_send',
        arguments: {
          to: ['human:wyat'],
          kind: 'question',
          body: 'which db?',
          blocking: true,
        },
      },
      undefined,
      { timeout: 10_000 }
    )) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.answer).toBeNull();
    expect(result.structuredContent?.note).toBe(
      'no answer yet — it will arrive in your inbox'
    );
    expect(result.structuredContent?.message).toBeTruthy();
    expect(daemon.answerPolls).toBeGreaterThan(1);
  });

  it('stops polling immediately on a non-retryable 4xx instead of riding out the budget', async () => {
    daemon = new FakeDaemon();
    daemon.answerStatus = 403;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: {
        to: ['human:wyat'],
        kind: 'question',
        body: 'which db?',
        blocking: true,
      },
    })) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(daemon.answerPolls).toBe(1);
  });

  it("uses the project's configured agentBlockingTimeoutSec for a non-human recipient, not the fallback default", async () => {
    daemon = new FakeDaemon();
    daemon.answerAfterPolls = Number.MAX_SAFE_INTEGER;
    // Tiny configured timeout (well under the fallback default below) proves
    // the config value actually won, rather than the tool having ignored it.
    daemon.configBody = { messaging: { agentBlockingTimeoutSec: 0.05 } };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root, {
      ...FAST_TIMING,
      defaultAgentTotalWaitMs: 60_000,
    });

    const result = (await client.callTool(
      {
        name: 'msg_send',
        arguments: {
          to: ['agent:wyat/bot'],
          kind: 'question',
          body: 'which db?',
          blocking: true,
        },
      },
      undefined,
      { timeout: 10_000 }
    )) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.answer).toBeNull();
  });

  it('falls back to defaultAgentTotalWaitMs (not the human budget) when GET /api/config is unreachable', async () => {
    daemon = new FakeDaemon();
    daemon.answerAfterPolls = Number.MAX_SAFE_INTEGER;
    daemon.configStatus = 500;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const start = Date.now();
    const result = (await client.callTool({
      name: 'msg_send',
      arguments: {
        to: ['agent:wyat/bot'],
        kind: 'question',
        body: 'which db?',
        blocking: true,
      },
    })) as ToolCallResult;
    const elapsedMs = Date.now() - start;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.answer).toBeNull();
    // Close to defaultAgentTotalWaitMs (200ms), well under humanTotalWaitMs
    // (500ms) — proves the agent fallback was used, not the human one.
    expect(elapsedMs).toBeLessThan(400);
  });

  it('stops polling promptly when the client cancels a blocking send', async () => {
    daemon = new FakeDaemon();
    daemon.answerAfterPolls = Number.MAX_SAFE_INTEGER;
    daemon.answerPollDelayMs = 5000;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root, {
      ...FAST_TIMING,
      humanTotalWaitMs: 60_000,
      requestTimeoutMs: 30_000,
    });

    await expect(
      client.callTool(
        {
          name: 'msg_send',
          arguments: {
            to: ['human:wyat'],
            kind: 'question',
            body: 'which db?',
            blocking: true,
          },
        },
        undefined,
        { timeout: 300 }
      )
    ).rejects.toThrow();

    const pollsAtCancel = daemon.answerPolls;
    await Bun.sleep(200);
    // No further poll should have started after cancellation propagated.
    expect(daemon.answerPolls).toBeLessThanOrEqual(pollsAtCancel);
  });
});

describe('msg_reply', () => {
  it('posts the reply body and choice to the target message', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_reply',
      arguments: { messageId: 'm-9', body: '', choice: 'approve' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(daemon.replyCalls).toEqual([
      { id: 'm-9', body: { body: '', choice: 'approve' } },
    ]);
  });

  it('surfaces the server error text on failure', async () => {
    daemon = new FakeDaemon();
    daemon.replyStatus = 404;
    daemon.replyBody = { error: 'no message m-404' };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_reply',
      arguments: { messageId: 'm-404', body: 'x' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('no message m-404');
  });
});

describe('inbox_read', () => {
  it('marks held and notified deliveries read but leaves pushed/read/answered alone, reporting exactly what it marked', async () => {
    daemon = new FakeDaemon();
    daemon.mailboxBody = {
      items: [
        { delivery: { id: 'd-held', state: 'held' }, message: { id: 'm-1' } },
        {
          delivery: { id: 'd-notified', state: 'notified' },
          message: { id: 'm-2' },
        },
        {
          delivery: { id: 'd-pushed', state: 'pushed' },
          message: { id: 'm-3' },
        },
        { delivery: { id: 'd-read', state: 'read' }, message: { id: 'm-4' } },
        {
          delivery: { id: 'd-answered', state: 'answered' },
          message: { id: 'm-5' },
        },
      ],
    };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'inbox_read',
      arguments: {},
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent!.items as unknown[]).length).toBe(5);
    expect((result.structuredContent!.marked as string[]).sort()).toEqual([
      'd-held',
      'd-notified',
    ]);
    expect(daemon.markReadCalls.sort()).toEqual(['d-held', 'd-notified']);
  });

  it('does not mark anything read when markRead is false', async () => {
    daemon = new FakeDaemon();
    daemon.mailboxBody = {
      items: [
        { delivery: { id: 'd-held', state: 'held' }, message: { id: 'm-1' } },
      ],
    };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'inbox_read',
      arguments: { markRead: false },
    })) as ToolCallResult;
    expect(daemon.markReadCalls).toEqual([]);
    expect(result.structuredContent?.marked).toEqual([]);
  });

  it('forwards a state filter as a comma-joined query param', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    await client.callTool({
      name: 'inbox_read',
      arguments: { state: ['held', 'notified'] },
    });
    expect(daemon.mailboxStateSeen).toBe('held,notified');
  });
});

describe('thread_read', () => {
  it('fetches the thread by id', async () => {
    daemon = new FakeDaemon();
    daemon.threadBody = {
      messages: [{ id: 'm-1' }],
      deliveries: [{ id: 'd-1' }],
    };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'thread_read',
      arguments: { threadId: 't-1' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(
      daemon.threadBody as Record<string, unknown>
    );
  });
});

describe('channel tools', () => {
  it('channel_join posts to the members route, omitting member when not given', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'channel_join',
      arguments: { name: 'epic/t-abc123' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    // Channel names may contain '/' (an epic's implicit epic/<id> channel),
    // so the tool encodeURIComponents the whole name — same as the client
    // package's own joinChannel — and the server decodeURIComponents it
    // back to one segment rather than splitting on the encoded slash.
    expect(daemon.joinCalls).toEqual([
      { name: encodeURIComponent('epic/t-abc123'), body: {} },
    ]);
  });

  it('channel_join passes member through when given', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    await client.callTool({
      name: 'channel_join',
      arguments: { name: 'general', member: 'agent:wyat/bot' },
    });
    expect(daemon.joinCalls).toEqual([
      { name: 'general', body: { member: 'agent:wyat/bot' } },
    ]);
  });

  it('channel_leave deletes the given member from the channel', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'channel_leave',
      arguments: { name: 'general', member: 'run:r-self1' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(daemon.leaveCalls).toEqual([
      { name: 'general', addr: encodeURIComponent('run:r-self1') },
    ]);
  });

  it('channel_leave with no member hits the self-leave route (no address segment)', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'channel_leave',
      arguments: { name: 'general' },
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(daemon.selfLeaveCalls).toEqual(['general']);
    expect(daemon.leaveCalls).toEqual([]);
  });

  it('channel_list returns the roster', async () => {
    daemon = new FakeDaemon();
    daemon.channelsBody = {
      channels: [{ name: 'general', auto: false, members: ['human:wyat'] }],
    };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'channel_list',
      arguments: {},
    })) as ToolCallResult;
    expect(result.structuredContent).toEqual(
      daemon.channelsBody as Record<string, unknown>
    );
  });
});

describe('messaging tools (agent identity, no run token)', () => {
  // Caches an approved agent identity and starts a daemon that accepts it.
  function startAgentDaemon(): FakeDaemon {
    writeCachedAgentToken('test-client', 'agent-token-value', 'agent:wyat/x');
    const fake = new FakeDaemon();
    fake.messagingTokens.add('agent-token-value');
    writeFakeDaemonFile(fake.start());
    return fake;
  }

  it('says a blocking answer is also in the mailbox, not pushed to a session', async () => {
    daemon = startAgentDaemon();
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: {
        to: ['human:wyat'],
        kind: 'question',
        body: 'which db?',
        blocking: true,
      },
    })) as ToolCallResult;

    expect(result.structuredContent?.answer).toEqual(daemon.answerValue);
    expect(result.structuredContent?.note).toBe(
      'this answer is also in your mailbox (inbox_read) — no need to act on it twice'
    );
  });

  it("names this MCP process's session on every send and reply", async () => {
    daemon = startAgentDaemon();
    const client = await connectClient(root);
    const send = { to: ['human:wyat'], kind: 'message', body: 'hi' };

    await client.callTool({ name: 'msg_send', arguments: send });
    await client.callTool({ name: 'msg_send', arguments: send });
    await client.callTool({
      name: 'msg_reply',
      arguments: { messageId: 'm-9', body: 'ok' },
    });
    const session = daemon.sendCalls[0]?.body.session;
    expect(typeof session).toBe('string');
    expect(session).not.toBe('');
    expect(daemon.sendCalls[1]?.body.session).toBe(session);
    expect(daemon.replyCalls[0]?.body.session).toBe(session);

    const otherProcess = await connectClient(root);
    await otherProcess.callTool({ name: 'msg_send', arguments: send });
    expect(daemon.sendCalls[2]?.body.session).toBeString();
    expect(daemon.sendCalls[2]?.body.session).not.toBe(session);
  });

  it('uses a cached self-registered agent token instead of the shared agentToken', async () => {
    writeCachedAgentToken('test-client', 'agent-token-value', 'agent:wyat/x');
    daemon = new FakeDaemon();
    daemon.messagingTokens.add('agent-token-value');
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'msg_send',
      arguments: { to: ['human:wyat'], kind: 'message', body: 'hi' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(daemon.sendCalls[0]?.headers.authorization).toBe(
      'Bearer agent-token-value'
    );
  });
});

describe('withBearer', () => {
  it('keeps headers passed as an object, a tuple list or a Headers instance', () => {
    const variants: NonNullable<RequestInit['headers']>[] = [
      { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      [
        ['content-type', 'application/json'],
        ['idempotency-key', 'k1'],
      ],
      new Headers({
        'content-type': 'application/json',
        'idempotency-key': 'k1',
      }),
    ];
    for (const headers of variants) {
      const merged = new Headers(withBearer({ headers }, 't').headers);
      expect(Object.fromEntries(merged.entries())).toEqual({
        authorization: 'Bearer t',
        'content-type': 'application/json',
        'idempotency-key': 'k1',
      });
    }
  });
});
