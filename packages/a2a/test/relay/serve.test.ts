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

  it('answers 503 for a tenant whose daemon is not connected', async () => {
    const a = newKey();
    const r = await relay(tenantsFile(`${a.tp}\n`));
    const t = tenant(r.url, a);
    await t.settled;
    t.ws.close();
    await new Promise((res) => setTimeout(res, 200));
    expect((await fetch(`${r.url}/t/${a.tp}/a2a/v1/tasks/x`)).status).toBe(503);
  });
});
