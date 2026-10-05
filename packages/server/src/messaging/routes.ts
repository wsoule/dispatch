import { isClientAddress, isReservedName } from '@dispatch-foo/a2a';
import { canonicalKind } from '@dispatch-foo/core';
import type { TaskDoc } from '@dispatch-foo/core';
import type {
  AgentRecord,
  Delivery,
  DeliveryState,
  GateData,
  JsonValue,
  Message,
  MessageKind,
  Ref,
  Sender,
  SendInput,
} from '@dispatch-foo/protocol';
import {
  DELIVERY_STATES,
  gateOf,
  parseAddress,
  SYSTEM_ADDRESS,
} from '@dispatch-foo/protocol';
import { randomBytes } from 'node:crypto';

import { tokenHash } from '../a2a/auth.js';
import type { ApiContext } from '../api.js';
import { humanActor } from '../api/caller.js';
import {
  errorResponse,
  jsonResponse,
  parseCountParam,
  readJsonBody,
  readJsonBodyOptional,
} from '../api/http.js';
import { speaksForRevoked } from '../api/revoke.js';
import { runMessageRefusal } from '../orchestrator/types.js';
import { tierAllows } from '../tiers.js';
import { federatedRow, newestOpenRoot } from './conversations.js';
import {
  answeringWith,
  closeGate,
  openHumanDecisions,
  registrationKey,
  SYSTEM_SENDER,
} from './gates.js';
import { implicitEpicMembers } from './host.js';
import { isInternalAgent } from './internalAgents.js';
import type { Principal } from './principal.js';

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

// The engine's view of a principal, for its read rule and every send.
function senderOf(principal: Principal): Sender {
  return { address: principal.address, canDecide: principal.canDecide };
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
  continueThread?: unknown;
}

// Narrows an unknown JSON body into a well-typed SendInput (shape only —
// deep validation happens in @dispatch-foo/protocol's validateSendInput).
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
  const data = withoutDraftedBy(body.data as JsonValue | undefined);
  if (data !== undefined) value.data = data;
  if (body.urgent !== undefined) value.urgent = body.urgent;
  if (body.blocking !== undefined) value.blocking = body.blocking;
  if (body.choices !== undefined) value.choices = body.choices;
  if (body.choice !== undefined) value.choice = body.choice;
  if (body.replyTo !== undefined) value.replyTo = body.replyTo;
  if (body.wake !== undefined) value.wake = body.wake;
  if (body.session !== undefined) value.session = body.session;
  return { ok: true, value };
}

// `data.draftedBy` is set only by the Overseer's sendAsHuman on the bus; a
// request that names it is claiming an agent wrote its text, so drop it.
function withoutDraftedBy(data: JsonValue | undefined): JsonValue | undefined {
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data) ||
    !('draftedBy' in data)
  )
    return data;
  const rest = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== 'draftedBy')
  ) as JsonValue & object;
  return Object.keys(rest).length === 0 ? undefined : rest;
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
  const data = withoutDraftedBy(body.data as JsonValue | undefined);
  if (data !== undefined) value.data = data;
  if (body.session !== undefined) value.session = body.session;
  return { ok: true, value };
}

// MEM-R8(c): a request-tier human may not message a live run that acts for
// another human; the task or that human is the way in.
function liveRunRefusal(
  ctx: ApiContext,
  principal: Principal,
  to: readonly string[]
): string | null {
  if (principal.kind !== 'human') return null;
  for (const address of to) {
    if (!address.startsWith('run:')) continue;
    const runId = address.slice('run:'.length);
    if (!ctx.orchestrator.isRunLive(runId)) continue;
    const meta = ctx.orchestrator.list().find((r) => r.id === runId);
    const refusal =
      meta === undefined
        ? null
        : runMessageRefusal(meta, principal.address, principal.canDecide);
    if (refusal !== null) return refusal;
  }
  return null;
}

// XH-R2: no run may message an A2A-origin run, directly, through its task or
// by replying into its thread; what one run reads must not reach a client.
function a2aRunRefusal(
  ctx: ApiContext,
  principal: Principal,
  addresses: readonly string[]
): string | null {
  if (principal.kind !== 'run') return null;
  const self = principal.address.slice('run:'.length);
  const ownTask = ctx.orchestrator.taskIdOfRun(self);
  for (const address of addresses) {
    let taskId: string | null = null;
    if (address.startsWith('run:')) {
      const runId = address.slice('run:'.length);
      if (runId !== self) taskId = ctx.orchestrator.taskIdOfRun(runId);
    } else if (address.startsWith('task:')) {
      taskId = address.slice('task:'.length);
    }
    if (
      taskId !== null &&
      taskId !== ownTask &&
      ctx.orchestrator.isA2ATask(taskId)
    )
      return `${address} came in over A2A; another run may not message it`;
  }
  return null;
}

// XH-R3: whether the principal's teammate lost access after handleApi
// resolved it; the cascade and closeAsksOfRevoked cover what lands anyway.
function revokedSince(ctx: ApiContext, principal: Principal): boolean {
  return speaksForRevoked(
    principal.address,
    ctx.actorContext.member.handle,
    (handle) => ctx.team.teammates.hasAccess(handle)
  );
}

// XH-R9: a run's scope gate goes only to its gate route (its operator when
// they can decide, else the owner), so a run cannot pick its decider; the
// other humans it named are returned to be told. Any other send as it came.
function scopeReaddressed(
  ctx: ApiContext,
  principal: Principal,
  input: SendInput
): { input: SendInput; told: string[] } {
  if (principal.kind !== 'run' || gateOf(input)?.type !== 'scope')
    return { input, told: [] };
  const runId = principal.address.slice('run:'.length);
  const { to, told } = ctx.messaging.routing.scopeTo(runId, input.to);
  return { input: { ...input, to }, told };
}

// Tells each human a run named on its scope gate who the gate went to instead.
async function tellScopeNamed(
  ctx: ApiContext,
  gate: Message,
  told: string[]
): Promise<void> {
  for (const ref of told) {
    try {
      await ctx.messaging.engine.send(
        {
          to: [ref],
          kind: 'notice',
          body: `${gate.from} asked you about its scope; the request went to ${gate.to.join(', ')}, who decides for that run.`,
          refs: [{ type: 'message', id: gate.id }],
          idempotencyKey: `scope-named:${gate.id}:${ref}`,
        },
        SYSTEM_SENDER
      );
    } catch (err) {
      console.error('messaging: scope notice failed', err);
    }
  }
}

// `continueThread: true` on a plain message to one run, task or person with
// no replyTo: reply into the newest open root it may join (newestOpenRoot).
function continuedInput(
  ctx: ApiContext,
  principal: Principal,
  input: SendInput
): SendInput {
  if (
    input.kind !== 'message' ||
    (input.replyTo ?? null) !== null ||
    input.to.length !== 1
  )
    return input;
  const root = newestOpenRoot(
    {
      engine: ctx.messaging.engine,
      store: ctx.messaging.store,
      orchestrator: ctx.orchestrator,
    },
    senderOf(principal),
    input.to[0]
  );
  return root === null ? input : { ...input, replyTo: root.id };
}

// POST /api/messages as the resolved principal. The same principal repeating
// an `Idempotency-Key` gets the first send back with 200, even after a restart.
export async function sendMessage(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const principal = requirePrincipal(ctx);
  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsedInput = parseSendInput(parsedBody.value);
  if (!parsedInput.ok) return parsedInput.response;
  const continueThread = (parsedBody.value as RawSendBody).continueThread;
  if (continueThread !== undefined && typeof continueThread !== 'boolean')
    return invalidField(
      'continueThread',
      'invalid continueThread: expected a boolean'
    );
  // The body may arrive after a revoke this credential's check predates.
  if (revokedSince(ctx, principal))
    return jsonResponse(
      { error: "this credential's access was revoked", code: 'auth_revoked' },
      401
    );
  const refusal =
    liveRunRefusal(ctx, principal, parsedInput.value.to) ??
    a2aRunRefusal(ctx, principal, parsedInput.value.to);
  if (refusal !== null) return errorResponse(403, refusal);

  const { input, told } = scopeReaddressed(
    ctx,
    principal,
    continueThread === true
      ? continuedInput(ctx, principal, parsedInput.value)
      : parsedInput.value
  );
  // The engine keys (sender, Idempotency-Key) in messages.db, so a retry after
  // a restart still replays the first send.
  const idemKey = req.headers.get('idempotency-key');
  const result = await answeringWith(principal.ownerCredential === true, () =>
    ctx.messaging.engine.send(
      idemKey === null ? input : { ...input, idempotencyKey: idemKey },
      senderOf(principal)
    )
  );
  if (result.replayed !== true) await tellScopeNamed(ctx, result.message, told);
  return jsonResponse(result, result.replayed === true ? 200 : 201);
}

// GET /api/messages/:id — a message the caller may not read answers exactly
// as an absent id does, so its existence is not disclosed.
export function getMessageById(ctx: ApiContext, id: string): Response {
  const principal = requirePrincipal(ctx);
  const message = ctx.messaging.engine.getMessage(id);
  if (
    message === null ||
    !ctx.messaging.engine.canRead(id, senderOf(principal))
  ) {
    return errorResponse(404, `no message ${id}`);
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
  const target = ctx.messaging.engine.getMessage(id);
  const refusal =
    target === null || !ctx.messaging.engine.canRead(id, senderOf(principal))
      ? null
      : a2aRunRefusal(ctx, principal, [target.from, ...target.to]);
  if (refusal !== null) return errorResponse(403, refusal);
  const result = await answeringWith(principal.ownerCredential === true, () =>
    ctx.messaging.engine.reply(id, parsedInput.value, senderOf(principal))
  );
  // Only a reply that approves the registration can record an owner approval.
  const gate = target === null ? null : gateOf(target);
  if (
    gate?.type === 'agent-registration' &&
    result.message.kind === 'answer' &&
    result.message.choice === 'approve'
  )
    ctx.memory.host.agentDecided(
      gate.agent,
      principal.ownerCredential === true
    );
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
  if (
    question === null ||
    !ctx.messaging.engine.canRead(id, senderOf(principal))
  ) {
    return Promise.resolve(errorResponse(404, `no message ${id}`));
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

  // With federation, every answer carries its settlement (the settler's say).
  const answered = (answer: Message | null): Response =>
    jsonResponse(
      ctx.federation === null
        ? { answer }
        : { answer, settlement: settlementOf(ctx, id) }
    );
  const existing = ctx.messaging.engine.answerOf(id);
  if (existing !== null) return Promise.resolve(answered(existing));
  if (!wait || req.signal.aborted) {
    return Promise.resolve(answered(null));
  }

  return new Promise<Response>((resolve) => {
    let settled = false;
    const finish = (answer: Message | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      req.signal.removeEventListener('abort', onAbort);
      resolve(answered(answer));
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

// GET /api/threads/:id — for a deciding human or a participant of any message
// in it; anyone else, and every caller of an empty thread, gets the absent-id 404.
export function getThreadById(ctx: ApiContext, threadId: string): Response {
  const principal = requirePrincipal(ctx);
  if (!ctx.messaging.engine.canReadThread(threadId, senderOf(principal))) {
    return errorResponse(404, `no message ${threadId}`);
  }
  const thread = ctx.messaging.engine.thread(threadId);
  const fed = ctx.federation;
  if (fed === null) return jsonResponse(thread);
  // Federated rows: who sent from which machine, remote recipients' states,
  // each question's settlement, and an admitted observer when one reads.
  const store = ctx.messaging.store;
  const messages = thread.messages.map((m) => federatedRow(ctx, m));
  const remote = thread.messages.flatMap((m) =>
    store.remoteDeliveries({ messageId: m.id }).map((r) => ({
      messageId: r.messageId,
      recipient: r.recipient,
      via: r.via,
      state: r.state,
      remote: true as const,
    }))
  );
  const settlements: Record<string, Settlement> = {};
  for (const m of thread.messages)
    if (m.kind === 'question' || m.kind === 'handoff')
      settlements[m.id] = settlementOf(ctx, m.id);
  const crosses =
    remote.length > 0 || thread.messages.some((m) => m.origin !== undefined);
  return jsonResponse({
    messages,
    deliveries: [...thread.deliveries, ...remote],
    settlements,
    observer: crosses ? fed.observer() : null,
  });
}

type Settlement = 'local' | 'pending' | 'accepted' | 'superseded';

// A question's state across machines: `local` when no federated answer is
// stored, else accepted, pending or superseded from its answers' rows.
function settlementOf(ctx: ApiContext, questionId: string): Settlement {
  const store = ctx.messaging.store;
  const answers = store
    .answerCandidates(questionId)
    .map((c) => ({ message: c.message, settledAs: c.settledAs }));
  const federated =
    answers.some((a) => a.message.origin !== undefined) ||
    store.remoteDeliveries({ messageId: questionId }).length > 0;
  if (!federated) return 'local';
  if (answers.some((a) => a.settledAs === 'accepted')) return 'accepted';
  if (answers.some((a) => a.settledAs === 'pending')) return 'pending';
  if (answers.some((a) => a.settledAs === 'superseded')) return 'superseded';
  return 'pending';
}

const DEFAULT_RECENT_THREADS = 50;
const MAX_RECENT_THREADS = 200;

// GET /api/threads?limit=N[&about=task:<id>] — deciding humans only.
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
  const about = url.searchParams.get('about');
  if (about === null) {
    return jsonResponse({ threads: ctx.messaging.store.recentThreads(limit) });
  }
  // A malformed address throws a MessagingError naming `about` (400).
  const parsed = parseAddress(about, 'about');
  if (parsed.kind !== 'task') {
    return invalidField(
      'about',
      `invalid about ${JSON.stringify(about)}: expected task:<id>`
    );
  }
  const runs = ctx.orchestrator
    .list()
    .filter((run) => run.taskId === parsed.id)
    .map((run) => `run:${run.id}`);
  return jsonResponse({
    threads: ctx.messaging.store.recentThreads(limit, [about, ...runs]),
  });
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
// task's run, or a deciding human) may mark it read. A caller that may not read
// its message gets the absent id's 404, so the delivery's existence is not disclosed.
export function markDeliveryRead(ctx: ApiContext, id: string): Response {
  const principal = requirePrincipal(ctx);
  const delivery = ctx.messaging.store.getDelivery(id);
  if (
    delivery === null ||
    !ctx.messaging.engine.canRead(delivery.messageId, senderOf(principal))
  )
    return errorResponse(404, `no delivery ${id}`);
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

// GET /api/channels[?member=me] — every joined channel plus each epic's
// implicit `epic/<id>` channel, built from one task listing grouped by parent;
// `member=me` keeps those the caller (a run: its task) belongs to.
export function listChannels(ctx: ApiContext, url?: URL): Response {
  const member = url?.searchParams.get('member') ?? null;
  if (member !== null && member !== 'me')
    return invalidField('member', "invalid member: only 'me' is supported");
  const explicitChannels = ctx.messaging.store.channels();
  const explicitByName = new Map(explicitChannels.map((c) => [c.name, c]));

  const childrenByParent = new Map<string, TaskDoc[]>();
  const epicIds: string[] = [];
  for (const task of ctx.store.list()) {
    // A milestone is what an epic became; its channel keeps the `epic/` name.
    if (canonicalKind(task.meta.kind) === 'milestone') {
      epicIds.push(task.meta.id);
    }
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
  if (member === null) return jsonResponse({ channels });
  const me = selfActingAddress(ctx, requirePrincipal(ctx));
  return jsonResponse({
    channels: channels.filter((c) => c.members.includes(me)),
  });
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
  // A peer member sends every future channel message off the machine; only a registered one.
  if (
    member.startsWith('a2a:') &&
    (ctx.a2a?.peerStatus(member.slice('a2a:'.length)) ?? null) === null
  ) {
    return errorResponse(404, `no A2A peer ${member}`);
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
  const fed = ctx.federation;
  return jsonResponse({
    agents: ctx.messaging.store.agents().map((a) => ({
      ...stripTokenHash(a),
      // A teammate's agent names its registering machine's handle.
      ...(fed === null
        ? {}
        : {
            remote: a.tokenHash.startsWith('remote:')
              ? registeringHandle(ctx, a.address)
              : null,
          }),
    })),
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
// why it is missing or too long.
export function registrationField(
  value: unknown,
  field: 'name' | 'client'
): { ok: true; value: string } | { ok: false; error: string } {
  const required = `invalid ${field}: ${field} is required`;
  if (typeof value !== 'string') return { ok: false, error: required };
  if (value.length > MAX_REGISTRATION_FIELD_LENGTH) {
    return {
      ok: false,
      error: `invalid ${field}: longer than ${MAX_REGISTRATION_FIELD_LENGTH} characters`,
    };
  }
  const printable = value.replace(UNPRINTABLE, '').trim();
  if (printable === '') return { ok: false, error: required };
  return { ok: true, value: printable };
}

// POST /api/agents/register — request tier. Registers agent:<caller's handle>/<name>
// pending approval; 409s on a pending or approved name, or on Dispatch's own.
export async function registerAgent(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    name?: unknown;
    client?: unknown;
    rekey?: unknown;
  };
  const displayName = registrationField(body.name, 'name');
  if (!displayName.ok) return errorResponse(400, displayName.error);
  const client = registrationField(body.client, 'client');
  if (!client.ok) return errorResponse(400, client.error);
  const name = normalizeAgentName(displayName.value);
  if (isReservedName(name)) {
    return errorResponse(
      400,
      'invalid name: names starting with "a2a." are reserved for A2A clients; add one with `dispatch a2a clients add`'
    );
  }
  if (!HANDLE_PATTERN.test(name)) {
    return errorResponse(
      400,
      `invalid name: ${displayName.value} has no valid characters once normalized`
    );
  }
  const requester = humanActor(ctx);
  const address = `agent:${requester.slice('human:'.length)}/${name}`;
  if (body.rekey !== undefined && typeof body.rekey !== 'boolean')
    return errorResponse(400, 'invalid rekey: expected a boolean');
  if (body.rekey === true) {
    const refused = rekeyAgent(ctx, address);
    if (refused !== null) return refused;
  }
  const reg = await registerAgentRow(ctx, {
    name,
    displayName: displayName.value,
    client: client.value,
    requester,
    gateBody: `New agent ${address} (${client.value}) wants to join this project, requested by ${requester}.`,
    refuseAnyExisting: false,
  });
  if (!reg.ok) return reg.response;
  return jsonResponse(
    { address: reg.address, token: reg.token, status: reg.record.status },
    201
  );
}

// Retires `address`'s row so the same name can register again: an agent on
// the owner's machine (the daemon file's token, or the app token) whose cached
// token was lost. Null when it may go ahead; the refusal otherwise.
function rekeyAgent(ctx: ApiContext, address: string): Response | null {
  if (ctx.viaAgentToken !== true && ctx.ownerCredential !== true)
    return errorResponse(
      403,
      "only an agent on the owner's machine may re-key its name"
    );
  const existing = ctx.messaging.store.getAgent(address);
  if (existing === null || existing.status === 'revoked') return null;
  if (isInternalAgent(existing))
    return errorResponse(
      409,
      `${address} is Dispatch's own agent; register under another name`
    );
  ctx.messaging.store.putAgent({ ...existing, status: 'revoked' });
  // Cards raised for the old key would decide nothing now: close them.
  for (;;) {
    const card = openRegistrationGateFor(ctx, address);
    if (card === null || !closeGate(ctx.messaging.engine, card.id, 're-keyed'))
      break;
  }
  return null;
}

// How many registrations one namespace (agent:<handle>/) may have pending.
const MAX_PENDING_REGISTRATIONS = 10;

// A registration already checked for its name: the agent row, its token and
// the owner gate that approves it.
export interface AgentRegistration {
  name: string;
  displayName: string;
  client: string;
  requester: string;
  gateBody: string;
  // Refuse a name that was ever registered, revoked rows included.
  refuseAnyExisting: boolean;
  // A deciding caller approves it in the same request, so no gate waits.
  approvedAtOnce?: boolean;
}

// Writes a pending agent:<requester's handle>/<name> row with a fresh token and
// sends its approval gate; the row is revoked if the gate cannot be sent.
export async function registerAgentRow(
  ctx: ApiContext,
  reg: AgentRegistration
): Promise<
  | { ok: true; address: string; token: string; record: AgentRecord }
  | { ok: false; response: Response }
> {
  const address = `agent:${reg.requester.slice('human:'.length)}/${reg.name}`;
  const existing = ctx.messaging.store.getAgent(address);
  if (existing !== null && isInternalAgent(existing)) {
    return {
      ok: false,
      response: errorResponse(
        409,
        `${address} is Dispatch's own agent; register under another name`
      ),
    };
  }
  // Revoking cannot free a name that refuses any existing row, so that mode
  // answers every existing row with the one "choose a new name" 409.
  if (existing !== null && reg.refuseAnyExisting) {
    return {
      ok: false,
      response: errorResponse(
        409,
        `${address} was registered before; choose a new name`
      ),
    };
  }
  if (
    existing !== null &&
    (existing.status === 'approved' || existing.status === 'pending')
  ) {
    return {
      ok: false,
      response: errorResponse(
        409,
        `${address} is already registered (${existing.status}) — ask a human to revoke it first`
      ),
    };
  }

  // M4: each namespace may hold only so many registrations awaiting the
  // owner, so a token cannot flood Needs you with approval gates.
  const namespace = address.slice(0, address.indexOf('/') + 1);
  const pending = ctx.messaging.store
    .agents()
    .filter(
      (a) => a.status === 'pending' && a.address.startsWith(namespace)
    ).length;
  if (reg.approvedAtOnce !== true && pending >= MAX_PENDING_REGISTRATIONS) {
    return {
      ok: false,
      response: errorResponse(
        429,
        `${pending} registrations under ${namespace}* already await approval; ask a human to approve or deny them first`
      ),
    };
  }

  const token = randomBytes(32).toString('hex');
  const record: AgentRecord = {
    address,
    displayName: reg.displayName,
    client: reg.client,
    tokenHash: tokenHash(token),
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
        body: reg.gateBody,
        data: {
          type: 'agent-registration',
          agent: address,
          client: reg.client,
          requestedBy: reg.requester,
          key: registrationKey(record.tokenHash),
        } satisfies GateData,
      },
      { address: SYSTEM_ADDRESS, canDecide: true }
    );
  } catch (err) {
    // Without its gate nobody can approve the row, so revoke it. An ordinary
    // agent can then re-register; with refuseAnyExisting the name stays spent.
    ctx.messaging.store.putAgent({ ...record, status: 'revoked' });
    return {
      ok: false,
      response: errorResponse(
        500,
        `registration gate failed to send: ${(err as Error).message}`
      ),
    };
  }

  return { ok: true, address, token, record };
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

// The handle of the machine a replicated agent was registered on.
function registeringHandle(ctx: ApiContext, address: string): string {
  const fed = ctx.federation;
  if (fed === null) return 'a teammate';
  const row = fed.fed.db
    .query<{ replica: string }, [string]>(
      'SELECT replica FROM fed_agents WHERE address = ?'
    )
    .get(address);
  return row === null ? 'a teammate' : fed.label(row.replica);
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
  // A teammate's agent is approved or revoked only on its own machine.
  if (agent.tokenHash.startsWith('remote:'))
    return errorResponse(
      409,
      `${address} is registered on ${registeringHandle(ctx, address)}'s machine; approve or revoke it there`
    );
  // Revoking is final (XH-R3): a revoked teammate's agents and A2A clients
  // stay off. Only the owner's own Overseer, their off switch, comes back,
  // and only through the owner's own credential (the app token).
  if (choice === 'approve' && agent.status === 'revoked') {
    if (address !== ctx.actorContext.agentRef('overseer'))
      return jsonResponse(
        {
          error: `${address} was revoked, which is final; register a new agent instead`,
          code: 'revoked_final',
        },
        409
      );
    if (
      ctx.ownerCredential !== true ||
      !tierAllows(ctx.caller?.tier ?? 'request', 'operator')
    )
      return errorResponse(
        403,
        "only this daemon's owner can turn the Overseer back on"
      );
  }
  // A revoked row ignores its gate's answers, so the Overseer's comes back by a direct write.
  const gate =
    agent.status === 'revoked' ? null : openRegistrationGateFor(ctx, address);
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
  ctx.memory.host.agentDecided(address, ctx.ownerCredential === true);
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

// POST /api/agents/:addr/revoke. A revoked A2A client's open asks are closed.
export async function revokeAgent(
  ctx: ApiContext,
  address: string
): Promise<Response> {
  const res = await decideAgent(ctx, address, 'deny', 'revoked');
  if (res.ok && isClientAddress(address)) ctx.a2a?.clientRevoked(address);
  return res;
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
  return jsonResponse({ items: openHumanDecisions(ctx.messaging.engine) });
}
