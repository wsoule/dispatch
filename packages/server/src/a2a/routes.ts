import type { A2AStore, ClientRow, TaskRow } from '@dispatch/a2a';
import {
  cardJson,
  clientNameFor,
  decideState,
  TERMINAL_STATES,
} from '@dispatch/a2a';
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
import type { DaemonBridgePort } from './port.js';
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

// POST /api/a2a/clients: the clients row first, then the agent row and its
// registration gate, which `approve` answers at once for a deciding caller.
async function addClient(
  req: Request,
  ctx: ApiContext,
  b: Running
): Promise<Response> {
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

// `/api/a2a/*` after the `a2a` segment; null for anything it does not serve,
// so handleApi's 404 applies. Tiers are enforced in ELEVATED_ROUTES.
export async function handleA2ARoute(
  req: Request,
  ctx: ApiContext,
  segments: string[],
  method: string
): Promise<Response | null> {
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
