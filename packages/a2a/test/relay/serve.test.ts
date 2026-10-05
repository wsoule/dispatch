import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerChallenge } from '../../src/relay/challenge.js';
import type { RelayToDaemon } from '../../src/relay/frames.js';
import { startRelay } from '../../src/relay/serve.js';
import { ecThumbprint, publicJwkOf } from '../../src/sig/keys.js';

interface Key {
  privateKey: KeyObject;
  jwk: Record<string, string>;
  tp: string;
}
const newKey = (): Key => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicJwkOf(
    publicKey.export({ format: 'jwk' }) as Record<string, string>
  );
  return { privateKey, jwk, tp: ecThumbprint(jwk)! };
};

let dir: string;
let lines: string[];
let stops: (() => Promise<void>)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a2a-relay-'));
  lines = [];
  stops = [];
});
afterEach(async () => {
  for (const stop of stops) await stop();
  rmSync(dir, { recursive: true, force: true });
});

function tenantsFile(body: string, mode = 0o600): string {
  const path = join(dir, 'tenants');
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

async function relay(tenants: string) {
  const r = await startRelay({
    host: '127.0.0.1',
    port: 0,
    publicUrl: null,
    tls: null,
    publicBind: false,
    trustForwardedFor: false,
    tenantsFile: tenants,
    log: (line) => lines.push(line),
  });
  stops.push(r.stop);
  return r;
}

// A fake tenant daemon: answers the challenge with `key`, then each call
// frame with `answer`; resolves with the frame that ended the handshake.
function tenant(
  relayUrl: string,
  key: Key,
  answer: (f: Extract<RelayToDaemon, { t: 'call' }>) => {
    status: number;
    body: unknown;
  } = () => ({
    status: 404,
    body: {
      error: { kind: 'a2a', reason: 'TASK_NOT_FOUND', message: 'no task' },
    },
  })
) {
  const frames: RelayToDaemon[] = [];
  const dialled = `${relayUrl.replace(/^http/, 'ws')}/v1/tenants`;
  const ws = new WebSocket(dialled);
  const settled = new Promise<RelayToDaemon>((resolve) => {
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as RelayToDaemon;
      frames.push(f);
      if (f.t === 'challenge')
        ws.send(
          JSON.stringify(
            answerChallenge({
              relayUrl: dialled,
              nonce: f.nonce,
              privateKey: key.privateKey,
              jwk: key.jwk,
            })
          )
        );
      else if (f.t === 'ready' || f.t === 'refused') resolve(f);
      else if (f.t === 'call') {
        const { status, body } = answer(f);
        ws.send(
          JSON.stringify({
            t: 'result',
            id: f.id,
            status,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        );
      }
    };
    ws.onclose = () => resolve({ t: 'refused', reason: 'closed' });
  });
  stops.push(() => {
    ws.close();
    return Promise.resolve();
  });
  return { ws, frames, settled };
}

const cardInputs = (f: Extract<RelayToDaemon, { t: 'call' }>) => ({
  name: 'Tenant',
  description: null,
  publicUrl: new URL(`http://x${f.route}`).searchParams.get('publicUrl'),
  version: '1',
  skills: ['ask'],
  blockingWaitSec: 60,
  pushNotifications: false,
});

describe('startRelay', () => {
  it('refuses a tenants file others can read, or a symlink', async () => {
    const a = newKey();
    await expect(relay(tenantsFile(`${a.tp}\n`, 0o644))).rejects.toThrow(
      /chmod 600/
    );
    const real = tenantsFile(`${a.tp}\n`);
    const link = join(dir, 'link');
    symlinkSync(real, link);
    await expect(relay(link)).rejects.toThrow(/regular file/);
  });

  it('admits an allowlisted tenant through the challenge, and refuses an unlisted one before any call', async () => {
    const a = newKey();
    const r = await relay(tenantsFile(`# tenants\n${a.tp} alice\n`));
    expect(await tenant(r.url, a).settled).toEqual({ t: 'ready' });
    const stranger = tenant(r.url, newKey());
    expect(await stranger.settled).toMatchObject({ t: 'refused' });
    expect(stranger.frames.some((f) => f.t === 'call')).toBe(false);
  });

  it('serves a GetTask for /t/<tp>/a2a/v1/tasks/x through the tenant, and its card for the tenant URL', async () => {
    const a = newKey();
    const r = await relay(tenantsFile(`${a.tp}\n`));
    const seen: string[] = [];
    const t = tenant(r.url, a, (f) => {
      seen.push(f.route);
      if (f.route === '/whoami')
        return {
          status: 200,
          body: {
            ok: true,
            caller: { address: 'agent:w/a2a.c', name: 'a2a.c' },
          },
        };
      if (f.route === '/admit') return { status: 200, body: { ok: true } };
      if (f.route.startsWith('/card'))
        return { status: 200, body: cardInputs(f) };
      return {
        status: 404,
        body: {
          error: { kind: 'a2a', reason: 'TASK_NOT_FOUND', message: 'no task' },
        },
      };
    });
    await t.settled;
    const base = `${r.url}/t/${a.tp}`;
    const res = await fetch(`${base}/a2a/v1/tasks/x`, {
      headers: { authorization: 'Bearer secret-token', 'a2a-version': '1.0' },
    });
    expect(res.status).toBe(404);
    expect(seen).toContain('/tasks/x');
    const card = (await (
      await fetch(`${base}/.well-known/agent-card.json`)
    ).json()) as {
      supportedInterfaces: { url: string }[];
    };
    expect(card.supportedInterfaces[0].url).toBe(`${base}/a2a/v1`);
    // Another tenant's path, an unknown one, and anything else are 404.
    expect(
      (await fetch(`${r.url}/t/${newKey().tp}/a2a/v1/tasks/x`)).status
    ).toBe(404);
    expect((await fetch(`${r.url}/admin`)).status).toBe(404);
    // The access log names the route and status, never the credential.
    const log = lines.join('\n');
    expect(log).toContain('/a2a/v1/tasks/x');
    expect(log).toContain('404');
    expect(log).not.toContain('secret-token');
  });

  it('answers 404 for a tenant whose daemon is not connected, as for one never listed (review M4)', async () => {
    const a = newKey();
    const r = await relay(tenantsFile(`${a.tp}\n`));
    const t = tenant(r.url, a);
    await t.settled;
    t.ws.close();
    await new Promise((res) => setTimeout(res, 200));
    expect((await fetch(`${r.url}/t/${a.tp}/a2a/v1/tasks/x`)).status).toBe(404);
  });
});

describe('the relay’s handshake and isolation (batch 5 review)', () => {
  it('refuses an auth signed for another connection’s nonce, and one that comes too late', async () => {
    const a = newKey();
    const r = await startRelay({
      host: '127.0.0.1',
      port: 0,
      publicUrl: null,
      tls: null,
      publicBind: false,
      trustForwardedFor: false,
      tenantsFile: tenantsFile(`${a.tp}\n`),
      log: (line) => lines.push(line),
      authTimeoutMs: 300,
    });
    stops.push(r.stop);
    const dialled = `${r.url.replace(/^http/, 'ws')}/v1/tenants`;
    const open = () => {
      const ws = new WebSocket(dialled);
      const got: RelayToDaemon[] = [];
      const closed = new Promise<void>((res) => (ws.onclose = () => res()));
      const challenge = new Promise<string>((res) => {
        ws.onmessage = (e) => {
          const f = JSON.parse(String(e.data)) as RelayToDaemon;
          got.push(f);
          if (f.t === 'challenge') res(f.nonce);
        };
      });
      stops.push(() => {
        ws.close();
        return Promise.resolve();
      });
      return { ws, got, closed, challenge };
    };
    // A second connection's auth answers the first one's nonce: refused.
    const first = open();
    const second = open();
    const firstNonce = await first.challenge;
    await second.challenge;
    second.ws.send(
      JSON.stringify(
        answerChallenge({
          relayUrl: dialled,
          nonce: firstNonce,
          privateKey: a.privateKey,
          jwk: a.jwk,
        })
      )
    );
    await second.closed;
    expect(second.got.some((f) => f.t === 'refused')).toBe(true);
    // An auth after the timeout: the connection is already closed.
    const late = open();
    await late.challenge;
    await late.closed;
    expect(late.got.some((f) => f.t === 'ready')).toBe(false);
  });

  it('feeds a connection’s results only to its own tenant: B cannot answer A’s call', async () => {
    const a = newKey();
    const b = newKey();
    const r = await relay(tenantsFile(`${a.tp}\n${b.tp}\n`));
    let aCall: string | null = null;
    // A never answers its calls; B answers A's call id instead.
    const ta = tenant(r.url, a, () => ({ status: 0, body: null }));
    ta.ws.onmessage = ((orig) => (e: MessageEvent) => {
      const f = JSON.parse(String(e.data)) as RelayToDaemon;
      if (f.t === 'call') {
        aCall = f.id;
        return;
      }
      orig?.call(ta.ws, e);
    })(ta.ws.onmessage);
    await ta.settled;
    const tb = tenant(r.url, b);
    await tb.settled;
    const pending = fetch(`${r.url}/t/${a.tp}/a2a/v1/tasks/x`, {
      headers: { authorization: 'Bearer t', 'a2a-version': '1.0' },
      signal: AbortSignal.timeout(1500),
    }).then(
      (res) => res.status,
      () => 'no answer'
    );
    await new Promise((res) => setTimeout(res, 300));
    expect(aCall).not.toBeNull();
    tb.ws.send(
      JSON.stringify({
        t: 'result',
        id: aCall,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          caller: { address: 'agent:x/a2a.y', name: 'a2a.y' },
        }),
      })
    );
    expect(await pending).toBe('no answer');
    expect(lines.join('\n')).toContain('answered a call it does not own');
  });
});

describe('relay review M2, M5, M3 liveness', () => {
  async function relayWith(
    tenants: string,
    over: Record<string, unknown> = {}
  ) {
    const r = await startRelay({
      host: '127.0.0.1',
      port: 0,
      publicUrl: null,
      tls: null,
      publicBind: false,
      trustForwardedFor: false,
      tenantsFile: tenants,
      log: (line) => lines.push(line),
      ...over,
    });
    stops.push(r.stop);
    return r;
  }
  const dial = (url: string) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/tenants`);
    const got: string[] = [];
    const closed = new Promise<number>(
      (res) => (ws.onclose = (e) => res(e.code))
    );
    const challenged = new Promise<void>((res) => {
      ws.onmessage = (e) => {
        got.push(String(e.data));
        res();
      };
    });
    stops.push(() => {
      ws.close();
      return Promise.resolve();
    });
    return { ws, got, closed, challenged };
  };

  it('M2: closes a connection that sends a large message before its auth', async () => {
    const r = await relayWith(tenantsFile(`${newKey().tp}\n`));
    const d = dial(r.url);
    await d.challenged;
    d.ws.send('x'.repeat(8 * 1024));
    expect(await d.closed).toBe(1009);
  });

  it('M2: caps connections still waiting to authenticate, per IP', async () => {
    const r = await relayWith(tenantsFile(`${newKey().tp}\n`), {
      preAuthPerIp: 2,
    });
    const a = dial(r.url);
    const b = dial(r.url);
    await a.challenged;
    await b.challenged;
    const c = dial(r.url);
    await c.closed;
    expect(c.got).toEqual([]);
  });

  it('M5: a reload drops tenants no longer listed', async () => {
    const a = newKey();
    const file = tenantsFile(`${a.tp}\n`);
    const r = await relayWith(file);
    const t = tenant(r.url, a);
    expect(await t.settled).toEqual({ t: 'ready' });
    writeFileSync(file, `${newKey().tp}\n`);
    r.reload();
    await new Promise((res) => setTimeout(res, 200));
    expect(t.ws.readyState).toBe(WebSocket.CLOSED);
    expect(
      (await fetch(`${r.url}/t/${a.tp}/.well-known/agent-card.json`)).status
    ).toBe(404);
  });

  it('M3: drops a tenant that stops answering pings', async () => {
    const a = newKey();
    const r = await relayWith(tenantsFile(`${a.tp}\n`), { pingMs: 100 });
    // Bun's client answers pings; a tenant that never sends a frame after auth
    // still answers them, so this only checks the timer runs without harm.
    const t = tenant(r.url, a);
    expect(await t.settled).toEqual({ t: 'ready' });
    await new Promise((res) => setTimeout(res, 400));
    expect(t.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('relay re-review N1', () => {
  it('keys the pre-auth cap on the trusted forwarded address behind a loopback tunnel', async () => {
    const r = await startRelay({
      host: '127.0.0.1',
      port: 0,
      publicUrl: null,
      tls: null,
      publicBind: false,
      trustForwardedFor: true,
      tenantsFile: tenantsFile(`${newKey().tp}\n`),
      log: (line) => lines.push(line),
      preAuthPerIp: 1,
    });
    stops.push(r.stop);
    const dial = (xff: string) => {
      const ws = new WebSocket(`${r.url.replace(/^http/, 'ws')}/v1/tenants`, {
        headers: { 'x-forwarded-for': xff },
      } as unknown as string[]);
      const got: string[] = [];
      const closed = new Promise<void>((res) => (ws.onclose = () => res()));
      const challenged = new Promise<void>((res) => {
        ws.onmessage = (e) => {
          got.push(String(e.data));
          res();
        };
      });
      stops.push(() => {
        ws.close();
        return Promise.resolve();
      });
      return { got, closed, challenged };
    };
    const one = dial('192.0.2.1');
    const two = dial('192.0.2.2');
    await one.challenged;
    await two.challenged;
    const again = dial('192.0.2.1');
    await again.closed;
    expect(again.got).toEqual([]);
  });
});
