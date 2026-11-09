import {
  applyLinkMail,
  applyLinkState,
  DELIVERY_STATES,
  DeliveryEngine,
  MessagingError,
  openMessagesDb,
  SqliteMessageStore,
  SYSTEM_ADDRESS,
} from '@dispatch-foo/protocol';
import type {
  AgentRecord,
  DeliveryState,
  LinkMail,
  LinkState,
  Message,
  Sender,
  SendInput,
} from '@dispatch-foo/protocol';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { normalizeAgentName } from '../identity.js';
import { HubHost } from './host.js';
import type { HubLink } from './links.js';
import { HubLinks, projectAddress } from './links.js';
import type { RosterAgent, TeamFile } from './team.js';
import { isTeamRow, TeamLink } from './team.js';
import { HubWeb } from './web.js';

// The machine hub: one per OS user, it homes every MCP session's address and
// mail, whatever repo the session works in. Its routes are the subset of
// dispatchd's messaging API the MCP calls, with the same shapes, so the MCP
// talks to either. With no team, a client started by this OS user is trusted
// (the hub token is 0600 to them), so client identities are approved at once.

export interface HubOptions {
  /** Directory for messages.db. */
  dir: string;
  /** The request-tier token published in hub.json. */
  token: string;
  /** The id /api/health answers with, published in hub.json. */
  id: string;
  /** This user's handle: agent addresses are agent:<handle>/<name>. */
  handle: string;
  port?: number;
  /** The team this machine is signed in to, if any. */
  team?: TeamFile | null;
}

export interface HubHandle {
  port: number;
  server: Server;
  store: SqliteMessageStore;
  engine: DeliveryEngine;
  /** Live agent requests in the last minute, for idle shutdown. */
  lastActivity(): number;
  close(): Promise<void>;
}

type Principal = { kind: 'hub' } | { kind: 'agent'; address: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const SESSION_META_KEYS = new Set([
  'kind',
  'client',
  'cwd',
  'repo',
  'branch',
  'label',
  'pid',
]);
const MAX_FIELD = 200;
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function printable(value: string): string {
  return value.replace(UNPRINTABLE, '').trim().slice(0, MAX_FIELD);
}

// Known keys only, printable, capped; anything else is dropped.
function sessionMeta(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SESSION_META_KEYS.has(key) || typeof value !== 'string') continue;
    const clean = printable(value);
    if (clean !== '') meta[key] = clean;
  }
  return meta;
}

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const SEEN_WRITE_INTERVAL_MS = 30_000;
const SESSION_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
const ANSWER_WAIT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;

/** Starts a hub on 127.0.0.1 (an ephemeral port unless one is given). */
export async function startHub(opts: HubOptions): Promise<HubHandle> {
  const db = openMessagesDb(join(opts.dir, 'messages.db'));
  const store = new SqliteMessageStore(db);
  const owner = `human:${opts.handle}`;
  const host = new HubHost(store, owner);
  const links = new HubLinks(opts.dir, store);
  const web = new HubWeb(opts.dir, links);
  host.federation = links.hooks();
  const engine = new DeliveryEngine({ store, host });
  links.attach(engine);
  // Signed in to a team: teammates' agents are reachable through it.
  const team =
    opts.team === undefined || opts.team === null
      ? null
      : new TeamLink(opts.team, {
          engine,
          store,
          me: links.replica,
          ownRoster: () => ownRoster() as unknown as RosterAgent[],
          web,
        });
  links.setTeam(team);
  team?.start();

  // One call from this hub to a linked daemon's /api/hub-link/<kind>.
  async function callLink(
    link: HubLink,
    kind: 'mail' | 'state' | 'agents',
    body: unknown
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `http://127.0.0.1:${link.port}/api/hub-link/${kind}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${link.peerToken}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // Every linked daemon hears who the hub's agents are, so it can mirror
  // them and hold each new client to the project's own approval.
  let rosterTimer: ReturnType<typeof setTimeout> | null = null;
  function rosterChanged(): void {
    if (rosterTimer !== null) return;
    rosterTimer = setTimeout(() => {
      rosterTimer = null;
      // A project mirrors only this machine's agents: teammates reach its
      // runs through the team's own federation, not through its gate.
      const own = ownRoster();
      for (const l of links.all()) void callLink(l, 'agents', { agents: own });
      team?.pushRoster();
    }, 200);
  }

  // This machine's own agents: everything but the team's mirrors.
  function ownRoster(): Record<string, unknown>[] {
    return roster().filter((a) => {
      const row = store.getAgent(String(a.address));
      return row !== null && !isTeamRow(row);
    });
  }
  let lastActivity = Date.now();

  const server = createServer((req, res) => {
    lastActivity = Date.now();
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof HttpError)
        return send(res, err.status, { error: err.message, ...err.extra });
      if (err instanceof MessagingError) {
        const status = {
          invalid: 400,
          forbidden: 403,
          'not-found': 404,
          conflict: 409,
          limited: 429,
        }[err.code];
        return send(res, status, {
          error: err.message,
          ...(err.field === undefined ? {} : { field: err.field }),
        });
      }
      send(res, 500, { error: (err as Error).message });
    });
  });

  // Who presented `req`'s bearer: the hub token, an approved agent, or no one.
  function principalOf(req: IncomingMessage): Principal {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token === '')
      throw new HttpError(401, 'unknown token', { code: 'auth_missing_token' });
    if (tokenHash(token) === tokenHash(opts.token)) return { kind: 'hub' };
    const agent = store.agentByTokenHash(tokenHash(token));
    if (agent === null)
      throw new HttpError(401, 'unknown token', { code: 'auth_invalid_token' });
    const parentOff =
      agent.parent !== undefined &&
      store.getAgent(agent.parent)?.status !== 'approved';
    if (agent.status !== 'approved' || parentOff)
      throw new HttpError(401, "this agent's access was revoked", {
        code: 'auth_agent_revoked',
      });
    const now = Date.now();
    if (
      agent.lastSeen === undefined ||
      now - Date.parse(agent.lastSeen) >= SEEN_WRITE_INTERVAL_MS
    )
      store.touchAgent(agent.address, new Date(now).toISOString());
    return { kind: 'agent', address: agent.address };
  }

  function asAgent(req: IncomingMessage): Sender {
    const principal = principalOf(req);
    if (principal.kind !== 'agent')
      throw new HttpError(403, 'the hub token cannot send as anyone', {
        code: 'auth_agent_token_forbidden',
      });
    return { address: principal.address, canDecide: false };
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    if (seg[0] !== 'api') throw new HttpError(404, 'not found');
    const route = `${method} ${seg.slice(1).join('/')}`;

    if (route === 'GET health')
      return send(res, 200, { ok: true, hub: true, id: opts.id });
    if (route === 'GET config')
      return send(res, 200, { messaging: { agentBlockingTimeoutSec: 600 } });

    // The machine-wide web switch (hub/web.ts), for this machine's daemons.
    if (route === 'GET web-access' || route === 'PUT web-access') {
      if (principalOf(req).kind !== 'hub')
        throw new HttpError(403, 'use the hub token');
      if (route === 'PUT web-access') {
        const body = (await readJson(req)) as { enabled?: unknown };
        if (typeof body.enabled !== 'boolean')
          throw new HttpError(400, 'expected { enabled: boolean }');
        web.setEnabled(body.enabled);
      }
      return send(res, 200, { enabled: web.enabled() });
    }

    if (route === 'POST agents/register') {
      if (principalOf(req).kind !== 'hub')
        throw new HttpError(403, 'register with the hub token');
      register(res, await readJson(req));
      rosterChanged();
      return;
    }

    if (route === 'POST link/register') {
      if (principalOf(req).kind !== 'hub')
        throw new HttpError(403, 'link with the hub token');
      const body = (await readJson(req)) as Record<string, unknown>;
      if (
        typeof body.root !== 'string' ||
        typeof body.replica !== 'string' ||
        typeof body.port !== 'number' ||
        typeof body.token !== 'string'
      )
        throw new HttpError(
          400,
          'invalid link: root, replica, port and token are required'
        );
      const link = links.register(
        {
          root: body.root,
          replica: body.replica,
          port: body.port,
          token: body.token,
        },
        (l, kind, payload) => callLink(l, kind, payload)
      );
      void callLink(link, 'agents', { agents: ownRoster() });
      return send(res, 201, { replica: links.replica, token: link.token });
    }
    if (route === 'POST link/mail' || route === 'POST link/state') {
      const header = req.headers.authorization ?? '';
      const link = links.byToken(
        header.startsWith('Bearer ') ? header.slice(7) : ''
      );
      if (link === null)
        throw new HttpError(401, 'unknown link token', {
          code: 'auth_invalid_token',
        });
      const body = await readJson(req);
      if (route === 'POST link/mail') {
        const result = await applyLinkMail(
          engine,
          link.link,
          link.replica,
          body as LinkMail
        );
        return send(res, 200, { status: result.status });
      }
      applyLinkState(engine, store, link.replica, body as LinkState);
      return send(res, 200, { ok: true });
    }
    if (route === 'GET agents/roster') {
      principalOf(req);
      return send(res, 200, { agents: roster() });
    }
    if (route === 'POST agents/me/meta') {
      const sender = asAgent(req);
      const body = (await readJson(req)) as { label?: unknown };
      const label = typeof body.label === 'string' ? printable(body.label) : '';
      if (label === '')
        throw new HttpError(400, 'invalid label: expected a non-empty string', {
          field: 'label',
        });
      const agent = store.getAgent(sender.address)!;
      const meta = { ...agent.meta, label };
      store.putAgent({ ...agent, meta });
      rosterChanged();
      return send(res, 200, { address: agent.address, meta });
    }

    if (route === 'POST messages') {
      const sender = asAgent(req);
      const input = sendInput(await readJson(req));
      refuseUnknownAgents(input.to);
      const project = input.to.find(projectAddress);
      if (
        project !== undefined &&
        input.replyTo === undefined &&
        links.forSender(sender.address) === null
      )
        throw new HttpError(
          400,
          `${project} lives in a project's Dispatch daemon, and none is running for this session's repo; open the project in Dispatch or run dispatch serve`,
          { field: 'to' }
        );
      const idem = req.headers['idempotency-key'];
      const result = await engine.send(
        typeof idem === 'string' ? { ...input, idempotencyKey: idem } : input,
        sender
      );
      return send(res, result.replayed === true ? 200 : 201, result);
    }
    if (method === 'GET' && seg[1] === 'messages' && seg.length === 3) {
      const sender = asAgent(req);
      return send(res, 200, readable(seg[2], sender));
    }
    if (
      method === 'POST' &&
      seg[1] === 'messages' &&
      seg[3] === 'reply' &&
      seg.length === 4
    ) {
      const sender = asAgent(req);
      const body = (await readJson(req)) as Record<string, unknown>;
      if (typeof body.body !== 'string')
        throw new HttpError(400, 'invalid body: expected a string', {
          field: 'body',
        });
      const result = await engine.reply(
        seg[2],
        {
          body: body.body,
          ...(typeof body.choice === 'string' ? { choice: body.choice } : {}),
          ...(Array.isArray(body.refs)
            ? { refs: body.refs as SendInput['refs'] }
            : {}),
          ...(body.data !== undefined
            ? { data: body.data as SendInput['data'] }
            : {}),
          ...(typeof body.session === 'string'
            ? { session: body.session }
            : {}),
        },
        sender
      );
      return send(res, 201, result);
    }
    if (
      method === 'GET' &&
      seg[1] === 'messages' &&
      seg[3] === 'answer' &&
      seg.length === 4
    ) {
      const sender = asAgent(req);
      const question = readable(seg[2], sender);
      const wait = url.searchParams.get('wait') === '1';
      if (wait && question.from !== sender.address)
        throw new HttpError(
          403,
          `only the asker can wait for the answer to ${question.id}`
        );
      return send(res, 200, {
        answer: await answer(question.id, wait, req),
      });
    }

    if (route === 'GET mailbox') {
      const sender = asAgent(req);
      const raw = url.searchParams.get('state');
      const states =
        raw === null
          ? undefined
          : raw
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '');
      if (
        states !== undefined &&
        !states.every((s) => (DELIVERY_STATES as readonly string[]).includes(s))
      )
        throw new HttpError(
          400,
          `invalid state: expected any of ${DELIVERY_STATES.join(',')}`
        );
      const items = engine.inbox(sender.address, states as DeliveryState[]);
      items.sort((a, b) => a.delivery.id.localeCompare(b.delivery.id));
      return send(res, 200, { items });
    }
    if (
      method === 'POST' &&
      seg[1] === 'deliveries' &&
      seg[3] === 'read' &&
      seg.length === 4
    ) {
      const sender = asAgent(req);
      const delivery = store.getDelivery(seg[2]);
      if (delivery === null || delivery.recipient !== sender.address)
        throw new HttpError(404, `no delivery ${seg[2]}`);
      return send(res, 200, engine.markRead(seg[2]));
    }
    if (method === 'GET' && seg[1] === 'threads' && seg.length === 3) {
      const sender = asAgent(req);
      if (!engine.canReadThread(seg[2], sender))
        throw new HttpError(404, `no message ${seg[2]}`);
      return send(res, 200, engine.thread(seg[2]));
    }

    if (route === 'GET channels') {
      const sender = asAgent(req);
      return send(res, 200, { channels: channels(sender.address, url) });
    }
    if (seg[1] === 'channels' && seg[3] === 'members') {
      const sender = asAgent(req);
      const name = seg[2];
      if (method === 'POST' && seg.length === 4) {
        const body = (await readJson(req)) as { member?: unknown };
        const member =
          typeof body.member === 'string' ? body.member : sender.address;
        if (member !== sender.address)
          throw new HttpError(403, `cannot add ${member} to ${name}`);
        engine.join(name, member);
        res.writeHead(204).end();
        return;
      }
      if (method === 'DELETE' && (seg.length === 4 || seg.length === 5)) {
        const member = seg[4] ?? sender.address;
        if (member !== sender.address)
          throw new HttpError(403, `cannot remove ${member} from ${name}`);
        if (!engine.leave(name, member))
          throw new HttpError(404, `${member} is not a member of ${name}`);
        res.writeHead(204).end();
        return;
      }
    }
    throw new HttpError(404, `no route ${method} ${url.pathname}`);
  }

  // A client identity (approved at once: same OS user) or a session under one.
  function register(res: ServerResponse, raw: unknown): void {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string' || typeof body.client !== 'string')
      throw new HttpError(
        400,
        'invalid registration: name and client are required'
      );
    const name = normalizeAgentName(printable(body.name));
    const client = printable(body.client);
    if (!HANDLE_PATTERN.test(name) || name.startsWith('a2a.'))
      throw new HttpError(400, `invalid name: ${body.name}`);
    const now = new Date().toISOString();
    const token = randomBytes(32).toString('hex');

    if (body.parent === undefined) {
      const address = `agent:${opts.handle}/${name}`;
      // A teammate's mirror never holds a name here: registering locally
      // takes it over (the team then mirrors this machine's agent instead).
      const existing = localRow(store.getAgent(address));
      // A name already held is refused, so racing registrations cannot rotate
      // each other's key; an explicit re-key rotates it and retires every
      // session the old key vouched for.
      if (existing !== null && body.rekey !== true)
        throw new HttpError(409, `${address} is already registered`);
      if (existing !== null)
        for (const a of store.agents())
          if (a.parent === address && a.status !== 'revoked')
            store.putAgent({ ...a, status: 'revoked' });
      store.putAgent({
        address,
        displayName: printable(body.name),
        client,
        tokenHash: tokenHash(token),
        status: 'approved',
        muted: existing?.muted ?? false,
        approvedBy: owner,
        createdAt: existing?.createdAt ?? now,
        lastSeen: now,
      });
      return send(res, 201, { address, token, status: 'approved' });
    }

    if (typeof body.parent !== 'string' || typeof body.parentToken !== 'string')
      throw new HttpError(
        400,
        'invalid parent: parent and parentToken are required'
      );
    const parent = store.getAgent(body.parent);
    if (parent === null || parent.tokenHash !== tokenHash(body.parentToken))
      throw new HttpError(403, `parentToken does not match ${body.parent}`);
    if (parent.parent !== undefined)
      throw new HttpError(400, 'invalid parent: a session cannot be a parent');
    if (parent.status !== 'approved')
      throw new HttpError(403, `parent ${parent.address} is not approved`);
    const address = `agent:${opts.handle}/${name}`;
    const existing = localRow(store.getAgent(address));
    if (existing !== null && existing.parent !== parent.address)
      throw new HttpError(409, `${address} is already registered`);
    if (existing?.status === 'revoked')
      throw new HttpError(409, `${address} was revoked; start a new session`);
    store.putAgent({
      address,
      displayName: printable(body.name),
      client,
      tokenHash: tokenHash(token),
      status: 'approved',
      muted: parent.muted || (existing?.muted ?? false),
      approvedBy: parent.address,
      createdAt: existing?.createdAt ?? now,
      parent: parent.address,
      meta: sessionMeta(body.meta),
      lastSeen: now,
    });
    send(res, 201, { address, token, status: 'approved' });
  }

  function roster(): Record<string, unknown>[] {
    const now = Date.now();
    return store.agents().map((a: AgentRecord) => ({
      address: a.address,
      displayName: a.displayName,
      client: a.client,
      status: a.status,
      muted: a.muted,
      approvedBy: a.approvedBy,
      createdAt: a.createdAt,
      ...(a.parent === undefined ? {} : { parent: a.parent }),
      ...(a.meta === undefined ? {} : { meta: a.meta }),
      ...(a.lastSeen === undefined ? {} : { lastSeen: a.lastSeen }),
      online:
        a.lastSeen !== undefined &&
        now - Date.parse(a.lastSeen) <= ONLINE_WINDOW_MS,
    }));
  }

  // Mail to an agent nobody registered would wait forever: refuse it.
  function refuseUnknownAgents(to: string[]): void {
    const unknown = to.find((addr) => {
      if (!addr.startsWith('agent:') || addr === SYSTEM_ADDRESS) return false;
      return store.getAgent(addr)?.status !== 'approved';
    });
    if (unknown !== undefined)
      throw new HttpError(
        400,
        `no agent ${unknown} is registered on this machine; agent_list lists who is`,
        { field: 'to' }
      );
  }

  // A message the sender may read; any other id answers as absent.
  function readable(id: string, sender: Sender): Message {
    const message = engine.getMessage(id);
    if (message === null || !engine.canRead(id, sender))
      throw new HttpError(404, `no message ${id}`);
    return message;
  }

  function answer(
    id: string,
    wait: boolean,
    req: IncomingMessage
  ): Promise<Message | null> {
    const existing = engine.answerOf(id);
    if (existing !== null || !wait) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let done = false;
      const finish = (a: Message | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(a);
      };
      const unsubscribe = engine.subscribe((e) => {
        if (
          e.type === 'message' &&
          e.message.replyTo === id &&
          e.message.kind === 'answer'
        )
          finish(e.message);
      });
      const timer = setTimeout(() => finish(null), ANSWER_WAIT_MS);
      req.on('close', () => finish(null));
    });
  }

  // Joined channels, plus one implicit `repo/<name>` per repo a session
  // reported; `member=me` keeps those the caller is in.
  function channels(member: string, url: URL): Record<string, unknown>[] {
    const repos = new Set(
      store
        .agents()
        .map((a) => a.meta?.repo)
        .filter((r): r is string => r !== undefined)
    );
    const listed = [
      ...store.channels().map((c) => ({
        name: c.name,
        auto: c.auto,
        members: store.members(c.name),
      })),
      ...[...repos].map((repo) => ({
        name: `repo/${repo}`,
        auto: true,
        members: host.implicitMembers(`repo/${repo}`),
      })),
    ];
    return url.searchParams.get('member') === 'me'
      ? listed.filter((c) => c.members.includes(member))
      : listed;
  }

  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const a of store.agents())
        if (
          a.parent !== undefined &&
          now - Date.parse(a.lastSeen ?? a.createdAt) > SESSION_MAX_IDLE_MS
        )
          store.deleteAgent(a.address);
    },
    60 * 60 * 1000
  );
  sweep.unref();

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, '127.0.0.1', resolve)
  );
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    server,
    store,
    engine,
    lastActivity: () => lastActivity,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        if (rosterTimer !== null) clearTimeout(rosterTimer);
        links.close();
        team?.stop();
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

// A row this machine owns, or null for none or for the team's mirror of an
// agent homed elsewhere, which a local registration replaces.
function localRow(row: AgentRecord | null): AgentRecord | null {
  return row === null || isTeamRow(row) ? null : row;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

// The send fields the engine takes, each type-checked; the engine validates
// the rest (kinds, addresses, choices, gates).
function sendInput(raw: unknown): SendInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(body.to) ||
    !body.to.every((t): t is string => typeof t === 'string')
  )
    throw new HttpError(400, 'invalid to: expected a list of addresses', {
      field: 'to',
    });
  if (typeof body.kind !== 'string' || typeof body.body !== 'string')
    throw new HttpError(400, 'invalid message: kind and body are required');
  const input: SendInput = {
    to: body.to,
    kind: body.kind as SendInput['kind'],
    body: body.body,
  };
  if (Array.isArray(body.refs)) input.refs = body.refs as SendInput['refs'];
  if (body.data !== undefined) input.data = body.data as SendInput['data'];
  if (typeof body.urgent === 'boolean') input.urgent = body.urgent;
  if (typeof body.blocking === 'boolean') input.blocking = body.blocking;
  if (Array.isArray(body.choices))
    input.choices = body.choices.filter(
      (c): c is string => typeof c === 'string'
    );
  if (typeof body.replyTo === 'string') input.replyTo = body.replyTo;
  if (body.wake === 'none' || body.wake === 'request') input.wake = body.wake;
  if (typeof body.session === 'string') input.session = body.session;
  return input;
}
