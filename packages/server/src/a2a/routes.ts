import type { A2AStore, ClientRow, TaskRow } from '@dispatch/a2a';
import {
  cardJson,
  clientNameFor,
  decideState,
  isClientAddress,
  PeerHttpError,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import { MessagingError } from '@dispatch/protocol';
import { randomBytes } from 'node:crypto';

import type { ApiContext } from '../api.js';
import { humanActor } from '../api/caller.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  readJsonBodyOptional,
} from '../api/http.js';
import { closeGate } from '../messaging/gates.js';
import {
  approveAgent,
  registerAgentRow,
  registrationField,
} from '../messaging/routes.js';
import { tierAllows } from '../tiers.js';
import { tokenHash } from './auth.js';
import type { A2ABridge } from './bridge.js';
import { gatherFacts } from './facts.js';
import { hostPublicUrl, isHostName, mintHost } from './hosts.js';
import { acceptPairing, offerPairing, pairingSummaries } from './pairing.js';
import type { PeerAddInput, PeerChange } from './peers.js';
import {
  addPeer,
  peerSummary,
  refreshPeer,
  removePeer,
  setPeerEnabled,
} from './peers.js';
import type { DaemonBridgePort } from './port.js';
import { handlePortRoute } from './portRoutes.js';
import { parseSettings } from './settings.js';

const HANDLE = /^[a-z0-9][a-z0-9._-]*$/;
const HUMAN = /^human:[a-z0-9][a-z0-9._-]*$/;

// A bridge whose a2a.db is open.
interface Running {
  ok: true;
  a2a: A2ABridge;
  store: A2AStore;
  port: DaemonBridgePort;
}

// The running bridge, or the 503 naming why it is down.
function bridge(ctx: ApiContext): Running | { ok: false; response: Response } {
  const a2a = ctx.a2a;
  if (a2a?.store == null || a2a.port === null) {
    return {
      ok: false,
      response: errorResponse(
        503,
        `the A2A bridge is unavailable: ${a2a?.status().error ?? 'not started'}`
      ),
    };
  }
  return { ok: true, a2a, store: a2a.store, port: a2a.port };
}

function invalid(field: string, error: string): Response {
  return jsonResponse({ error, field }, 400);
}

function changed(ctx: ApiContext): void {
  ctx.events.broadcast({ type: 'a2a.changed' });
}

// The clients a route parameter names: an address, an `a2a.` name, or the
// name as typed (normalized the way `clients add` normalizes it).
function clientsNamed(store: A2AStore, param: string): ClientRow[] {
  const name = clientNameFor(param);
  return store
    .clients()
    .filter((c) => c.address === param || c.name === param || c.name === name);
}

async function putListener(
  req: Request,
  ctx: ApiContext,
  b: Running
): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = parseSettings(body.value);
  if (!parsed.ok)
    return invalid(parsed.key, `${parsed.key} has the wrong type`);
  // A write that leaves `standalone` out keeps the current switch.
  if ((body.value as { standalone?: unknown }).standalone === undefined)
    parsed.settings.standalone = b.a2a.standalone();
  const checked = b.a2a.check(parsed.settings);
  if (!checked.ok) return invalid(checked.key, checked.error);
  const status = await b.a2a.applySettings(parsed.settings);
  changed(ctx);
  return jsonResponse(status);
}

async function deleteListener(ctx: ApiContext, b: Running): Promise<Response> {
  const status = await b.a2a.disable();
  changed(ctx);
  return jsonResponse(status);
}

function listClients(ctx: ApiContext, store: A2AStore): Response {
  const clients = store.clients().flatMap((c) => {
    // A clients row with no agent (a crash mid-add) is not a client yet.
    const agent = ctx.messaging.store.getAgent(c.address);
    return agent === null ? [] : [{ ...c, status: agent.status }];
  });
  return jsonResponse({ clients });
}

// Unapproved clients per requester, so registrations cannot pile up gates.
const MAX_PENDING_CLIENTS = 10;

// One requester's clients still waiting for approval.
function pendingClients(ctx: ApiContext, requester: string): number {
  const prefix = `agent:${requester.slice('human:'.length)}/`;
  return ctx.messaging.store
    .agents()
    .filter(
      (a) =>
        a.status === 'pending' &&
        a.address.startsWith(prefix) &&
        isClientAddress(a.address)
    ).length;
}

// POST /api/a2a/clients: the clients row first, then the agent row and its
// registration gate, which `approve` answers at once for a deciding caller.
async function addClient(
  req: Request,
  ctx: ApiContext,
  b: Running
): Promise<Response> {
  // The shared agent token is no human: an agent must not mint the
  // credentials outside callers reach this project with.
  if (ctx.viaAgentToken === true)
    return jsonResponse(
      {
        error: 'an agent cannot add A2A clients; a human adds them',
        code: 'auth_agent_token',
      },
      403
    );
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    name?: unknown;
    to?: unknown;
    approve?: unknown;
  };
  const displayName = registrationField(body.name, 'name');
  if (!displayName.ok) return invalid('name', displayName.error);
  const name = clientNameFor(displayName.value);
  if (!HANDLE.test(name.slice('a2a.'.length)))
    return invalid(
      'name',
      `invalid name: ${displayName.value} has no valid characters once normalized`
    );
  const to = body.to ?? [];
  if (!Array.isArray(to))
    return invalid('to', 'to must be a list of human:<handle>');
  for (const [i, a] of to.entries()) {
    if (typeof a !== 'string' || !HUMAN.test(a))
      return invalid(`to[${i}]`, 'expected human:<handle>');
  }
  if (body.approve !== undefined && typeof body.approve !== 'boolean')
    return invalid('approve', 'approve must be true or false');
  if (
    body.approve === true &&
    !tierAllows(ctx.caller?.tier ?? 'request', 'decide')
  ) {
    return jsonResponse(
      {
        error: 'approving a client needs the decide tier',
        code: 'auth_insufficient_tier',
      },
      403
    );
  }
  const requester = humanActor(ctx);
  if (
    body.approve !== true &&
    pendingClients(ctx, requester) >= MAX_PENDING_CLIENTS
  )
    return errorResponse(
      429,
      `${MAX_PENDING_CLIENTS} of your A2A clients already wait for approval; approve or revoke some first`
    );
  const address = `agent:${requester.slice('human:'.length)}/${name}`;
  // Any existing row, revoked included: a re-used name would inherit the old
  // client's tasks and threads, which key on the address.
  if (ctx.messaging.store.getAgent(address) !== null) {
    return errorResponse(
      409,
      `${address} was registered before; choose a new name or rotate its token`
    );
  }
  const recipients = [...new Set(to as string[])];
  b.store.putClient({
    address,
    name,
    recipients,
    createdBy: requester,
    createdAt: new Date().toISOString(),
  });
  const reg = await registerAgentRow(ctx, {
    name,
    displayName: displayName.value,
    client: 'a2a',
    requester,
    refuseAnyExisting: true,
    approvedAtOnce: body.approve === true,
    gateBody: `New A2A client ${address} wants to reach this project. It may address ${[ctx.actorContext.humanRef, ...recipients].join(', ')}. Requested by ${requester}.`,
  });
  if (!reg.ok) return reg.response;
  if (body.approve === true) await approveAgent(ctx, address);
  const status =
    ctx.messaging.store.getAgent(address)?.status ?? reg.record.status;
  changed(ctx);
  return jsonResponse({ address, token: reg.token, status }, 201);
}

// A fresh token in place of the old one; status and tasks are kept, and the
// old token stops authenticating at once.
function rotateClient(
  ctx: ApiContext,
  store: A2AStore,
  param: string
): Response {
  const rows = clientsNamed(store, param);
  if (rows.length > 1) {
    return errorResponse(
      409,
      `${param} names more than one client (${rows.map((r) => r.address).join(', ')}); pass its address`
    );
  }
  const agent =
    rows.length === 0 ? null : ctx.messaging.store.getAgent(rows[0].address);
  if (agent === null) return errorResponse(404, `no A2A client ${param}`);
  if (agent.status === 'revoked') {
    return errorResponse(
      409,
      `${agent.address} was revoked; add a new client instead`
    );
  }
  const token = randomBytes(32).toString('hex');
  ctx.messaging.store.putAgent({ ...agent, tokenHash: tokenHash(token) });
  changed(ctx);
  return jsonResponse({ token });
}

function listTasks(url: URL, store: A2AStore): Response {
  const param = url.searchParams.get('client');
  const clients = param === null ? store.clients() : clientsNamed(store, param);
  if (param !== null && clients.length === 0)
    return errorResponse(404, `no A2A client ${param}`);
  const tasks: TaskRow[] = clients
    .flatMap((c) => store.tasksOf(c.address))
    .sort((a, b) =>
      a.statusAt === b.statusAt
        ? b.id.localeCompare(a.id)
        : b.statusAt.localeCompare(a.statusAt)
    );
  return jsonResponse({ tasks });
}

// The owner closes an unanswered ask; the client sees REJECTED with the reason.
async function declineTask(
  req: Request,
  ctx: ApiContext,
  b: Running,
  id: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const reason = parsed.value.reason;
  if (reason !== undefined && typeof reason !== 'string')
    return invalid('reason', 'reason must be a string');
  const row = b.store.getTask(id);
  if (row === null) return errorResponse(404, `no A2A task ${id}`);
  if (row.skill !== 'ask')
    return errorResponse(409, 'decline a handoff through its proposal gate');
  const { state } = decideState(gatherFacts(b.port.deps, row));
  if (TERMINAL_STATES.has(state))
    return errorResponse(409, `this task is already finished (${state})`);
  const text =
    reason === undefined || reason.trim() === ''
      ? 'declined by the owner'
      : `declined by the owner: ${reason.trim()}`;
  // declinedAt first, so a crash before the close still reads REJECTED.
  b.store.updateTask(id, { declinedAt: new Date().toISOString() });
  let closed = false;
  try {
    closed = closeGate(ctx.messaging.engine, id, text);
  } finally {
    if (!closed) b.store.updateTask(id, { declinedAt: null });
  }
  if (!closed) return errorResponse(409, 'this question was just answered');
  b.a2a.watch?.recompute(id);
  changed(ctx);
  return jsonResponse(b.store.getTask(id));
}

// A peer add body, field by field; MessagingError('invalid') names the bad one.
function parsePeerAddInput(raw: Record<string, unknown>): PeerAddInput {
  const text = (key: string, required: boolean): string | undefined => {
    const v = raw[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || (required && v.trim() === ''))
      throw new MessagingError('invalid', `${key} must be text`, key);
    return v;
  };
  const flag = (key: string): boolean | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean')
      throw new MessagingError('invalid', `${key} must be true or false`, key);
    return v;
  };
  const token = text('token', false);
  const apiKeyHeader = text('apiKeyHeader', false);
  const allowHttp = flag('allowHttp');
  const allowOrigin = flag('allowOrigin');
  return {
    alias: text('alias', true) ?? '',
    cardUrl: text('cardUrl', true) ?? '',
    ...(token === undefined ? {} : { token }),
    ...(apiKeyHeader === undefined ? {} : { apiKeyHeader }),
    ...(allowHttp === undefined ? {} : { allowHttp }),
    ...(allowOrigin === undefined ? {} : { allowOrigin }),
  };
}

// `/api/a2a/peers[/:alias[/refresh|enable|disable]]`; tiers are in
// ELEVATED_ROUTES, and addPeer asks the operator tier for private URLs.
async function peerRoute(
  req: Request,
  ctx: ApiContext,
  rest: string[],
  method: string
): Promise<Response | null> {
  const service = ctx.a2a?.peers ?? null;
  if (service === null)
    return errorResponse(503, 'the A2A bridge is unavailable');
  const caller = {
    tier: ctx.caller?.tier ?? 'request',
    ref: humanActor(ctx),
  };
  const changedPeer = (alias: string, what: PeerChange) => {
    service.emit(alias, what);
    changed(ctx);
  };
  try {
    if (rest.length === 0 && method === 'GET')
      return jsonResponse({
        peers: service.deps.store.peers().map(peerSummary),
      });
    if (rest.length === 0 && method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const row = await addPeer(
        service.deps,
        parsePeerAddInput(parsed.value as Record<string, unknown>),
        caller
      );
      changedPeer(row.alias, 'added');
      return jsonResponse(peerSummary(row), 201);
    }
    if (rest.length === 0) return null;
    const alias = decodeURIComponent(rest[0]);
    if (rest.length === 1 && method === 'DELETE') {
      if (!removePeer(service.deps, alias))
        return errorResponse(404, `no A2A peer ${alias}`);
      changedPeer(alias, 'removed');
      return new Response(null, { status: 204 });
    }
    if (rest.length === 2 && method === 'POST' && rest[1] === 'refresh') {
      const row = await refreshPeer(service.deps, service.notices, alias);
      changedPeer(alias, row.status === 'disabled' ? 'disabled' : 'refreshed');
      return jsonResponse(peerSummary(row));
    }
    if (
      rest.length === 2 &&
      method === 'POST' &&
      (rest[1] === 'enable' || rest[1] === 'disable')
    ) {
      const parsed = await readJsonBodyOptional(req);
      if (!parsed.ok) return parsed.response;
      const token = (parsed.value as { token?: unknown }).token;
      if (token !== undefined && typeof token !== 'string')
        return invalid('token', 'token must be text');
      const enable = rest[1] === 'enable';
      const row = await setPeerEnabled(service.deps, alias, enable, token);
      changedPeer(alias, enable ? 'enabled' : 'disabled');
      return jsonResponse(peerSummary(row));
    }
    return null;
  } catch (err) {
    if (err instanceof PeerHttpError)
      return jsonResponse(
        {
          error: `the peer's card could not be fetched: ${err.message}`,
          field: 'cardUrl',
        },
        502
      );
    throw err;
  }
}

// Standalone hosts and the switch that lets them in; tiers are in
// ELEVATED_ROUTES (operator). A host's token is shown once, never listed.
async function hostRoute(
  req: Request,
  ctx: ApiContext,
  segments: string[],
  method: string
): Promise<Response | null> {
  const b = bridge(ctx);
  if (!b.ok) return b.response;
  if (segments[0] === 'listener' && segments.length === 2 && method === 'PUT') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const enabled = (parsed.value as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean')
      return invalid('enabled', 'enabled must be true or false');
    const result = await b.a2a.setStandalone(enabled);
    changed(ctx);
    return jsonResponse(result);
  }
  if (segments[0] !== 'hosts') return null;
  if (segments.length === 1 && method === 'GET')
    return jsonResponse({
      standalone: b.a2a.standalone(),
      hosts: b.store.hosts().map(({ tokenHash: _hash, ...row }) => row),
    });
  if (segments.length === 1 && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const { name, publicUrl: rawUrl } = parsed.value as {
      name?: unknown;
      publicUrl?: unknown;
    };
    if (typeof name !== 'string' || !isHostName(name.trim()))
      return invalid(
        'name',
        'name: letters, digits, spaces, ".", "_" and "-", at most 64'
      );
    const publicUrl = hostPublicUrl(rawUrl);
    if (publicUrl === null)
      return invalid(
        'publicUrl',
        'publicUrl: the URL the host serves on, https (or http on loopback), with no query'
      );
    const { row, token } = mintHost(
      b.store,
      name.trim(),
      publicUrl,
      humanActor(ctx)
    );
    changed(ctx);
    return jsonResponse(
      { id: row.id, name: row.name, publicUrl: row.publicUrl, token },
      201
    );
  }
  if (segments.length === 2 && method === 'DELETE') {
    const id = decodeURIComponent(segments[1]);
    if (!b.store.revokeHost(id, new Date().toISOString()))
      return errorResponse(404, `no live A2A host ${id}`);
    b.a2a.hostRevoked(id);
    changed(ctx);
    return new Response(null, { status: 204 });
  }
  return null;
}

// `/api/a2a/pairings[/accept | /:id]` (P5): offer a code, accept one, list
// or cancel; tiers are in ELEVATED_ROUTES, private card URLs need the operator.
async function pairingRoute(
  req: Request,
  ctx: ApiContext,
  rest: string[],
  method: string
): Promise<Response | null> {
  // As for clients: an agent must not mint a way in for outside callers.
  if (ctx.viaAgentToken === true)
    return jsonResponse(
      {
        error: 'an agent cannot pair; a human pairs',
        code: 'auth_agent_token',
      },
      403
    );
  const b = bridge(ctx);
  if (!b.ok) return b.response;
  const peers = b.a2a.peers;
  if (peers === null)
    return errorResponse(503, 'the A2A bridge is unavailable');
  const d = { ...peers.deps, notices: peers.notices, emit: peers.emit };
  const caller = { tier: ctx.caller?.tier ?? 'request', ref: humanActor(ctx) };
  if (rest.length === 0 && method === 'GET')
    return jsonResponse({ pairings: pairingSummaries(d) });
  if (rest.length === 1 && method === 'DELETE') {
    const row = b.store.pairing(decodeURIComponent(rest[0]));
    if (row === null || row.role !== 'offer' || row.state !== 'offered')
      return errorResponse(404, 'no open pairing offer with that id');
    b.store.setPairingState(row.id, 'canceled');
    changed(ctx);
    return new Response(null, { status: 204 });
  }
  if (method !== 'POST' || rest.length > 1) return null;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;
  // This side's card URL: the open listener's, or one given (a host or relay).
  const status = b.a2a.status();
  const ourCard =
    typeof body.cardUrl === 'string'
      ? body.cardUrl
      : status.listening && status.url !== null
        ? `${status.url.replace(/\/$/, '')}/.well-known/agent-card.json`
        : null;
  if (ourCard === null)
    return errorResponse(
      409,
      'open the A2A listener first, or pass cardUrl: the other side needs to reach this agent'
    );
  if (typeof body.alias !== 'string')
    return invalid('alias', 'alias is required');
  if (body.ttlMin !== undefined && typeof body.ttlMin !== 'number')
    return invalid('ttlMin', 'ttlMin must be a number of minutes');
  try {
    if (rest.length === 0) {
      const offered = offerPairing(d, {
        alias: body.alias,
        ourCard,
        ...(typeof body.ttlMin === 'number' ? { ttlMin: body.ttlMin } : {}),
        caller,
      });
      changed(ctx);
      return jsonResponse(offered, 201);
    }
    if (rest[0] !== 'accept') return null;
    if (typeof body.code !== 'string')
      return invalid('code', 'code is required');
    const accepted = await acceptPairing(d, {
      code: body.code,
      alias: body.alias,
      ourCard,
      caller,
    });
    changed(ctx);
    return jsonResponse(accepted);
  } catch (err) {
    if (err instanceof PeerHttpError)
      return jsonResponse(
        {
          error: `the other side's card could not be fetched: ${err.message}`,
          field: 'code',
        },
        502
      );
    throw err;
  }
}

// `/api/a2a/*` after the `a2a` segment; null for anything it does not serve,
// so handleApi's 404 applies. Tiers are enforced in ELEVATED_ROUTES.
export async function handleA2ARoute(
  req: Request,
  ctx: ApiContext,
  segments: string[],
  method: string
): Promise<Response | null> {
  if (segments[0] === 'peers')
    return peerRoute(req, ctx, segments.slice(1), method);
  if (segments[0] === 'port')
    return handlePortRoute(req, ctx, segments.slice(1), method);
  if (segments[0] === 'pairings')
    return pairingRoute(req, ctx, segments.slice(1), method);
  if (
    segments[0] === 'hosts' ||
    (segments[0] === 'listener' && segments[1] === 'standalone')
  )
    return hostRoute(req, ctx, segments, method);
  const withId = segments.length === 3;
  const key = withId
    ? `${method} ${segments[0]}/*/${segments[2]}`
    : `${method} ${segments.join('/')}`;
  if (key === 'GET listener') {
    return ctx.a2a === undefined
      ? errorResponse(503, 'the A2A bridge is unavailable: not started')
      : jsonResponse(ctx.a2a.status());
  }
  const id = (): string => decodeURIComponent(segments[1]);
  const handlers = new Map<
    string,
    (b: Running) => Response | Promise<Response>
  >([
    ['PUT listener', (b) => putListener(req, ctx, b)],
    ['DELETE listener', (b) => deleteListener(ctx, b)],
    ['GET card', async (b) => jsonResponse(cardJson(await b.port.card()))],
    ['GET clients', (b) => listClients(ctx, b.store)],
    ['POST clients', (b) => addClient(req, ctx, b)],
    ['POST clients/*/rotate', (b) => rotateClient(ctx, b.store, id())],
    ['GET tasks', (b) => listTasks(new URL(req.url), b.store)],
    ['POST tasks/*/decline', (b) => declineTask(req, ctx, b, id())],
  ]);
  const handler = handlers.get(key);
  if (handler === undefined) return null;
  const b = bridge(ctx);
  return b.ok ? await handler(b) : b.response;
}
