import { DaemonUnavailableError } from '../errors.js';
import type {
  Admission,
  AuthResult,
  BridgePort,
  Caller,
  CardInputs,
  ContinueInput,
  ContinueResult,
  ListPage,
  ListQuery,
  OpenInput,
  OpenResult,
  TaskFacts,
} from '../port.js';
import { isEventStream } from '../sig/fetch.js';
import type { ReceivedRequest } from '../sig/verify.js';
import { forwardedHeaders, PORT_CLIENT_HEADER, portErrorFrom } from './wire.js';

export interface HttpBridgePortOptions {
  daemonUrl: string;
  hostToken: string;
  // This host's own public URL: its card is built for it, never for anything
  // a request says.
  publicUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  reconnectMs?: number;
}

// The 700 s call timeout covers the longest legitimate call, a blocking open
// that waits blockingWaitSec <= 600 s, plus margin.
const CALL_TIMEOUT_MS = 700_000;

// Resolves after `ms`, or at once when `signal` aborts; no listener outlives it.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// BridgePort over dispatchd's /api/a2a/port/* (spec:1666-1709): the host token
// in Authorization, the client's bearer in X-A2A-Client-Authorization, and the
// daemon's a2a.db as the only store. No push configs on a standalone host.
export class HttpBridgePort implements BridgePort {
  constructor(private readonly o: HttpBridgePortOptions) {}

  private headers(
    caller: Caller | null,
    json: boolean
  ): Record<string, string> {
    return {
      authorization: `Bearer ${this.o.hostToken}`,
      ...(caller?.credential === undefined
        ? {}
        : {
            // A signed client's credential is already a session header value.
            [PORT_CLIENT_HEADER]: caller.credential.startsWith('Signed ')
              ? caller.credential
              : `Bearer ${caller.credential}`,
          }),
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  private async call<T>(
    method: string,
    path: string,
    caller: Caller | null,
    body?: unknown
  ): Promise<T> {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(
        `${this.o.daemonUrl}/api/a2a/port${path}`,
        {
          method,
          headers: this.headers(caller, body !== undefined),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.o.timeoutMs ?? CALL_TIMEOUT_MS),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
      );
    } catch {
      // Down, refusing or timed out: the client should retry, not see a fault.
      throw new DaemonUnavailableError();
    }
    const parsed: unknown =
      res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw portErrorFrom(res.status, parsed);
    return parsed as T;
  }

  // A Dispatch-signed request, verified by the daemon against this host's
  // pinned URL; the daemon answers with a session for the request's calls.
  async authenticateSigned(req: ReceivedRequest): Promise<AuthResult | null> {
    if (!req.headers.has('signature-input')) return null;
    return this.call<AuthResult | null>('POST', '/authenticate-signed', null, {
      method: req.method,
      path: req.path,
      query: req.query,
      headers: forwardedHeaders(req.headers),
      body: req.body === null ? null : Buffer.from(req.body).toString('base64'),
    });
  }

  // A pairing proof: the daemon completes it and signs the reply for this
  // host's pinned URL; the host relays the reply as given.
  async pair(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    let out: { status: number; headers: Record<string, string>; body: string };
    try {
      out = await this.call<typeof out>('POST', '/pair', null, {
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: forwardedHeaders(req.headers),
        body: Buffer.from(body).toString('base64'),
      });
    } catch {
      return new Response('unavailable', { status: 503 });
    }
    return new Response(Buffer.from(out.body, 'base64'), {
      status: out.status,
      headers: out.headers,
    });
  }

  async revalidate(caller: Caller): Promise<boolean> {
    const result = await this.call<AuthResult>('GET', '/whoami', caller);
    return result.ok && result.caller.address === caller.address;
  }

  // The daemon holds the card key, so it signs this host's reply for the
  // host's pinned URL; a stream is signed over its headers.
  async signResponse(
    res: Response,
    req: Request,
    caller: Caller
  ): Promise<Response> {
    const stream = isEventStream(res.headers);
    const bytes = stream ? null : new Uint8Array(await res.arrayBuffer());
    const url = new URL(req.url);
    const out = await this.call<{ headers: Record<string, string> }>(
      'POST',
      '/sign-response',
      caller,
      {
        status: res.status,
        contentType: res.headers.get('content-type'),
        body: bytes === null ? null : Buffer.from(bytes).toString('base64'),
        request: {
          method: req.method,
          path: url.pathname,
          query: url.search,
          headers: forwardedHeaders(req.headers),
        },
      }
    );
    const headers = new Headers(res.headers);
    for (const [name, value] of Object.entries(out.headers))
      headers.set(name, value);
    return new Response(stream ? res.body : bytes, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  async authenticate(bearer: string): Promise<AuthResult> {
    const result = await this.call<AuthResult>('GET', '/whoami', {
      address: '',
      name: '',
      credential: bearer,
    });
    return result.ok
      ? { ok: true, caller: { ...result.caller, credential: bearer } }
      : result;
  }

  async admit(caller: Caller, what: 'request' | 'stream'): Promise<Admission> {
    const result = await this.call<
      { ok: true; lease?: string } | { ok: false; retryAfterSec: number }
    >('POST', '/admit', caller, { what });
    if (!result.ok) return result;
    const lease = result.lease;
    if (lease === undefined) return { ok: true };
    return {
      ok: true,
      release: () => {
        this.call(
          'DELETE',
          `/admit/${encodeURIComponent(lease)}`,
          caller
        ).catch(() => undefined);
      },
    };
  }

  async card(): Promise<CardInputs> {
    const query = new URLSearchParams({ publicUrl: this.o.publicUrl });
    const inputs = await this.call<CardInputs>(
      'GET',
      `/card?${query.toString()}`,
      null
    );
    return {
      ...inputs,
      publicUrl: this.o.publicUrl,
      pushNotifications: false,
    };
  }

  open(caller: Caller, input: OpenInput): Promise<OpenResult> {
    return this.call('POST', '/open', caller, input);
  }

  continue(caller: Caller, input: ContinueInput): Promise<ContinueResult> {
    return this.call('POST', '/continue', caller, input);
  }

  async cancel(caller: Caller, taskId: string): Promise<void> {
    await this.call('POST', '/cancel', caller, { taskId });
  }

  async facts(caller: Caller, taskId: string): Promise<TaskFacts | null> {
    try {
      return await this.call<TaskFacts>(
        'GET',
        `/tasks/${encodeURIComponent(taskId)}`,
        caller
      );
    } catch (err) {
      if ((err as { reason?: string }).reason === 'TASK_NOT_FOUND') return null;
      throw err;
    }
  }

  list(caller: Caller, q: ListQuery): Promise<ListPage> {
    const params = new URLSearchParams({ pageSize: String(q.pageSize) });
    for (const key of ['contextId', 'state', 'after', 'pageToken'] as const) {
      const value = q[key];
      if (value !== undefined) params.set(key, value);
    }
    return this.call('GET', `/tasks?${params.toString()}`, caller);
  }

  // SSE change signals, reconnecting with backoff; after any gap it signals
  // once more, since a change may have been missed (spec:1702-1703).
  watch(caller: Caller, taskId: string, onChange: () => void): () => void {
    const ac = new AbortController();
    const url = `${this.o.daemonUrl}/api/a2a/port/tasks/${encodeURIComponent(taskId)}/watch`;
    const first = this.o.reconnectMs ?? 1000;
    void (async () => {
      let backoff = first;
      while (!ac.signal.aborted) {
        try {
          const res = await (this.o.fetchImpl ?? fetch)(url, {
            headers: this.headers(caller, false),
            redirect: 'manual',
            signal: ac.signal,
          });
          if (res.status === 401 || res.status === 403 || res.status === 404)
            return;
          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            if (reader === undefined) break;
            const next = (await reader.read()) as
              | { done: true; value?: undefined }
              | { done: false; value: Uint8Array };
            if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true });
            for (
              let i = buffer.indexOf('\n\n');
              i !== -1;
              i = buffer.indexOf('\n\n')
            ) {
              if (buffer.slice(0, i).startsWith('data:')) onChange();
              buffer = buffer.slice(i + 2);
            }
            backoff = first;
          }
        } catch {
          if (ac.signal.aborted) return;
        }
        await pause(backoff, ac.signal);
        backoff = Math.min(backoff * 2, 30_000);
        if (!ac.signal.aborted) onChange();
      }
    })();
    return () => ac.abort();
  }
}
