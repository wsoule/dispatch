import type {
  AgentRecord,
  DeliveryState,
  JsonValue,
  Message,
  MessageKind,
  Ref,
  SendInput,
  SendResult,
} from '@dispatch/protocol';
import { DELIVERY_STATES, SYSTEM_ADDRESS } from '@dispatch/protocol';
import { createHash, randomBytes } from 'node:crypto';

import type { ApiContext } from '../api.js';
import { humanActor } from '../api/caller.js';
import {
  errorResponse,
  jsonResponse,
  parseCountParam,
  readJsonBody,
  readJsonBodyOptional,
} from '../api/http.js';
import type { Principal } from './principal.js';
import type { Messaging } from './service.js';

// Every handler below is reached only through a route this file's caller
// (api.ts) has already classified as self-authenticated or elevated, so
// ctx.principal (self-authenticated) is always set by the time it's read.
// This just narrows the type instead of scattering `!` assertions.
function requirePrincipal(ctx: ApiContext): Principal {
  if (ctx.principal === undefined) {
    throw new Error('messaging route reached with no resolved principal');
  }
  return ctx.principal;
}

function invalidField(field: string, message: string): Response {
  return jsonResponse({ error: message, field }, 400);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isRefShape(value: unknown): value is Ref {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as { type?: unknown; id?: unknown; at?: unknown };
  return (
    typeof r.type === 'string' &&
    typeof r.id === 'string' &&
    (r.at === undefined || typeof r.at === 'string')
  );
}

interface RawSendBody {
  to?: unknown;
  kind?: unknown;
  body?: unknown;
  refs?: unknown;
  data?: unknown;
  urgent?: unknown;
  blocking?: unknown;
  choices?: unknown;
  choice?: unknown;
  replyTo?: unknown;
  wake?: unknown;
  session?: unknown;
}

// Narrows an unknown JSON body into a well-typed SendInput. This only checks
// shape (so the object is safe to hand to DeliveryEngine.send) — the deep
// business rules (address grammar, gate ownership, choice membership, …)
// live in @dispatch/protocol's validateSendInput and surface as a
// MessagingError, mapped centrally in api.ts's outer catch.
function parseSendInput(
  raw: unknown
): { ok: true; value: SendInput } | { ok: false; response: Response } {
  const body = raw as RawSendBody;
  if (!isStringArray(body.to)) {
    return {
      ok: false,
      response: invalidField('to', 'invalid to: expected a list of addresses'),
    };
  }
  if (typeof body.kind !== 'string') {
    return {
      ok: false,
      response: invalidField('kind', 'invalid kind: expected a string'),
    };
  }
  if (typeof body.body !== 'string') {
    return {
      ok: false,
      response: invalidField('body', 'invalid body: expected a string'),
    };
  }
  if (
    body.refs !== undefined &&
    (!Array.isArray(body.refs) || !body.refs.every(isRefShape))
  ) {
    return {
      ok: false,
      response: invalidField(
        'refs',
        'invalid refs: expected a list of {type, id, at?}'
      ),
    };
  }
  if (body.urgent !== undefined && typeof body.urgent !== 'boolean') {
    return {
      ok: false,
      response: invalidField('urgent', 'invalid urgent: expected a boolean'),
    };
  }
  if (body.blocking !== undefined && typeof body.blocking !== 'boolean') {
    return {
      ok: false,
      response: invalidField(
        'blocking',
        'invalid blocking: expected a boolean'
      ),
    };
  }
  if (body.choices !== undefined && !isStringArray(body.choices)) {
    return {
      ok: false,
      response: invalidField(
        'choices',
        'invalid choices: expected a list of strings'
      ),
    };
  }
  if (body.choice !== undefined && typeof body.choice !== 'string') {
    return {
      ok: false,
      response: invalidField('choice', 'invalid choice: expected a string'),
    };
  }
  if (
    body.replyTo !== undefined &&
    body.replyTo !== null &&
    typeof body.replyTo !== 'string'
  ) {
    return {
      ok: false,
      response: invalidField(
        'replyTo',
        'invalid replyTo: expected a string or null'
      ),
    };
  }
  if (
    body.wake !== undefined &&
    body.wake !== 'none' &&
    body.wake !== 'request'
  ) {
    return {
      ok: false,
      response: invalidField(
        'wake',
        "invalid wake: expected 'none' or 'request'"
      ),
    };
  }
  if (body.session !== undefined && typeof body.session !== 'string') {
    return {
      ok: false,
      response: invalidField('session', 'invalid session: expected a string'),
    };
  }

  const value: SendInput = {
    to: body.to,
    kind: body.kind as MessageKind,
    body: body.body,
  };
  if (body.refs !== undefined) value.refs = body.refs;
  if (body.data !== undefined) value.data = body.data as JsonValue;
  if (body.urgent !== undefined) value.urgent = body.urgent;
  if (body.blocking !== undefined) value.blocking = body.blocking;
  if (body.choices !== undefined) value.choices = body.choices;
  if (body.choice !== undefined) value.choice = body.choice;
  if (body.replyTo !== undefined) value.replyTo = body.replyTo;
  if (body.wake !== undefined) value.wake = body.wake;
  if (body.session !== undefined) value.session = body.session;
  return { ok: true, value };
}

interface RawReplyBody {
  body?: unknown;
  choice?: unknown;
  refs?: unknown;
  data?: unknown;
  session?: unknown;
}

// Same shape-only narrowing as parseSendInput, for the smaller reply body —
// DeliveryEngine.reply fills in `to`/`kind`/`replyTo` from the target message.
function parseReplyInput(raw: unknown):
  | {
      ok: true;
      value: {
        body: string;
        choice?: string;
        refs?: Ref[];
        data?: JsonValue;
        session?: string;
      };
    }
  | { ok: false; response: Response } {
  const body = raw as RawReplyBody;
  if (typeof body.body !== 'string') {
    return {
      ok: false,
      response: invalidField('body', 'invalid body: expected a string'),
    };
  }
  if (body.choice !== undefined && typeof body.choice !== 'string') {
    return {
      ok: false,
      response: invalidField('choice', 'invalid choice: expected a string'),
    };
  }
  if (
    body.refs !== undefined &&
    (!Array.isArray(body.refs) || !body.refs.every(isRefShape))
  ) {
    return {
      ok: false,
      response: invalidField(
        'refs',
        'invalid refs: expected a list of {type, id, at?}'
      ),
    };
  }
  if (body.session !== undefined && typeof body.session !== 'string') {
    return {
      ok: false,
      response: invalidField('session', 'invalid session: expected a string'),
    };
  }
  const value: {
    body: string;
    choice?: string;
    refs?: Ref[];
    data?: JsonValue;
    session?: string;
  } = { body: body.body };
  if (body.choice !== undefined) value.choice = body.choice;
  if (body.refs !== undefined) value.refs = body.refs;
  if (body.data !== undefined) value.data = body.data as JsonValue;
  if (body.session !== undefined) value.session = body.session;
  return { ok: true, value };
}

// Bounded per-daemon idempotency cache for POST /api/messages, keyed off the
// Messaging instance rather than a module-level map so two daemons booted in
// the same process (as tests do, one per test) never share cached sends.
const idempotencyCaches = new WeakMap<Messaging, Map<string, SendResult>>();
const MAX_IDEMPOTENCY_KEYS = 500;

function idempotencyCacheFor(messaging: Messaging): Map<string, SendResult> {
  let cache = idempotencyCaches.get(messaging);
  if (cache === undefined) {
    cache = new Map();
    idempotencyCaches.set(messaging, cache);
  }
  return cache;
}

// Records a send result under its idempotency key, evicting the oldest entry
// once the cache would exceed its bound — Map preserves insertion order, so
// the first key is always the oldest.
function rememberIdempotent(
  cache: Map<string, SendResult>,
  key: string,
  result: SendResult
): void {
  cache.set(key, result);
  if (cache.size > MAX_IDEMPOTENCY_KEYS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// POST /api/messages — sends on behalf of whoever resolvePrincipal named.
// `Idempotency-Key` lets a client retry a send that timed out in flight
// without risking a duplicate message: a repeat with the same key (from the
// same principal) replays the first attempt's result with 200, not 201.
export async function sendMessage(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const principal = requirePrincipal(ctx);
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsedInput = parseSendInput(parsedBody.value);
  if (!parsedInput.ok) return parsedInput.response;

  const idemKey = req.headers.get('idempotency-key');
  const cache = idempotencyCacheFor(ctx.messaging);
  const cacheKey = idemKey === null ? null : `${principal.address}:${idemKey}`;
  if (cacheKey !== null) {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return jsonResponse(cached, 200);
  }

  const result = await ctx.messaging.engine.send(parsedInput.value, {
    address: principal.address,
    canDecide: principal.canDecide,
  });
  if (cacheKey !== null) rememberIdempotent(cache, cacheKey, result);
  return jsonResponse(result, 201);
}

// GET /api/messages/:id
export function getMessageById(ctx: ApiContext, id: string): Response {
  const message = ctx.messaging.engine.getMessage(id);
  if (message === null) return errorResponse(404, `no message ${id}`);
  return jsonResponse(message);
}

// POST /api/messages/:id/reply — an answer if the target is a question or
// handoff, a plain message otherwise; DeliveryEngine.reply decides which.
export async function replyToMessage(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const principal = requirePrincipal(ctx);
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsedInput = parseReplyInput(parsedBody.value);
  if (!parsedInput.ok) return parsedInput.response;
  const result = await ctx.messaging.engine.reply(id, parsedInput.value, {
    address: principal.address,
    canDecide: principal.canDecide,
  });
  return jsonResponse(result, 201);
}

const ANSWER_WAIT_MS = 30_000;

// GET /api/messages/:id/answer — long-polls up to 30s for `id`'s answer.
// Resolves immediately if one already landed; otherwise parks on the engine's
// event stream and wakes on the matching answer, the timeout, or the client
// disconnecting (req.signal), whichever comes first.
export function waitForAnswer(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  if (ctx.messaging.engine.getMessage(id) === null) {
    return Promise.resolve(errorResponse(404, `no message ${id}`));
  }
  const existing = ctx.messaging.engine.answerOf(id);
  if (existing !== null)
    return Promise.resolve(jsonResponse({ answer: existing }));

  return new Promise<Response>((resolve) => {
    let settled = false;
    const finish = (answer: Message | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      req.signal.removeEventListener('abort', onAbort);
      resolve(jsonResponse({ answer }));
    };
    const unsubscribe = ctx.messaging.engine.subscribe((e) => {
      if (
        e.type === 'message' &&
        e.message.replyTo === id &&
        e.message.kind === 'answer'
      ) {
        finish(e.message);
      }
    });
    const timer = setTimeout(() => finish(null), ANSWER_WAIT_MS);
    const onAbort = (): void => finish(null);
    req.signal.addEventListener('abort', onAbort);
  });
}

// GET /api/threads/:id
export function getThreadById(ctx: ApiContext, threadId: string): Response {
  return jsonResponse(ctx.messaging.engine.thread(threadId));
}

const DEFAULT_RECENT_THREADS = 50;
const MAX_RECENT_THREADS = 200;

// GET /api/threads?limit=N — the most recently active threads, for the
// desktop Threads view's channel/direct coverage beyond a single mailbox.
// Restricted to deciding humans: it surfaces every thread project-wide,
// including ones the caller was never addressed in.
export function listRecentThreads(ctx: ApiContext, url: URL): Response {
  const principal = requirePrincipal(ctx);
  if (principal.kind !== 'human' || !principal.canDecide) {
    return errorResponse(403, 'listing recent threads needs a deciding human');
  }
  const parsedLimit = parseCountParam(url, 'limit');
  if (!parsedLimit.ok) return parsedLimit.response;
  const limit = Math.min(
    parsedLimit.value ?? DEFAULT_RECENT_THREADS,
    MAX_RECENT_THREADS
  );
  return jsonResponse({ threads: ctx.messaging.store.recentThreads(limit) });
}

// Whether `principal` may read `address`'s mailbox: its own address (or, for
// a run, its task's address — a run's mail outlives the run itself), or any
// address at all for a deciding human.
function mailboxAddressAllowed(
  ctx: ApiContext,
  principal: Principal,
  address: string
): boolean {
  if (principal.kind === 'human' && principal.canDecide) return true;
  if (address === principal.address) return true;
  if (principal.kind === 'run') {
    const taskId = ctx.orchestrator.taskIdOfRun(
      principal.address.slice('run:'.length)
    );
    if (taskId !== null && address === `task:${taskId}`) return true;
  }
  return false;
}

// The address(es) "my own mailbox" (no `?address=`) actually means for
// `principal`. For a run this is itself AND its task: a question answer is
// addressed straight to `run:<id>`, but most mail addressed to the work
// targets the task, which outlives any one run — a run checking its own
// mail needs both to see the full picture.
function ownMailboxAddresses(ctx: ApiContext, principal: Principal): string[] {
  if (principal.kind !== 'run') return [principal.address];
  const taskId = ctx.orchestrator.taskIdOfRun(
    principal.address.slice('run:'.length)
  );
  return taskId === null
    ? [principal.address]
    : [principal.address, `task:${taskId}`];
}

// GET /api/mailbox?address=&state=a,b — `address` defaults to the caller's
// own (both addresses of it, for a run); reading anyone else's needs
// mailboxAddressAllowed's say-so.
export function getMailbox(ctx: ApiContext, url: URL): Response {
  const principal = requirePrincipal(ctx);
  const explicitAddress = url.searchParams.get('address');
  if (
    explicitAddress !== null &&
    !mailboxAddressAllowed(ctx, principal, explicitAddress)
  ) {
    return errorResponse(403, `cannot read the mailbox for ${explicitAddress}`);
  }
  const addresses =
    explicitAddress === null
      ? ownMailboxAddresses(ctx, principal)
      : [explicitAddress];

  const rawState = url.searchParams.get('state');
  let states: DeliveryState[] | undefined;
  if (rawState !== null) {
    const candidates = rawState
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (
      !candidates.every((s) =>
        (DELIVERY_STATES as readonly string[]).includes(s)
      )
    ) {
      return errorResponse(
        400,
        `invalid state: expected any of ${DELIVERY_STATES.join(',')}`
      );
    }
    states = candidates as DeliveryState[];
  }
  const items = addresses.flatMap((addr) =>
    ctx.messaging.engine.inbox(addr, states)
  );
  return jsonResponse({ items });
}

// POST /api/deliveries/:id/read
export function markDeliveryRead(ctx: ApiContext, id: string): Response {
  return jsonResponse(ctx.messaging.engine.markRead(id));
}

interface ChannelSummary {
  name: string;
  auto: boolean;
  members: string[];
}

// Mirrors DaemonMessagingHost.implicitMembers (host.ts): every task parented
// to an epic is an implicit member of that epic's channel. Duplicated rather
// than called through Messaging because the daemon host instance itself
// isn't part of the Messaging interface routes get — only the task store is.
function implicitEpicMembers(ctx: ApiContext, channel: string): string[] {
  const match = /^epic\/(.+)$/.exec(channel);
  if (match === null) return [];
  return ctx.store
    .list({ parent: match[1] })
    .map((task) => `task:${task.meta.id}`);
}

// GET /api/channels — every channel anyone has joined, plus one implicit
// `epic/<id>` channel per epic task (members: explicit ∪ implicit), so an
// epic's channel is listed even if nobody has ever posted to it.
export function listChannels(ctx: ApiContext): Response {
  const explicitChannels = ctx.messaging.store.channels();
  const names = new Set(explicitChannels.map((c) => c.name));
  for (const epic of ctx.store.list({ kind: 'epic' }))
    names.add(`epic/${epic.meta.id}`);

  const channels: ChannelSummary[] = [...names].sort().map((name) => {
    const record = explicitChannels.find((c) => c.name === name);
    const members = new Set([
      ...ctx.messaging.store.members(name),
      ...implicitEpicMembers(ctx, name),
    ]);
    return { name, auto: record?.auto ?? true, members: [...members] };
  });
  return jsonResponse({ channels });
}

// POST /api/channels/:name/members — `member` defaults to the caller, except
// a run defaults to its task (membership must outlive the run that joined).
export async function joinChannel(
  req: Request,
  ctx: ApiContext,
  name: string
): Promise<Response> {
  const principal = requirePrincipal(ctx);
  const parsedBody = await readJsonBodyOptional(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value as { member?: unknown };
  if (body.member !== undefined && typeof body.member !== 'string') {
    return invalidField('member', 'invalid member: expected a string address');
  }
  let member =
    typeof body.member === 'string' ? body.member : principal.address;
  if (body.member === undefined && principal.kind === 'run') {
    const taskId = ctx.orchestrator.taskIdOfRun(
      principal.address.slice('run:'.length)
    );
    if (taskId !== null) member = `task:${taskId}`;
  }
  ctx.messaging.engine.join(name, member);
  return new Response(null, { status: 204 });
}

// DELETE /api/channels/:name/members/:addr
export function leaveChannel(
  ctx: ApiContext,
  name: string,
  addr: string
): Response {
  ctx.messaging.engine.leave(name, addr);
  return new Response(null, { status: 204 });
}

type AgentSummary = Omit<AgentRecord, 'tokenHash'>;

// Never hand a token hash back over the wire — it authenticates the agent
// exactly like the raw token would if it leaked, so every agent-facing route
// strips it before responding.
function stripTokenHash(agent: AgentRecord): AgentSummary {
  return {
    address: agent.address,
    displayName: agent.displayName,
    client: agent.client,
    status: agent.status,
    muted: agent.muted,
    approvedBy: agent.approvedBy,
    createdAt: agent.createdAt,
  };
}

// GET /api/agents/roster — request tier, not self-authenticated: this is a
// membership listing, not an action that needs to know who's asking.
export function listAgentRoster(ctx: ApiContext): Response {
  return jsonResponse({
    agents: ctx.messaging.store.agents().map(stripTokenHash),
  });
}

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// Normalizes a client-supplied display name into the handle grammar
// addresses use: lowercase, invalid characters become '-', leading
// non-alphanumerics are trimmed (a handle must start with [a-z0-9]), capped
// at 40 characters.
function normalizeAgentName(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return lowered.replace(/^[^a-z0-9]+/, '').slice(0, 40);
}

// POST /api/agents/register — request tier, reached with the shared
// agentToken (an unregistered client has nothing else). Mints a fresh token
// for a new or previously-revoked address and raises the agent-registration
// gate to the project owner; an address still pending or approved 409s,
// since the MCP keeps its token file and a lost token needs a human revoke.
export async function registerAgent(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { name?: unknown; client?: unknown };
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return errorResponse(400, 'invalid name: name is required');
  }
  if (typeof body.client !== 'string' || body.client.trim() === '') {
    return errorResponse(400, 'invalid client: client is required');
  }
  const name = normalizeAgentName(body.name);
  if (!HANDLE_PATTERN.test(name)) {
    return errorResponse(
      400,
      `invalid name: ${body.name} has no valid characters once normalized`
    );
  }
  const address = `agent:${ctx.actorContext.member.handle}/${name}`;
  const existing = ctx.messaging.store.getAgent(address);
  if (
    existing !== null &&
    (existing.status === 'approved' || existing.status === 'pending')
  ) {
    return errorResponse(
      409,
      `${address} is already registered (${existing.status}) — ask a human to revoke it first`
    );
  }

  const token = randomBytes(32).toString('hex');
  const record: AgentRecord = {
    address,
    displayName: body.name,
    client: body.client,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    status: 'pending',
    muted: false,
    approvedBy: null,
    createdAt: new Date().toISOString(),
  };
  ctx.messaging.store.putAgent(record);

  await ctx.messaging.engine.send(
    {
      to: [ctx.actorContext.humanRef],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'deny'],
      body: `New agent ${address} (${body.client}) wants to join this project.`,
      data: { type: 'agent-registration', agent: address, client: body.client },
    },
    { address: SYSTEM_ADDRESS, canDecide: true }
  );

  return jsonResponse({ address, token, status: record.status }, 201);
}

// Shared body for the four decide-tier agent-roster actions below: look up
// the agent, apply the mutation, persist, and hand back the sanitized record.
function updateAgent(
  ctx: ApiContext,
  address: string,
  mutate: (agent: AgentRecord) => AgentRecord
): Response {
  const agent = ctx.messaging.store.getAgent(address);
  if (agent === null) return errorResponse(404, `no agent ${address}`);
  const updated = mutate(agent);
  ctx.messaging.store.putAgent(updated);
  return jsonResponse(stripTokenHash(updated));
}

// POST /api/agents/:addr/approve
export function approveAgent(ctx: ApiContext, address: string): Response {
  return updateAgent(ctx, address, (agent) => ({
    ...agent,
    status: 'approved',
    approvedBy: humanActor(ctx),
  }));
}

// POST /api/agents/:addr/revoke
export function revokeAgent(ctx: ApiContext, address: string): Response {
  return updateAgent(ctx, address, (agent) => ({
    ...agent,
    status: 'revoked',
    approvedBy: null,
  }));
}

// POST /api/agents/:addr/mute
export function muteAgent(ctx: ApiContext, address: string): Response {
  return updateAgent(ctx, address, (agent) => ({ ...agent, muted: true }));
}

// POST /api/agents/:addr/unmute
export function unmuteAgent(ctx: ApiContext, address: string): Response {
  return updateAgent(ctx, address, (agent) => ({ ...agent, muted: false }));
}

// GET /api/decisions/open — open blocking questions addressed to a human,
// for the notification surfaces that only care about what needs a person.
export function listOpenDecisions(ctx: ApiContext): Response {
  const items = ctx.messaging.engine
    .openBlocking()
    .filter((m) => m.to.some((addr) => addr.startsWith('human:')));
  return jsonResponse({ items });
}
