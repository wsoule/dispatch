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
import { PORT_CLIENT_HEADER, portErrorFrom } from './wire.js';

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
        : { [PORT_CLIENT_HEADER]: `Bearer ${caller.credential}` }),
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  private async call<T>(
    method: string,
    path: string,
    caller: Caller | null,
    body?: unknown
  ): Promise<T> {
    const res = await (this.o.fetchImpl ?? fetch)(
      `${this.o.daemonUrl}/api/a2a/port${path}`,
      {
        method,
        headers: this.headers(caller, body !== undefined),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? CALL_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );
    const parsed: unknown =
      res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw portErrorFrom(res.status, parsed);
    return parsed as T;
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
