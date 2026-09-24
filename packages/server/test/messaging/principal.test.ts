import { TaskStore } from '@dispatch/core';
import type { AgentRecord } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiContext, DaemonTokens } from '../../src/api.js';
import { isSelfAuthenticated, mintDaemonTokens } from '../../src/api.js';
import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import type { CredentialSource, TokenLookup } from '../../src/identity.js';
import { sha256, TokenRegistry } from '../../src/identity.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { resolvePrincipal } from '../../src/messaging/principal.js';
import type { Messaging } from '../../src/messaging/service.js';
import { openMessaging } from '../../src/messaging/service.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { Executor, ExecutorRun } from '../../src/orchestrator/types.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { rawFetch } from '../testAuth.js';

// sha256 hex digest, matching how resolvePrincipal hashes a presented token
// before looking it up as an agent's credential (see agentByTokenHash).
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// A minimal AgentRecord for seeding `messaging.store` directly — the fields
// resolvePrincipal doesn't read (displayName, client, createdAt) are filled
// with placeholders.
function stubAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    address: 'agent:codex/reviewer',
    displayName: 'Reviewer',
    client: 'codex',
    tokenHash: tokenHash('agent-raw-token'),
    status: 'approved',
    muted: false,
    approvedBy: 'human:wyat',
    createdAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

// A teammate credential source backing exactly one token with a chosen
// TokenLookup outcome — standing in for the real team module (Elastic
// License 2.0, out of scope for this package's tests). Taking the outcome
// directly (rather than just a tier) lets tests drive the 'expired' and
// 'refused' branches resolvePrincipal now handles via registry.lookup, not
// only 'valid'.
function teammateSource(token: string, result: TokenLookup): CredentialSource {
  const digest = sha256(token);
  return {
    lookup: (presentedDigest: Buffer): TokenLookup =>
      presentedDigest.equals(digest) ? result : { kind: 'unknown' },
    list: () => [],
  };
}

let root: string;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-principal-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Real Orchestrator + real openMessaging, wired the same way service.test.ts
// does — cheaper than a full startServer and gives resolvePrincipal's three
// collaborators (tokens, orchestrator, messaging) without an HTTP round trip.
function makeHarness(teammates: CredentialSource | null = null): {
  ctx: ApiContext;
  tokens: DaemonTokens;
  orchestrator: Orchestrator;
  messaging: Messaging;
  executor: StallingExecutor;
  store: TaskStore;
} {
  const store = TaskStore.init(root);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: root,
    store,
    cache,
    events,
  });
  const executor = new StallingExecutor();
  orchestrator.registerExecutor('claude', executor);
  const tokenPair = mintDaemonTokens();
  const tokens: DaemonTokens = {
    ...tokenPair,
    registry: new TokenRegistry(tokenPair, 'wyat', teammates),
  };
  const messaging = openMessaging({
    rootDir: root,
    orchestrator,
    store,
    events,
    ownerRef: 'human:wyat',
    dbPath: join(root, 'messages.db'),
  });
  // resolvePrincipal only reads ctx.tokens, ctx.orchestrator and
  // ctx.messaging — a narrow, cast subset stands in for the full ApiContext
  // the real handleApi builds, per the task-5 controller ruling.
  const ctx = { tokens, orchestrator, messaging } as unknown as ApiContext;
  return { ctx, tokens, orchestrator, messaging, executor, store };
}

describe('resolvePrincipal', () => {
  it('refuses no credential as unknown token (401, auth_missing_token)', () => {
    const { ctx } = makeHarness();
    const result = resolvePrincipal(ctx, null);
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: 'unknown token',
      code: 'auth_missing_token',
    });
  });

  it('refuses a garbage token as unknown token (401, auth_invalid_token)', () => {
    const { ctx } = makeHarness();
    const result = resolvePrincipal(ctx, 'not-a-real-token');
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: 'unknown token',
      code: 'auth_invalid_token',
    });
  });

  it('the shared agentToken is refused with the register hint (403)', () => {
    const { ctx, tokens } = makeHarness();
    const result = resolvePrincipal(ctx, tokens.agentToken);
    expect(result).toEqual({
      ok: false,
      status: 403,
      error:
        "the shared agent token cannot send messages — use this run's DISPATCH_RUN_TOKEN, or register with POST /api/agents/register",
      code: 'auth_agent_token_forbidden',
    });
  });

  it('a human token at operator tier resolves with canDecide true', () => {
    const { ctx, tokens } = makeHarness();
    const result = resolvePrincipal(ctx, tokens.appToken);
    expect(result).toEqual({
      ok: true,
      principal: { address: 'human:wyat', canDecide: true, kind: 'human' },
    });
  });

  it('a human token below decide tier resolves with canDecide false', () => {
    const { ctx } = makeHarness(
      teammateSource('teammate-token', {
        kind: 'valid',
        identity: { handle: 'ada', ref: 'human:ada', tier: 'request' },
      })
    );
    const result = resolvePrincipal(ctx, 'teammate-token');
    expect(result).toEqual({
      ok: true,
      principal: { address: 'human:ada', canDecide: false, kind: 'human' },
    });
  });

  it('a decide-tier teammate token resolves with canDecide true', () => {
    const { ctx } = makeHarness(
      teammateSource('decide-token', {
        kind: 'valid',
        identity: { handle: 'ada', ref: 'human:ada', tier: 'decide' },
      })
    );
    const result = resolvePrincipal(ctx, 'decide-token');
    expect(result).toEqual({
      ok: true,
      principal: { address: 'human:ada', canDecide: true, kind: 'human' },
    });
  });

  it('an expired teammate token is refused with the expiry code (401)', () => {
    const { ctx } = makeHarness(
      teammateSource('expired-token', {
        kind: 'expired',
        handle: 'ada',
        expiredAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const result = resolvePrincipal(ctx, 'expired-token');
    expect(result).toEqual({
      ok: false,
      status: 401,
      error:
        'this token for ada expired on 2026-01-01T00:00:00.000Z. Ask whoever runs the daemon to invite you again (`dispatch team invite ada`).',
      code: 'auth_token_expired',
    });
  });

  it('a seat-refused teammate token is refused with the seat_limit code (403)', () => {
    const { ctx } = makeHarness(
      teammateSource('refused-token', {
        kind: 'refused',
        handle: 'ada',
        reason: 'the license covers 3 teammates; ada would be a 4th',
      })
    );
    const result = resolvePrincipal(ctx, 'refused-token');
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'the license covers 3 teammates; ada would be a 4th',
      code: 'seat_limit',
    });
  });

  it('a run token for a live run resolves as that run, never able to decide', async () => {
    const { ctx, orchestrator, executor, messaging, store } = makeHarness();
    const task = store.create({ title: 'Say hello' });
    const meta = await orchestrator.dispatch(task.meta.id, 'claude', {});
    expect(orchestrator.isRunLive(meta.id)).toBe(true);
    const token = messaging.runTokens.mint(meta.id);

    const result = resolvePrincipal(ctx, token);
    expect(result).toEqual({
      ok: true,
      principal: { address: `run:${meta.id}`, canDecide: false, kind: 'run' },
    });
    expect(executor.started).toHaveLength(1);
    await orchestrator.cancel(meta.id);
  });

  it('a run token for a run that has ended is refused (401)', async () => {
    const { ctx, orchestrator, messaging, store } = makeHarness();
    const task = store.create({ title: 'Say hello, then stop' });
    const meta = await orchestrator.dispatch(task.meta.id, 'claude', {});
    const token = messaging.runTokens.mint(meta.id);

    await orchestrator.cancel(meta.id);
    expect(orchestrator.isRunLive(meta.id)).toBe(false);

    const result = resolvePrincipal(ctx, token);
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: 'run token for a finished run',
      code: 'auth_run_token_ended',
    });
  });

  it('a run token for an id the orchestrator never registered is refused (401)', () => {
    const { ctx, messaging } = makeHarness();
    const token = messaging.runTokens.mint('r-neverexisted');
    const result = resolvePrincipal(ctx, token);
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: 'run token for a finished run',
      code: 'auth_run_token_ended',
    });
  });

  it('an approved agent resolves as itself, never able to decide', () => {
    const { ctx, messaging } = makeHarness();
    const raw = 'agent-raw-token';
    messaging.store.putAgent(
      stubAgent({ tokenHash: tokenHash(raw), status: 'approved' })
    );

    const result = resolvePrincipal(ctx, raw);
    expect(result).toEqual({
      ok: true,
      principal: {
        address: 'agent:codex/reviewer',
        canDecide: false,
        kind: 'agent',
      },
    });
  });

  it('a pending agent is refused as awaiting approval (403)', () => {
    const { ctx, messaging } = makeHarness();
    const raw = 'agent-pending-token';
    messaging.store.putAgent(
      stubAgent({
        address: 'agent:codex/pending',
        tokenHash: tokenHash(raw),
        status: 'pending',
        approvedBy: null,
      })
    );

    const result = resolvePrincipal(ctx, raw);
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'awaiting approval in Dispatch',
      code: 'auth_agent_pending',
    });
  });

  it('a revoked agent is refused as access revoked (401)', () => {
    const { ctx, messaging } = makeHarness();
    const raw = 'agent-revoked-token';
    messaging.store.putAgent(
      stubAgent({
        address: 'agent:codex/revoked',
        tokenHash: tokenHash(raw),
        status: 'revoked',
        approvedBy: null,
      })
    );

    const result = resolvePrincipal(ctx, raw);
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "this agent's access was revoked",
      code: 'auth_agent_revoked',
    });
  });
});

// The exact self-authenticated route table (api.ts's SELF_AUTHENTICATED_ROUTES),
// each with a concrete dummy id/name/addr filled in — shared between the pure
// isSelfAuthenticated table test below and the fail-closed HTTP test further
// down, so the two can never silently drift apart. `GET /api/mailbox` (not
// `/api/inbox` — see the collision this replaced) and the delivery/channel
// routes' ids are meaningless placeholders; nothing resolves them.
const selfAuthenticated: Array<[string, string]> = [
  ['POST', 'messages'],
  ['GET', 'messages/m-1'],
  ['POST', 'messages/m-1/reply'],
  ['GET', 'messages/m-1/answer'],
  ['GET', 'threads'],
  ['GET', 'threads/m-1'],
  ['GET', 'mailbox'],
  ['POST', 'deliveries/d-1/read'],
  ['GET', 'channels'],
  ['POST', 'channels/general/members'],
  ['DELETE', 'channels/general/members/human%3Awyat'],
  ['GET', 'decisions/open'],
];

describe('isSelfAuthenticated', () => {
  for (const [method, path] of selfAuthenticated) {
    it(`${method} /api/${path} is self-authenticated`, () => {
      expect(isSelfAuthenticated(path.split('/'), method)).toBe(true);
    });
  }

  const notSelfAuthenticated: Array<[string, string]> = [
    ['POST', 'agents/register'],
    ['GET', 'agents'],
    ['GET', 'agents/roster'],
    ['POST', 'agents/agent%3Acodex%2Freviewer/approve'],
    ['POST', 'agents/agent%3Acodex%2Freviewer/revoke'],
    ['POST', 'agents/agent%3Acodex%2Freviewer/mute'],
    ['POST', 'agents/agent%3Acodex%2Freviewer/unmute'],
    // The capture inbox — a pre-existing, unrelated route this table must
    // never collide with again (see the fail-closed HTTP test below for the
    // regression: it must 401 with no token, not serve 200).
    ['GET', 'inbox'],
    // Wrong method for an otherwise self-authenticated path.
    ['DELETE', 'messages/m-1'],
    // A bare GET /api/messages (no id) is not in the table.
    ['GET', 'messages'],
  ];

  for (const [method, path] of notSelfAuthenticated) {
    it(`${method} /api/${path} is not self-authenticated`, () => {
      expect(isSelfAuthenticated(path.split('/'), method)).toBe(false);
    });
  }
});

// A run that starts and never finishes — enough for the tier gate below,
// which never dispatches through it.
const controllable: Executor = {
  start() {
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
      notify: () => {},
    } satisfies ExecutorRun;
  },
};

function authHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return headers;
}

// A real in-process daemon for the two HTTP-level describes below — neither
// touches messaging state, so one shared setup covers both.
function startTestServer(): Promise<ServerHandle> {
  return startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', controllable);
    },
  });
}

// Every self-authenticated route must 401 with no token: handleApi's
// fail-closed resolvePrincipal call runs before dispatch, so a handler can
// never see an unauthenticated request regardless of what it does itself.
describe('handleApi fails closed for self-authenticated routes', () => {
  let handle: ServerHandle;
  let baseUrl: string;

  beforeEach(async () => {
    TaskStore.init(root);
    handle = await startTestServer();
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
  });

  for (const [method, path] of selfAuthenticated) {
    it(`${method} /api/${path} with no token is 401, never a 2xx or 404`, async () => {
      const res = await rawFetch(`${baseUrl}/api/${path}`, { method });
      expect(res.status).toBe(401);
    });

    it(`${method} /api/${path} with a garbage token is 401, never a 2xx`, async () => {
      const res = await rawFetch(`${baseUrl}/api/${path}`, {
        method,
        headers: authHeaders('not-a-real-token'),
      });
      expect(res.status).toBe(401);
    });
  }

  // The specific collision this fix round found: the capture inbox
  // (GET /api/inbox, a pre-existing and unrelated route — ctx.inboxStore.list())
  // must still require its normal request-tier token now that `inbox` is off
  // the self-authenticated table.
  it('GET /api/inbox with no token is 401 (the capture inbox, unaffected by messaging)', async () => {
    const res = await rawFetch(`${baseUrl}/api/inbox`);
    expect(res.status).toBe(401);
  });
});

// HTTP-level regression coverage for the ELEVATED_ROUTES entries this task
// added: an agent's approve/revoke/mute/unmute needs the `decide` tier, same
// as the other adjudications in that table — the tier gate runs in handleApi
// before routing, independently of whatever the handler itself does.
describe('ELEVATED_ROUTES: agent decide-tier routes', () => {
  let handle: ServerHandle;
  let baseUrl: string;
  let agentToken: string;
  let appToken: string;

  beforeEach(async () => {
    TaskStore.init(root);
    handle = await startTestServer();
    baseUrl = `http://127.0.0.1:${handle.port}`;
    agentToken = handle.tokens.agentToken;
    appToken = handle.tokens.appToken;
  });

  afterEach(async () => {
    await handle.stop();
  });

  const routes: Array<[string, string]> = [
    ['POST', 'agents/agent%3Acodex%2Freviewer/approve'],
    ['POST', 'agents/agent%3Acodex%2Freviewer/revoke'],
    ['POST', 'agents/agent%3Acodex%2Freviewer/mute'],
    ['POST', 'agents/agent%3Acodex%2Freviewer/unmute'],
  ];

  for (const [method, path] of routes) {
    it(`${method} /api/${path} refuses the shared agent token (403, needs decide)`, async () => {
      const res = await rawFetch(`${baseUrl}/api/${path}`, {
        method,
        headers: authHeaders(agentToken),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('auth_insufficient_tier');
    });

    it(`${method} /api/${path} clears the tier gate with the app token (404: no agent registered at that address)`, async () => {
      const res = await rawFetch(`${baseUrl}/api/${path}`, {
        method,
        headers: authHeaders(appToken),
      });
      expect(res.status).toBe(404);
    });
  }
});
