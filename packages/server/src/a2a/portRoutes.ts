import type {
  AuthResult,
  HostRow,
  ListQuery,
  ReceivedRequest,
  TaskStateName,
} from '@dispatch/a2a';
import {
  FORWARDED_SIGNATURE_HEADERS,
  parsePortContinue,
  parsePortOpen,
  PORT_CLIENT_HEADER,
  portErrorJson,
} from '@dispatch/a2a';
import { MessagingError } from '@dispatch/protocol';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { ApiContext } from '../api.js';
import { jsonResponse, readJsonBody } from '../api/http.js';
import { authenticateHost, hostPublicUrl } from './hosts.js';

// Stream slots a standalone host holds, each released by that host's DELETE,
// by its revocation, or, if the host dies, when the lease expires (D30).
export class PortLeases {
  private readonly leases = new Map<
    string,
    {
      release: () => void;
      hostId: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private readonly ttlMs = 65 * 60_000) {}

  hold(release: () => void, hostId: string): string {
    const id = `l-${randomUUID()}`;
    const timer = setTimeout(() => this.release(id), this.ttlMs);
    timer.unref();
    this.leases.set(id, { release, hostId, timer });
    return id;
  }

  // Ends a lease only for the host that took it.
  end(id: string, hostId: string): boolean {
    return this.leases.get(id)?.hostId === hostId && this.release(id);
  }

  endHost(hostId: string): void {
    for (const [id, lease] of [...this.leases])
      if (lease.hostId === hostId) this.release(id);
  }

  closeAll(): void {
    for (const id of [...this.leases.keys()]) this.release(id);
  }

  private release(id: string): boolean {
    const lease = this.leases.get(id);
    if (lease === undefined) return false;
    clearTimeout(lease.timer);
    this.leases.delete(id);
    lease.release();
    return true;
  }
}

// A signed client's session on one host: who signed, with which key, and the
// hash of the request signature it was opened with.
export interface SignedSession {
  hostId: string;
  address: string;
  keyid: string;
  signatureHash: string;
}

// Short-lived stand-ins for a signed client's bearer across one host's port
// calls: the host verified nothing itself, so each session is bound to the
// host that opened it and re-checked against the client row and its key on
// every use.
export class SignedSessions {
  private readonly sessions = new Map<
    string,
    SignedSession & { expiresAt: number }
  >();
  constructor(
    private readonly ttlMs = 65 * 60_000,
    private readonly now = () => Date.now()
  ) {}

  open(session: SignedSession): string {
    this.prune();
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, {
      ...session,
      expiresAt: this.now() + this.ttlMs,
    });
    return token;
  }

  // The session, only for the host that opened it.
  resolve(token: string, hostId: string): SignedSession | null {
    this.prune();
    const s = this.sessions.get(token);
    return s === undefined || s.hostId !== hostId ? null : s;
  }

  endHost(hostId: string): void {
    for (const [token, s] of [...this.sessions])
      if (s.hostId === hostId) this.sessions.delete(token);
  }

  closeAll(): void {
    this.sessions.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [token, s] of [...this.sessions])
      if (s.expiresAt <= now) this.sessions.delete(token);
  }
}

// The hash a session keeps of the request signature it was opened with.
function signatureHash(signature: string | null): string {
  return createHash('sha256')
    .update(signature ?? '')
    .digest('hex');
}

export interface WatchLimits {
  keepaliveMs: number;
  maxMs: number;
  perHost: number;
}

const WATCH_LIMITS: WatchLimits = {
  keepaliveMs: 15_000,
  maxMs: 60 * 60_000,
  perHost: 64,
};

// The task-watch streams standalone hosts hold: capped per host, re-checked
// at every keepalive, and closed at once when their host loses access.
export class PortWatches {
  private readonly live = new Map<string, Set<() => void>>();
  private readonly limits: WatchLimits;
  constructor(limits: Partial<WatchLimits> = {}) {
    this.limits = { ...WATCH_LIMITS, ...limits };
  }

  // An SSE stream of `change` events, or null when the host is at its cap.
  // `allowed` false (or throwing) at a keepalive closes the stream.
  open(
    hostId: string,
    subscribe: (onChange: () => void) => () => void,
    allowed: () => Promise<boolean>,
    signal: AbortSignal
  ): Response | null {
    const mine = this.live.get(hostId) ?? new Set<() => void>();
    if (mine.size >= this.limits.perHost) return null;
    this.live.set(hostId, mine);
    const encoder = new TextEncoder();
    let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        const unwatch = subscribe(() => send('data: change\n\n'));
        const keepalive = setInterval(() => {
          allowed().then(
            (ok) => (ok ? send(': keepalive\n\n') : close()),
            () => close()
          );
        }, this.limits.keepaliveMs);
        const expiry = setTimeout(() => close(), this.limits.maxMs);
        close = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepalive);
          clearTimeout(expiry);
          unwatch();
          mine.delete(close);
          if (mine.size === 0 && this.live.get(hostId) === mine)
            this.live.delete(hostId);
          signal.removeEventListener('abort', close);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        mine.add(close);
        signal.addEventListener('abort', close, { once: true });
        // Bun sends the headers with the first chunk.
        send(': watching\n\n');
      },
      cancel: () => close(),
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  }

  closeHost(hostId: string): void {
    for (const close of [...(this.live.get(hostId) ?? [])]) close();
  }

  closeAll(): void {
    for (const hostId of [...this.live.keys()]) this.closeHost(hostId);
  }
}

function bearerOf(value: string | null): string | null {
  return /^Bearer[ ]+(\S+)$/i.exec((value ?? '').trim())?.[1] ?? null;
}

const notFound = () => jsonResponse({ error: 'not found' }, 404);
const taskNotFound = () =>
  jsonResponse(
    {
      error: {
        kind: 'a2a',
        reason: 'TASK_NOT_FOUND',
        message: 'task not found',
      },
    },
    404
  );

const NO_CLIENT: Extract<AuthResult, { ok: false }> = {
  ok: false,
  status: 401,
  reason: 'AUTH_MISSING_TOKEN',
  message: 'no client credential forwarded',
};

// The client a host forwards: a bearer, or a session from a signature this
// daemon verified for that same host, re-checked against the key it proved.
async function clientAuth(
  header: string | null,
  bridge: NonNullable<ApiContext['a2a']>,
  hostId: string
): Promise<{ auth: AuthResult; session: SignedSession | null }> {
  const port = bridge.port;
  if (port === null || header === null)
    return { auth: NO_CLIENT, session: null };
  const token = /^Signed[ ]+(\S+)$/.exec(header.trim())?.[1];
  if (token !== undefined) {
    const session = bridge.signedSessions.resolve(token, hostId);
    if (session === null)
      return {
        auth: {
          ...NO_CLIENT,
          reason: 'AUTH_INVALID_TOKEN',
          message: 'unknown token',
        },
        session: null,
      };
    return {
      auth: await port.authenticateSignedAddress(
        session.address,
        session.keyid
      ),
      session,
    };
  }
  const bearer = bearerOf(header);
  return {
    auth: bearer === null ? NO_CLIENT : await port.authenticate(bearer),
    session: null,
  };
}

// What a host forwards of a signed request it received, checked field by field.
function forwardedRequest(raw: unknown): ReceivedRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.method !== 'string' ||
    typeof r.path !== 'string' ||
    typeof r.query !== 'string' ||
    typeof r.headers !== 'object' ||
    r.headers === null ||
    (r.body !== null && typeof r.body !== 'string')
  )
    return null;
  const headers = new Headers();
  for (const name of FORWARDED_SIGNATURE_HEADERS) {
    const value = (r.headers as Record<string, unknown>)[name];
    if (typeof value === 'string' && value !== '') headers.set(name, value);
  }
  let body: Uint8Array | null = null;
  if (typeof r.body === 'string') {
    const bytes = Buffer.from(r.body, 'base64');
    if (bytes.toString('base64') !== r.body || bytes.length > 256 * 1024)
      return null;
    body = new Uint8Array(bytes);
  }
  return { method: r.method, path: r.path, query: r.query, headers, body };
}

// POST /api/a2a/port/authenticate-signed: verifies the client's signature
// against the host's pinned URL, the one the client was told to call, and
// opens a session that stands in for the client's bearer on this host only.
async function authenticateForwarded(
  req: Request,
  bridge: NonNullable<ApiContext['a2a']>,
  host: HostRow
): Promise<Response> {
  const parsed = await readJsonBody(req);
  const forwarded = parsed.ok ? forwardedRequest(parsed.value) : null;
  if (forwarded === null || bridge.port === null)
    return jsonResponse(
      {
        error: {
          kind: 'messaging',
          code: 'invalid',
          message: 'body: expected the forwarded request',
          field: 'body',
        },
      },
      400
    );
  const result = await bridge.port.authenticateSignedAt(
    forwarded,
    host.publicUrl
  );
  // No Dispatch signature: the host falls back to the client's bearer.
  if (result === null) return jsonResponse(null);
  if (!result.ok || result.caller.keyid === undefined)
    return jsonResponse(result);
  const token = bridge.signedSessions.open({
    hostId: host.id,
    address: result.caller.address,
    keyid: result.caller.keyid ?? '',
    signatureHash: signatureHash(forwarded.headers.get('signature')),
  });
  return jsonResponse({
    ok: true,
    caller: { ...result.caller, credential: `Signed ${token}` },
  } satisfies AuthResult);
}

const PATH = /^\/[^?#]*$/;
const QUERY = /^(?:\?[^#]*)?$/;
const MAX_SIGNED_BODY = 4 * 1024 * 1024;

// POST /api/a2a/port/sign-response: the card key stays with the daemon, so it
// signs a host's reply to a signed client, for the host's pinned URL, only
// within that client's session and for the request it was opened with. The
// host is the trusted responder for its URL: it terminates TLS and chooses the
// reply, so a peer that trusts the signature trusts the host as well.
function signForHost(
  raw: unknown,
  port: NonNullable<NonNullable<ApiContext['a2a']>['port']>,
  host: HostRow,
  session: SignedSession | null
): Response {
  const invalid = (message: string) =>
    jsonResponse(
      { error: { kind: 'messaging', code: 'invalid', message, field: 'body' } },
      400
    );
  if (session === null)
    return jsonResponse(
      {
        error: {
          kind: 'auth',
          status: 403,
          reason: 'AUTH_NOT_SIGNED',
          message: 'only a signed client’s reply is signed',
        },
      },
      403
    );
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return invalid('body: expected an object');
  const r = raw as Record<string, unknown>;
  const request = forwardedRequest({ ...(r.request as object), body: null });
  if (
    typeof r.status !== 'number' ||
    !Number.isInteger(r.status) ||
    r.status < 100 ||
    r.status > 599 ||
    (r.contentType !== null && typeof r.contentType !== 'string') ||
    (r.body !== null && typeof r.body !== 'string') ||
    request === null ||
    !PATH.test(request.path) ||
    !QUERY.test(request.query)
  )
    return invalid('body: expected the reply and the request it answers');
  // Only the reply to the request this session was opened with (review N2).
  if (signatureHash(request.headers.get('signature')) !== session.signatureHash)
    return jsonResponse(
      {
        error: {
          kind: 'auth',
          status: 403,
          reason: 'AUTH_NOT_SIGNED',
          message: 'not the request this session was opened with',
        },
      },
      403
    );
  let body: Uint8Array | null = null;
  if (typeof r.body === 'string') {
    const bytes = Buffer.from(r.body, 'base64');
    if (bytes.toString('base64') !== r.body || bytes.length > MAX_SIGNED_BODY)
      return invalid('body: not base64, or too large');
    body = new Uint8Array(bytes);
  }
  const headers = new Headers(
    typeof r.contentType === 'string' ? { 'content-type': r.contentType } : {}
  );
  const origin = new URL(host.publicUrl).origin;
  const signed = port.signFor(
    { status: r.status, headers, body },
    {
      method: request.method,
      targetUri: `${origin}${request.path}${request.query}`,
      headers: request.headers,
    }
  );
  if (signed === null)
    return jsonResponse(
      {
        error: {
          kind: 'messaging',
          code: 'conflict',
          message: 'card signing is off on the daemon',
        },
      },
      409
    );
  return jsonResponse({ headers: signed });
}

// /api/a2a/port/* (spec:1666-1709): dark unless standalone hosts are allowed;
// a host token is the only credential that opens it (agent, run and teammate
// tokens are not host tokens), then the A2A client that host forwards.
export async function handlePortRoute(
  req: Request,
  ctx: ApiContext,
  rest: string[],
  method: string
): Promise<Response> {
  const bridge = ctx.a2a;
  if (bridge === undefined || bridge.port === null || !bridge.standalone())
    return notFound();
  const hostToken = bearerOf(req.headers.get('authorization'));
  const host = authenticateHost(bridge.store, hostToken);
  if (host === null) {
    return jsonResponse(
      {
        error: {
          kind: 'auth',
          status: 401,
          reason: 'AUTH_INVALID_HOST',
          message: 'unknown host token',
        },
      },
      401
    );
  }
  const port = bridge.port;
  const url = new URL(req.url);
  if (rest[0] === 'card' && rest.length === 1 && method === 'GET') {
    // The card is built for the URL pinned at minting, and no other.
    const asked = url.searchParams.get('publicUrl');
    if (asked !== null && hostPublicUrl(asked) !== host.publicUrl)
      return jsonResponse(
        {
          error: {
            kind: 'messaging',
            code: 'forbidden',
            message: 'publicUrl: not the URL this host was added with',
            field: 'publicUrl',
          },
        },
        403
      );
    return jsonResponse(
      await port.card({ publicUrl: host.publicUrl, standalone: true })
    );
  }
  // A lease is the host's own: releasing it needs no client, so a client
  // whose token rotated cannot strand its slots.
  if (rest[0] === 'admit' && rest.length === 2 && method === 'DELETE')
    return bridge.leases.end(decodeURIComponent(rest[1]), host.id)
      ? new Response(null, { status: 204 })
      : notFound();
  if (
    rest[0] === 'authenticate-signed' &&
    rest.length === 1 &&
    method === 'POST'
  )
    return authenticateForwarded(req, bridge, host);
  const clientHeader = req.headers.get(PORT_CLIENT_HEADER);
  const resolveClient = async (): Promise<AuthResult> =>
    (await clientAuth(clientHeader, bridge, host.id)).auth;
  const { auth, session } = await clientAuth(clientHeader, bridge, host.id);
  if (rest[0] === 'whoami' && rest.length === 1 && method === 'GET')
    return jsonResponse(auth);
  if (!auth.ok)
    return jsonResponse(
      {
        error: {
          kind: 'auth',
          status: auth.status,
          reason: auth.reason,
          message: auth.message,
        },
      },
      auth.status
    );
  const caller = auth.caller;
  try {
    // Every refusal crosses as a PortError, so the host rebuilds it as a 400.
    const raw = async (): Promise<unknown> => {
      const parsed = await readJsonBody(req);
      if (!parsed.ok)
        throw new MessagingError(
          'invalid',
          'body: expected a JSON object',
          'body'
        );
      return parsed.value;
    };
    const body = async (): Promise<Record<string, unknown>> => {
      const value = await raw();
      if (Array.isArray(value))
        throw new MessagingError(
          'invalid',
          'body: expected a JSON object',
          'body'
        );
      return value as Record<string, unknown>;
    };
    if (rest[0] === 'admit' && rest.length === 1 && method === 'POST') {
      const { what } = await body();
      const admitted = await port.admit(
        caller,
        what === 'stream' ? 'stream' : 'request'
      );
      if (!admitted.ok) return jsonResponse(admitted);
      return jsonResponse(
        admitted.release === undefined
          ? { ok: true }
          : {
              ok: true,
              lease: bridge.leases.hold(admitted.release, host.id),
            }
      );
    }
    if (rest[0] === 'open' && rest.length === 1 && method === 'POST')
      return jsonResponse(await port.open(caller, parsePortOpen(await raw())));
    if (rest[0] === 'continue' && rest.length === 1 && method === 'POST')
      return jsonResponse(
        await port.continue(caller, parsePortContinue(await raw()))
      );
    if (rest[0] === 'sign-response' && rest.length === 1 && method === 'POST')
      return signForHost(await raw(), port, host, session);
    if (rest[0] === 'cancel' && rest.length === 1 && method === 'POST') {
      const { taskId } = await body();
      if (typeof taskId !== 'string') return taskNotFound();
      await port.cancel(caller, taskId);
      return new Response(null, { status: 204 });
    }
    if (rest[0] === 'tasks' && rest.length === 1 && method === 'GET') {
      const size = Number(url.searchParams.get('pageSize') ?? '50');
      const q: ListQuery = {
        pageSize: Number.isInteger(size) && size > 0 ? Math.min(size, 100) : 50,
      };
      for (const key of ['contextId', 'after', 'pageToken'] as const) {
        const value = url.searchParams.get(key);
        if (value !== null) q[key] = value;
      }
      const state = url.searchParams.get('state');
      if (state !== null) q.state = state as TaskStateName;
      return jsonResponse(await port.list(caller, q));
    }
    if (rest[0] === 'tasks' && rest.length === 2 && method === 'GET') {
      const facts = await port.facts(caller, decodeURIComponent(rest[1]));
      return facts === null ? taskNotFound() : jsonResponse(facts);
    }
    if (
      rest[0] === 'tasks' &&
      rest.length === 3 &&
      rest[2] === 'watch' &&
      method === 'GET'
    ) {
      const id = decodeURIComponent(rest[1]);
      if ((await port.facts(caller, id)) === null) return taskNotFound();
      // Re-checked at each keepalive: the host, the switch, and the client.
      const allowed = async () => {
        if (!bridge.standalone()) return false;
        if (authenticateHost(bridge.store, hostToken)?.id !== host.id)
          return false;
        const again = await resolveClient();
        return again.ok && again.caller.address === caller.address;
      };
      return (
        bridge.watches.open(
          host.id,
          (onChange) => port.watch(caller, id, onChange),
          allowed,
          req.signal
        ) ??
        jsonResponse(
          {
            error: {
              kind: 'messaging',
              code: 'limited',
              message: 'too many watch streams open for this host',
            },
          },
          429
        )
      );
    }
    return notFound();
  } catch (err) {
    if (err instanceof Response) return err;
    const { status, body } = portErrorJson(err);
    return jsonResponse(body, status);
  }
}
