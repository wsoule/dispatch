import type { TaskDoc } from '@dispatch/core';
import type {
  AgentRecord,
  Delivery,
  DeliveryState,
  GateData,
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

// Narrows ctx.principal (api.ts resolves it before every self-authenticated
// route) instead of scattering `!` assertions.
function requirePrincipal(ctx: ApiContext): Principal {
  if (ctx.principal === undefined) {
    throw new Error('messaging route reached with no resolved principal');
  }
  return ctx.principal;
}

function invalidField(field: string, message: string): Response {
  return jsonResponse({ error: message, field }, 400);
}

// The task id a run principal is currently working, or null for any other
// principal kind (or a run whose task no longer resolves).
function taskIdOfRunPrincipal(
  ctx: ApiContext,
  principal: Principal
): string | null {
  if (principal.kind !== 'run') return null;
  return ctx.orchestrator.taskIdOfRun(principal.address.slice('run:'.length));
}

function taskAddressOfRun(
  ctx: ApiContext,
  principal: Principal
): string | null {
  const taskId = taskIdOfRunPrincipal(ctx, principal);
  return taskId === null ? null : `task:${taskId}`;
}

// The one object-level authorization rule every route enforces: self, a
// deciding human acting for anyone, or (for a run) its task or a sibling run.
function canActAs(
  ctx: ApiContext,
  principal: Principal,
  address: string
): boolean {
  if (address === principal.address) return true;
  if (principal.kind === 'human' && principal.canDecide) return true;
  const myTaskId = taskIdOfRunPrincipal(ctx, principal);
  if (myTaskId === null) return false;
  if (address === `task:${myTaskId}`) return true;
  return (
    address.startsWith('run:') &&
    ctx.orchestrator.taskIdOfRun(address.slice('run:'.length)) === myTaskId
  );
}

// Whether `principal` may read `message`: it or its task sent or received it
// (canActAs already lets a deciding human act for any address).
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

// Shared shape guards for parseSendInput/parseReplyInput — type predicates,
// not just booleans, so `if (!isValid…(x))` still narrows `x` afterward.
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

// Sends by idempotency key, per Messaging instance. The promise is cached so
// a concurrent retry awaits the first send instead of racing a second one.
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

// Caches a send's promise, evicting the oldest key (Map keeps insertion order)
// past the bound. A failed send drops its entry so a retry really retries.
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
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
}

// POST /api/messages as the resolved principal. The same principal repeating
// an `Idempotency-Key` gets the first attempt's result with 200, not 201.
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

// How long GET /api/messages/:id/answer?wait=1 parks before giving up;
// mutable so a test can shrink it.
export const answerLongPoll = { waitMs: 30_000 };

// GET /api/messages/:id/answer — participants may check once; `?wait=1`
// long-polls up to answerLongPoll.waitMs, and only for the asker or a deciding human.
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
  if (!isParticipant(ctx, principal, question)) {
    return Promise.resolve(
      errorResponse(403, `cannot read the answer to ${id}`)
    );
  }
  const wait = url.searchParams.get('wait') === '1';
  if (wait && !canActAs(ctx, principal, question.from)) {
    return Promise.resolve(
      errorResponse(403, `only the asker can wait for the answer to ${id}`)
    );
  }
  if (question.kind !== 'question' && question.kind !== 'handoff') {
    return Promise.resolve(
      errorResponse(
        400,
        `${id} is a ${question.kind}, not a question or handoff`
      )
    );
  }

  const existing = ctx.messaging.engine.answerOf(id);
  if (existing !== null)
    return Promise.resolve(jsonResponse({ answer: existing }));
  if (!wait || req.signal.aborted) {
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

// GET /api/threads/:id — for a participant of any message in the thread, or a
// deciding human, who can read any thread, even an empty or unknown one.
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

// GET /api/threads?limit=N — the most recently active threads project-wide,
// so only a deciding human may list them.
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

// A run's own mailbox: its address, its task, and deliveries bound to it by
// runId, since deliverHeld rebinds held mail without changing `recipient`.
function ownMailboxItems(
  ctx: ApiContext,
  principal: Principal,
  states: DeliveryState[] | undefined
): { delivery: Delivery; message: Message }[] {
  const addresses = [principal.address];
  const taskAddress = taskAddressOfRun(ctx, principal);
  if (taskAddress !== null) addresses.push(taskAddress);
  const items = addresses.flatMap((addr) =>
    ctx.messaging.engine.inbox(addr, states)
  );

  if (principal.kind === 'run') {
    const runId = principal.address.slice('run:'.length);
    const filter = states === undefined ? { runId } : { runId, states };
    for (const delivery of ctx.messaging.store.deliveries(filter)) {
      const message = ctx.messaging.store.getMessage(delivery.messageId);
      if (message !== null) items.push({ delivery, message });
    }
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.delivery.id)) return false;
    seen.add(item.delivery.id);
    return true;
  });
}

// GET /api/mailbox?address=&state=a,b — the caller's own by default; another
// address needs canActAs. Sorted by delivery id (time order).
export function getMailbox(ctx: ApiContext, url: URL): Response {
  const principal = requirePrincipal(ctx);
  const explicitAddress = url.searchParams.get('address');
  if (explicitAddress !== null && !canActAs(ctx, principal, explicitAddress)) {
    return errorResponse(403, `cannot read the mailbox for ${explicitAddress}`);
  }

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

  const items =
    explicitAddress === null
      ? ownMailboxItems(ctx, principal, states)
      : ctx.messaging.engine.inbox(explicitAddress, states);
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

// GET /api/channels — every joined channel plus each epic's implicit
// `epic/<id>` channel, built from one task listing grouped by parent.
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

// POST /api/channels/:name/members — `member` defaults to the caller (a run's
// task); adding anyone else needs canActAs, as removing them does.
export async function joinChannel(
  req: Request,
  ctx: ApiContext,
  name: string
): Promise<Response> {
  const principal = requirePrincipal(ctx);
  // A review or verify run acts only as itself, and channels never hold runs.
  if (principal.kind === 'run' && taskIdOfRunPrincipal(ctx, principal) === null)
    return errorResponse(
      403,
      `${principal.address} cannot join channels: they hold tasks and actors, and only an execute run acts as its task`
    );
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

// DELETE /api/channels/:name/members[/:addr] — no address means the caller's
// self-acting address; a non-member, or an epic's child in its channel, is a 404.
export function leaveChannel(
  ctx: ApiContext,
  name: string,
  addr: string | undefined
): Response {
  const principal = requirePrincipal(ctx);
  const member = addr ?? selfActingAddress(ctx, principal);
  if (!canActAs(ctx, principal, member)) {
    return errorResponse(403, `cannot remove ${member} from a channel`);
  }
  const removed = ctx.messaging.engine.leave(name, member);
  if (removed) return new Response(null, { status: 204 });
  const implicit = implicitEpicMembers(
    (epicId) => ctx.store.list({ parent: epicId }),
    name
  );
  if (implicit.includes(member)) {
    return errorResponse(
      404,
      `${member} cannot leave ${name}: an epic's children are members by parentage`
    );
  }
  return errorResponse(404, `${member} is not a member of ${name}`);
}

type AgentSummary = Omit<AgentRecord, 'tokenHash'>;

// Token hashes never leave the daemon: every agent-facing route strips them.
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

// A display name in the handle grammar: lowercased, invalid characters to '-',
// leading non-alphanumerics trimmed, at most 40 characters. MCP keeps a copy.
export function normalizeAgentName(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return lowered.replace(/^[^a-z0-9]+/, '').slice(0, 40);
}

// Control, format and line-break characters: stripped from a registration's
// name and client so neither can break or disguise the gate text a human reads.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// A required registration field with its unprintable characters removed, or
// the 400 explaining why it is missing or too long.
function registrationField(
  value: unknown,
  field: 'name' | 'client'
): { ok: true; value: string } | { ok: false; response: Response } {
  const required = `invalid ${field}: ${field} is required`;
  if (typeof value !== 'string') {
    return { ok: false, response: errorResponse(400, required) };
  }
  if (value.length > MAX_REGISTRATION_FIELD_LENGTH) {
    return {
      ok: false,
      response: errorResponse(
        400,
        `invalid ${field}: longer than ${MAX_REGISTRATION_FIELD_LENGTH} characters`
      ),
    };
  }
  const printable = value.replace(UNPRINTABLE, '').trim();
  if (printable === '') {
    return { ok: false, response: errorResponse(400, required) };
  }
  return { ok: true, value: printable };
}

// POST /api/agents/register — request tier. Registers agent:<caller's handle>/<name>
// pending the owner's approval; a pending or approved name 409s until revoked.
export async function registerAgent(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { name?: unknown; client?: unknown };
  const displayName = registrationField(body.name, 'name');
  if (!displayName.ok) return displayName.response;
  const client = registrationField(body.client, 'client');
  if (!client.ok) return client.response;
  const name = normalizeAgentName(displayName.value);
  if (!HANDLE_PATTERN.test(name)) {
    return errorResponse(
      400,
      `invalid name: ${displayName.value} has no valid characters once normalized`
    );
  }
  const requester = humanActor(ctx);
  const address = `agent:${requester.slice('human:'.length)}/${name}`;
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
    displayName: displayName.value,
    client: client.value,
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
        body: `New agent ${address} (${client.value}) wants to join this project, requested by ${requester}.`,
        data: {
          type: 'agent-registration',
          agent: address,
          client: client.value,
          requestedBy: requester,
        } satisfies GateData,
      },
      { address: SYSTEM_ADDRESS, canDecide: true }
    );
  } catch (err) {
    // Without its gate nobody can approve the row, so revoke it: a retry can
    // then re-register instead of hitting the 409 above forever.
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

// Approve/revoke: answers the open registration gate if there is one, so its
// handler stays the one writer of status; else writes the agent row directly.
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

// GET /api/decisions/open — open blocking questions addressed to a human.
// Deciding humans only: who is waiting on what is not for anyone else.
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
