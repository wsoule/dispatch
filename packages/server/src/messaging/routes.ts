import type { TaskDoc } from '@dispatch/core';
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
import { DELIVERY_STATES, gateOf, SYSTEM_ADDRESS } from '@dispatch/protocol';
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
import { implicitEpicMembers } from './host.js';
import type { Principal } from './principal.js';
import type { Messaging } from './service.js';

// Every handler that calls this is reached only via a self-authenticated
// route (api.ts resolves ctx.principal before dispatch) — this just narrows
// the type instead of scattering `!` assertions.
function requirePrincipal(ctx: ApiContext): Principal {
  if (ctx.principal === undefined) {
    throw new Error('messaging route reached with no resolved principal');
  }
  return ctx.principal;
}

function invalidField(field: string, message: string): Response {
  return jsonResponse({ error: message, field }, 400);
}

// The task address a run principal is currently working, or null for any
// other principal kind (or a run whose task no longer resolves).
function taskAddressOfRun(
  ctx: ApiContext,
  principal: Principal
): string | null {
  if (principal.kind !== 'run') return null;
  const taskId = ctx.orchestrator.taskIdOfRun(
    principal.address.slice('run:'.length)
  );
  return taskId === null ? null : `task:${taskId}`;
}

// Whether `principal` may act as `address`: itself, its own task (a run
// stands in for the task it's working, which outlives the run), or any
// address at all for a deciding human. The single object-level authorization
// rule every messaging route enforces before touching someone else's mail,
// deliveries or channel membership.
function canActAs(
  ctx: ApiContext,
  principal: Principal,
  address: string
): boolean {
  if (address === principal.address) return true;
  if (principal.kind === 'human' && principal.canDecide) return true;
  return address === taskAddressOfRun(ctx, principal);
}

// Whether `principal` may read `message`: it (or its task) sent it, or it (or
// its task) is a recipient of one of its deliveries — or it's a deciding
// human, which canActAs already grants for any address.
function isParticipant(
  ctx: ApiContext,
  principal: Principal,
  message: Message
): boolean {
  if (canActAs(ctx, principal, message.from)) return true;
  return ctx.messaging.store
    .deliveries({ messageId: message.id })
    .some((d) => canActAs(ctx, principal, d.recipient));
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

// Shared optional-field shape guards between parseSendInput and
// parseReplyInput, so the two don't repeat the same rule twice each. Type
// predicates (not just a boolean) so the `if (!isValid…(x))` at each call
// site still narrows `x` for the assignment that follows it.
function isValidOptionalRefs(value: unknown): value is Ref[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every(isRefShape))
  );
}

function isValidOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
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

// Narrows an unknown JSON body into a well-typed SendInput (shape only —
// deep validation happens in @dispatch/protocol's validateSendInput).
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
  if (!isValidOptionalRefs(body.refs)) {
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
  if (!isValidOptionalString(body.choice)) {
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
  if (!isValidOptionalString(body.session)) {
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
  if (!isValidOptionalString(body.choice)) {
    return {
      ok: false,
      response: invalidField('choice', 'invalid choice: expected a string'),
    };
  }
  if (!isValidOptionalRefs(body.refs)) {
    return {
      ok: false,
      response: invalidField(
        'refs',
        'invalid refs: expected a list of {type, id, at?}'
      ),
    };
  }
  if (!isValidOptionalString(body.session)) {
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

// In-flight/completed sends keyed by idempotency key, per Messaging instance
// (a WeakMap, not a module-level Map, so two daemons booted in the same
// process — as tests do — never share cached sends). Caching the PROMISE
// itself, not just its resolved value, is what makes a concurrent retry with
// the same key await the first send instead of racing a second one: the
// cache is populated synchronously, before either send is awaited.
const idempotencyCaches = new WeakMap<
  Messaging,
  Map<string, Promise<SendResult>>
>();
const MAX_IDEMPOTENCY_KEYS = 500;

function idempotencyCacheFor(
  messaging: Messaging
): Map<string, Promise<SendResult>> {
  let cache = idempotencyCaches.get(messaging);
  if (cache === undefined) {
    cache = new Map();
    idempotencyCaches.set(messaging, cache);
  }
  return cache;
}

// Records a send's promise under its idempotency key, evicting the oldest
// entry once the cache would exceed its bound — Map preserves insertion
// order, so the first key is always the oldest.
function rememberIdempotent(
  cache: Map<string, Promise<SendResult>>,
  key: string,
  promise: Promise<SendResult>
): void {
  cache.set(key, promise);
  if (cache.size > MAX_IDEMPOTENCY_KEYS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// POST /api/messages — sends on behalf of whoever resolvePrincipal named.
// `Idempotency-Key` lets a client retry a send that timed out in flight
// without risking a duplicate message: a repeat with the same key (from the
// same principal), even a concurrent one, awaits the first attempt's promise
// and replays its result with 200, not 201.
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
  if (idemKey === null) {
    const result = await ctx.messaging.engine.send(parsedInput.value, {
      address: principal.address,
      canDecide: principal.canDecide,
    });
    return jsonResponse(result, 201);
  }

  const cache = idempotencyCacheFor(ctx.messaging);
  const cacheKey = `${principal.address}:${idemKey}`;
  const existing = cache.get(cacheKey);
  if (existing !== undefined) return jsonResponse(await existing, 200);

  // No `await` between the cache miss above and this set: nothing yields the
  // event loop in between, so a concurrent request can never also miss.
  const sendPromise = ctx.messaging.engine.send(parsedInput.value, {
    address: principal.address,
    canDecide: principal.canDecide,
  });
  rememberIdempotent(cache, cacheKey, sendPromise);
  return jsonResponse(await sendPromise, 201);
}

// GET /api/messages/:id
export function getMessageById(ctx: ApiContext, id: string): Response {
  const principal = requirePrincipal(ctx);
  const message = ctx.messaging.engine.getMessage(id);
  if (message === null) return errorResponse(404, `no message ${id}`);
  if (!isParticipant(ctx, principal, message)) {
    return errorResponse(403, `cannot read message ${id}`);
  }
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

// How long GET /api/messages/:id/answer?wait=1 parks before giving up.
// Mutable (not a plain constant) so a test can shrink it instead of taking
// the real 30s, and restore it afterward.
export const answerLongPoll = { waitMs: 30_000 };

// GET /api/messages/:id/answer — `?wait=1` long-polls up to answerLongPoll
// .waitMs for `id`'s answer; without it, checks once and returns right away.
// Only a participant of the question (or a deciding human) may read its
// answer. Resolves immediately if one already landed; otherwise parks on the
// engine's event stream and wakes on the matching answer, the timeout, or
// the client disconnecting (req.signal), whichever comes first.
export function waitForAnswer(
  req: Request,
  ctx: ApiContext,
  id: string,
  url: URL
): Promise<Response> {
  const principal = requirePrincipal(ctx);
  const question = ctx.messaging.engine.getMessage(id);
  if (question === null) {
    return Promise.resolve(errorResponse(404, `no message ${id}`));
  }
  if (question.kind !== 'question' && question.kind !== 'handoff') {
    return Promise.resolve(
      errorResponse(
        400,
        `${id} is a ${question.kind}, not a question or handoff`
      )
    );
  }
  if (!isParticipant(ctx, principal, question)) {
    return Promise.resolve(
      errorResponse(403, `cannot read the answer to ${id}`)
    );
  }

  const existing = ctx.messaging.engine.answerOf(id);
  if (existing !== null)
    return Promise.resolve(jsonResponse({ answer: existing }));
  if (url.searchParams.get('wait') !== '1' || req.signal.aborted) {
    return Promise.resolve(jsonResponse({ answer: null }));
  }

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
    const timer = setTimeout(() => finish(null), answerLongPoll.waitMs);
    const onAbort = (): void => finish(null);
    req.signal.addEventListener('abort', onAbort);
  });
}

// GET /api/threads/:id — allowed for a participant of any message in the
// thread, or a deciding human (who can read any thread, including an empty
// or unknown one, where there is no message to check participation against).
export function getThreadById(ctx: ApiContext, threadId: string): Response {
  const principal = requirePrincipal(ctx);
  const thread = ctx.messaging.engine.thread(threadId);
  const decidingHuman = principal.kind === 'human' && principal.canDecide;
  if (
    !decidingHuman &&
    !thread.messages.some((m) => isParticipant(ctx, principal, m))
  ) {
    return errorResponse(403, `cannot read thread ${threadId}`);
  }
  return jsonResponse(thread);
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

// "My own mailbox" (no `?address=`): itself, plus its task for a run — most
// mail targets the task, but a direct answer can still address the run.
function ownMailboxAddresses(ctx: ApiContext, principal: Principal): string[] {
  const taskAddress = taskAddressOfRun(ctx, principal);
  return taskAddress === null
    ? [principal.address]
    : [principal.address, taskAddress];
}

// GET /api/mailbox?address=&state=a,b — `address` defaults to the caller's
// own (both addresses of it, for a run); reading anyone else's needs
// canActAs's say-so. Results are sorted by delivery id (time order) even
// when two addresses' inboxes are merged.
export function getMailbox(ctx: ApiContext, url: URL): Response {
  const principal = requirePrincipal(ctx);
  const explicitAddress = url.searchParams.get('address');
  if (explicitAddress !== null && !canActAs(ctx, principal, explicitAddress)) {
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
  items.sort((a, b) => a.delivery.id.localeCompare(b.delivery.id));
  return jsonResponse({ items });
}

// POST /api/deliveries/:id/read — only the delivery's own recipient (or its
// task's run, or a deciding human) may mark it read.
export function markDeliveryRead(ctx: ApiContext, id: string): Response {
  const principal = requirePrincipal(ctx);
  const delivery = ctx.messaging.store.getDelivery(id);
  if (delivery === null) return errorResponse(404, `no delivery ${id}`);
  if (!canActAs(ctx, principal, delivery.recipient)) {
    return errorResponse(403, `cannot mark ${id} read`);
  }
  return jsonResponse(ctx.messaging.engine.markRead(id));
}

interface ChannelSummary {
  name: string;
  auto: boolean;
  members: string[];
}

// GET /api/channels — every channel anyone has joined, plus one implicit
// `epic/<id>` channel per epic task (members: explicit ∪ implicit), so an
// epic's channel is listed even if nobody has ever posted to it. Tasks are
// listed once, grouped by parent in memory, rather than one store query per
// epic.
export function listChannels(ctx: ApiContext): Response {
  const explicitChannels = ctx.messaging.store.channels();
  const explicitByName = new Map(explicitChannels.map((c) => [c.name, c]));

  const childrenByParent = new Map<string, TaskDoc[]>();
  const epicIds: string[] = [];
  for (const task of ctx.store.list()) {
    if (task.meta.kind === 'epic') epicIds.push(task.meta.id);
    if (task.meta.parent !== null) {
      const siblings = childrenByParent.get(task.meta.parent);
      if (siblings === undefined)
        childrenByParent.set(task.meta.parent, [task]);
      else siblings.push(task);
    }
  }
  const childrenOf = (epicId: string): TaskDoc[] =>
    childrenByParent.get(epicId) ?? [];

  const names = new Set(explicitByName.keys());
  for (const id of epicIds) names.add(`epic/${id}`);

  const channels: ChannelSummary[] = [...names].sort().map((name) => {
    const record = explicitByName.get(name);
    const members = new Set([
      ...ctx.messaging.store.members(name),
      ...implicitEpicMembers(childrenOf, name),
    ]);
    return { name, auto: record?.auto ?? true, members: [...members] };
  });
  return jsonResponse({ channels });
}

// The address `principal` acts as by default (no explicit `member`/`addr`):
// itself, or for a run, its task.
function selfActingAddress(ctx: ApiContext, principal: Principal): string {
  return taskAddressOfRun(ctx, principal) ?? principal.address;
}

// POST /api/channels/:name/members — `member` defaults to the caller (a run
// defaults to its task); adding anyone else needs canActAs's say-so, same as
// removing them.
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
  const member =
    typeof body.member === 'string'
      ? body.member
      : selfActingAddress(ctx, principal);
  if (!canActAs(ctx, principal, member)) {
    return errorResponse(403, `cannot add ${member} to a channel`);
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
  const principal = requirePrincipal(ctx);
  if (!canActAs(ctx, principal, addr)) {
    return errorResponse(403, `cannot remove ${addr} from a channel`);
  }
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
const MAX_REGISTRATION_FIELD_LENGTH = 100;

// Normalizes a client-supplied display name into the handle grammar
// addresses use: lowercase, invalid characters become '-', leading
// non-alphanumerics are trimmed (a handle must start with [a-z0-9]), capped
// at 40 characters.
function normalizeAgentName(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return lowered.replace(/^[^a-z0-9]+/, '').slice(0, 40);
}

// POST /api/agents/register — request tier (the shared agentToken). Mints a
// token for a new or previously-revoked address and raises the
// agent-registration gate; pending/approved 409s, since the MCP keeps its
// token file and a lost token needs a human revoke.
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
  if (body.name.length > MAX_REGISTRATION_FIELD_LENGTH) {
    return errorResponse(
      400,
      `invalid name: longer than ${MAX_REGISTRATION_FIELD_LENGTH} characters`
    );
  }
  if (typeof body.client !== 'string' || body.client.trim() === '') {
    return errorResponse(400, 'invalid client: client is required');
  }
  if (body.client.length > MAX_REGISTRATION_FIELD_LENGTH) {
    return errorResponse(
      400,
      `invalid client: longer than ${MAX_REGISTRATION_FIELD_LENGTH} characters`
    );
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

  try {
    await ctx.messaging.engine.send(
      {
        to: [ctx.actorContext.humanRef],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'deny'],
        body: `New agent ${address} (${body.client}) wants to join this project.`,
        data: {
          type: 'agent-registration',
          agent: address,
          client: body.client,
        },
      },
      { address: SYSTEM_ADDRESS, canDecide: true }
    );
  } catch (err) {
    // The agent row exists but nobody can approve it without the gate —
    // revoke it so a fresh register call can recreate it, instead of the
    // pending/approved 409 above blocking every retry forever.
    ctx.messaging.store.putAgent({ ...record, status: 'revoked' });
    return errorResponse(
      500,
      `registration gate failed to send: ${(err as Error).message}`
    );
  }

  return jsonResponse({ address, token, status: record.status }, 201);
}

// The open (unanswered) agent-registration gate for `address`, if any.
function openRegistrationGateFor(
  ctx: ApiContext,
  address: string
): Message | null {
  for (const question of ctx.messaging.engine.openBlocking()) {
    const gate = gateOf(question);
    if (
      gate !== null &&
      gate.type === 'agent-registration' &&
      gate.agent === address
    ) {
      return question;
    }
  }
  return null;
}

// Shared body for approve/revoke: when the agent's registration gate is
// still open, answer it through the engine so the gate handler (service.ts)
// is the single writer of status/approvedBy; only once no gate is open (the
// agent was created some other way, or its gate already resolved) does this
// write the agent row directly.
async function decideAgent(
  ctx: ApiContext,
  address: string,
  choice: 'approve' | 'deny',
  directStatus: 'approved' | 'revoked'
): Promise<Response> {
  const agent = ctx.messaging.store.getAgent(address);
  if (agent === null) return errorResponse(404, `no agent ${address}`);
  const gate = openRegistrationGateFor(ctx, address);
  if (gate !== null) {
    await ctx.messaging.engine.reply(
      gate.id,
      { body: '', choice },
      { address: humanActor(ctx), canDecide: true }
    );
  } else {
    ctx.messaging.store.putAgent({
      ...agent,
      status: directStatus,
      approvedBy: directStatus === 'approved' ? humanActor(ctx) : null,
    });
  }
  const updated = ctx.messaging.store.getAgent(address) ?? agent;
  return jsonResponse(stripTokenHash(updated));
}

// POST /api/agents/:addr/approve
export function approveAgent(
  ctx: ApiContext,
  address: string
): Promise<Response> {
  return decideAgent(ctx, address, 'approve', 'approved');
}

// POST /api/agents/:addr/revoke
export function revokeAgent(
  ctx: ApiContext,
  address: string
): Promise<Response> {
  return decideAgent(ctx, address, 'deny', 'revoked');
}

// Shared body for mute/unmute: these never touch a gate (there is no
// mute/unmute question), so they always write the agent row directly.
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
// Deciding humans only: the list itself (who's waiting on what) is exactly
// what a non-deciding principal must not see.
export function listOpenDecisions(ctx: ApiContext): Response {
  const principal = requirePrincipal(ctx);
  if (principal.kind !== 'human' || !principal.canDecide) {
    return errorResponse(403, 'listing open decisions needs a deciding human');
  }
  const items = ctx.messaging.engine
    .openBlocking()
    .filter((m) => m.to.some((addr) => addr.startsWith('human:')));
  return jsonResponse({ items });
}
