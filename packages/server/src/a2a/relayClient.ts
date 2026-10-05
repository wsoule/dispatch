import type { HostRow, RelayToDaemon } from '@dispatch/a2a';
import {
  answerChallenge,
  ecThumbprint,
  isEventStream,
  MAX_FRAME_BODY,
  parseFrame,
} from '@dispatch/a2a';

import type { RelaySettings } from './settings.js';
import { DEFAULT_RELAY } from './settings.js';
import type { CardSigner } from './signing.js';

// The daemon's side of a relay (P5 piece 3): it dials the relay, proves its
// card key to the challenge, and answers each `call` frame as the port
// routes answer a standalone host, as a host pinned to its tenant URL. No
// inbound port is opened.

export interface RelayStatus {
  enabled: boolean;
  url: string | null;
  connected: boolean;
  tenantUrl: string | null;
  error: string | null;
}

export interface RelayClientDeps {
  signer: () => CardSigner | null;
  // One /api/a2a/port/* call for `host`; `stillHost` is re-checked by watches.
  serve: (
    req: Request,
    rest: string[],
    host: HostRow,
    stillHost: () => boolean
  ) => Promise<Response>;
  // The relay host's connection ended: its sessions and watches go.
  hostGone: (hostId: string) => void;
  ownerRef: string;
  changed: () => void;
  // The first re-dial delay and the cap (1 s and 60 s).
  backoffMs?: { first: number; max: number };
}

// The headers a result may carry back (the relay refuses any other).
const RESULT_HEADERS = [
  'content-type',
  'cache-control',
  'etag',
  'retry-after',
  'a2a-extensions',
  'signature',
  'signature-input',
  'content-digest',
];

export class RelayClient {
  private settings: RelaySettings = { ...DEFAULT_RELAY };
  private ws: WebSocket | null = null;
  private connected = false;
  private tenantUrl: string | null = null;
  private error: string | null = null;
  private thumbprint: string | null = null;
  private redial: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;
  private stopped = false;
  private readonly calls = new Map<string, AbortController>();

  constructor(private readonly d: RelayClientDeps) {
    this.backoff = d.backoffMs?.first ?? 1000;
  }

  status(): RelayStatus {
    return {
      enabled: this.settings.enabled,
      url: this.settings.url,
      connected: this.connected,
      tenantUrl: this.tenantUrl,
      error: this.error,
    };
  }

  /** Follows `settings`: dials when enabled, hangs up otherwise. */
  apply(settings: RelaySettings): void {
    this.settings = settings;
    this.hangUp();
    this.error = null;
    this.backoff = this.d.backoffMs?.first ?? 1000;
    if (settings.enabled && settings.url !== null && !this.stopped) this.dial();
    this.d.changed();
  }

  stop(): void {
    this.stopped = true;
    this.hangUp();
  }

  private hostId(): string {
    return `relay:${this.thumbprint ?? '-'}`;
  }

  private hangUp(): void {
    if (this.redial !== null) clearTimeout(this.redial);
    this.redial = null;
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      this.ended();
      ws.close();
    }
  }

  // The connection is over: calls stop, and the relay host's sessions go.
  private ended(): void {
    for (const ac of this.calls.values()) ac.abort();
    this.calls.clear();
    if (this.connected) this.d.hostGone(this.hostId());
    this.connected = false;
  }

  private dial(): void {
    const signer = this.d.signer();
    const url = this.settings.url;
    if (signer === null || url === null) {
      this.error =
        "card signing is off; a relay tenant needs this project's card key";
      return;
    }
    const dialled = `${url.replace(/^http/, 'ws')}/v1/tenants`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(dialled);
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'cannot dial the relay';
      this.scheduleRedial();
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => this.onFrame(ws, dialled, signer, String(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ended();
      this.d.changed();
      this.scheduleRedial();
    };
    ws.onerror = () => {
      this.error ??= 'the relay connection failed';
    };
  }

  // Re-dials after a dropped or refused connection, backing off to the cap.
  private scheduleRedial(): void {
    if (this.stopped || !this.settings.enabled || this.redial !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.d.backoffMs?.max ?? 60_000);
    this.redial = setTimeout(() => {
      this.redial = null;
      if (this.ws === null && this.settings.enabled) this.dial();
    }, delay);
    this.redial.unref();
  }

  private send(ws: WebSocket, frame: unknown): void {
    if (this.ws === ws) ws.send(JSON.stringify(frame));
  }

  private onFrame(
    ws: WebSocket,
    dialled: string,
    signer: CardSigner,
    raw: string
  ): void {
    let frame: RelayToDaemon;
    try {
      frame = parseFrame(raw, 'daemon');
    } catch {
      ws.close();
      return;
    }
    switch (frame.t) {
      case 'challenge': {
        const key = signer.requestKey();
        const jwk = signer.publicJwk();
        this.thumbprint = ecThumbprint(jwk);
        this.send(
          ws,
          answerChallenge({
            relayUrl: dialled,
            nonce: frame.nonce,
            privateKey: key.privateKey,
            jwk,
          })
        );
        return;
      }
      case 'ready':
        this.connected = true;
        this.error = null;
        this.backoff = this.d.backoffMs?.first ?? 1000;
        this.tenantUrl = `${this.settings.url}/t/${this.thumbprint}`;
        this.d.changed();
        return;
      case 'refused':
        this.error = `the relay refused this agent: ${frame.reason}`;
        this.backoff = this.d.backoffMs?.max ?? 60_000;
        ws.close();
        return;
      case 'ping':
        this.send(ws, { t: 'pong' });
        return;
      case 'cancel':
        this.calls.get(frame.id)?.abort();
        return;
      case 'call':
        void this.call(ws, frame).catch(() => undefined);
    }
  }

  private async call(
    ws: WebSocket,
    f: Extract<RelayToDaemon, { t: 'call' }>
  ): Promise<void> {
    const ac = new AbortController();
    this.calls.set(f.id, ac);
    try {
      const url = new URL(`http://relay.invalid/api/a2a/port${f.route}`);
      const rest = url.pathname
        .slice('/api/a2a/port/'.length)
        .split('/')
        .filter((s) => s !== '');
      const host: HostRow = {
        id: this.hostId(),
        name: 'relay',
        tokenHash: '',
        publicUrl: this.tenantUrl ?? '',
        createdBy: this.d.ownerRef,
        createdAt: '',
        revokedAt: null,
      };
      const bodied = f.method !== 'GET' && f.method !== 'HEAD';
      const req = new Request(url.href, {
        method: f.method,
        headers: f.headers,
        ...(bodied && f.body !== null ? { body: f.body } : {}),
        signal: ac.signal,
      });
      let res: Response;
      try {
        res = await this.d.serve(
          req,
          rest,
          host,
          () => this.connected && this.ws === ws
        );
      } catch {
        res = Response.json(
          {
            error: {
              kind: 'messaging',
              code: 'invalid',
              message: 'the call failed',
            },
          },
          { status: 500 }
        );
      }
      const headers: Record<string, string> = {};
      for (const name of RESULT_HEADERS) {
        const v = res.headers.get(name);
        if (v !== null) headers[name] = v;
      }
      if (isEventStream(res.headers) && res.body !== null) {
        this.send(ws, {
          t: 'result',
          id: f.id,
          status: res.status,
          headers,
          body: null,
        });
        const reader = res.body.getReader();
        ac.signal.addEventListener('abort', () => void reader.cancel(), {
          once: true,
        });
        const decoder = new TextDecoder();
        for (;;) {
          const next = await reader
            .read()
            .catch(() => ({ done: true as const }));
          if (next.done || ac.signal.aborted) break;
          const text = decoder.decode(next.value, { stream: true });
          for (let i = 0; i < text.length; i += MAX_FRAME_BODY / 4)
            this.send(ws, {
              t: 'chunk',
              id: f.id,
              data: text.slice(i, i + MAX_FRAME_BODY / 4),
            });
        }
        if (!ac.signal.aborted) this.send(ws, { t: 'end', id: f.id });
        return;
      }
      const body = await res.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_FRAME_BODY) {
        this.send(ws, {
          t: 'result',
          id: f.id,
          status: 502,
          headers: {},
          body: null,
        });
        return;
      }
      this.send(ws, {
        t: 'result',
        id: f.id,
        status: res.status,
        headers,
        body: res.status === 204 ? null : body,
      });
    } finally {
      this.calls.delete(f.id);
    }
  }
}
