import type {
  AuthResult,
  BridgePort,
  Caller,
  ContinueInput,
  ListQuery,
  OpenInput,
  TaskStateName,
} from '@dispatch/a2a';
import {
  isLoopbackHost,
  PORT_CLIENT_HEADER,
  portErrorJson,
} from '@dispatch/a2a';
import { randomUUID } from 'node:crypto';

import type { ApiContext } from '../api.js';
import { jsonResponse, readJsonBody } from '../api/http.js';
import { authenticateHost } from './hosts.js';

const KEEPALIVE_MS = 15_000;

// Stream slots a standalone host holds, each released by DELETE or, if the
// host dies, when the lease expires (Review Focus 1, Decision D30).
export class PortLeases {
  private readonly leases = new Map<
    string,
    { release: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(private readonly ttlMs = 65 * 60_000) {}

  hold(release: () => void): string {
    const id = `l-${randomUUID()}`;
    const timer = setTimeout(() => this.end(id), this.ttlMs);
    timer.unref();
    this.leases.set(id, { release, timer });
    return id;
  }

  end(id: string): boolean {
    const lease = this.leases.get(id);
    if (lease === undefined) return false;
    clearTimeout(lease.timer);
    this.leases.delete(id);
    lease.release();
    return true;
  }

  closeAll(): void {
    for (const id of [...this.leases.keys()]) this.end(id);
  }
}

function bearerOf(value: string | null): string | null {
  return /^Bearer[ ]+(\S+)$/i.exec((value ?? '').trim())?.[1] ?? null;
}

// The public URL a host asks its card for: https, or http on loopback, with
// no credentials or query; anything else is refused.
function hostPublicUrl(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    const plainOk = url.protocol === 'http:' && isLoopbackHost(url.hostname);
    if (url.protocol !== 'https:' && !plainOk) return null;
    if (url.username !== '' || url.password !== '' || url.search !== '')
      return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function watchStream(
  port: BridgePort,
  caller: Caller,
  taskId: string,
  signal: AbortSignal
): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      const unwatch = port.watch(caller, taskId, () =>
        send('data: change\n\n')
      );
      const keepalive = setInterval(
        () => send(': keepalive\n\n'),
        KEEPALIVE_MS
      );
      stop = () => {
        clearInterval(keepalive);
        unwatch();
      };
      signal.addEventListener(
        'abort',
        () => {
          stop();
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
        { once: true }
      );
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
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
  if (
    authenticateHost(
      bridge.store,
      bearerOf(req.headers.get('authorization'))
    ) === null
  ) {
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
    const raw = url.searchParams.get('publicUrl');
    const publicUrl = hostPublicUrl(raw);
    if (raw !== null && publicUrl === null)
      return jsonResponse(
        {
          error: {
            kind: 'messaging',
            code: 'invalid',
            message: 'publicUrl: https, or http on loopback, with no query',
            field: 'publicUrl',
          },
        },
        400
      );
    return jsonResponse(
      await port.card({
        ...(publicUrl === null ? {} : { publicUrl }),
        standalone: true,
      })
    );
  }
  const clientBearer = bearerOf(req.headers.get(PORT_CLIENT_HEADER));
  const auth: AuthResult =
    clientBearer === null
      ? {
          ok: false,
          status: 401,
          reason: 'AUTH_MISSING_TOKEN',
          message: 'no client bearer forwarded',
        }
      : await port.authenticate(clientBearer);
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
    const body = async <T>(): Promise<T> => {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) throw parsed.response;
      return parsed.value as T;
    };
    if (rest[0] === 'admit' && rest.length === 1 && method === 'POST') {
      const { what } = await body<{ what?: unknown }>();
      const admitted = await port.admit(
        caller,
        what === 'stream' ? 'stream' : 'request'
      );
      if (!admitted.ok) return jsonResponse(admitted);
      return jsonResponse(
        admitted.release === undefined
          ? { ok: true }
          : { ok: true, lease: bridge.leases.hold(admitted.release) }
      );
    }
    if (rest[0] === 'admit' && rest.length === 2 && method === 'DELETE') {
      bridge.leases.end(rest[1]);
      return new Response(null, { status: 204 });
    }
    if (rest[0] === 'open' && rest.length === 1 && method === 'POST')
      return jsonResponse(await port.open(caller, await body<OpenInput>()));
    if (rest[0] === 'continue' && rest.length === 1 && method === 'POST')
      return jsonResponse(
        await port.continue(caller, await body<ContinueInput>())
      );
    if (rest[0] === 'cancel' && rest.length === 1 && method === 'POST') {
      const { taskId } = await body<{ taskId?: unknown }>();
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
      return watchStream(port, caller, id, req.signal);
    }
    return notFound();
  } catch (err) {
    if (err instanceof Response) return err;
    const { status, body } = portErrorJson(err);
    return jsonResponse(body, status);
  }
}
