import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fileDeviceStore,
  normalizePairingCode,
  PairedDevices,
  PairingCodes,
} from '../src/devices.js';
import { sha256, TokenRegistry } from '../src/identity.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

describe('PairingCodes', () => {
  it('redeems a code once, at the tier it was offered', () => {
    const codes = new PairingCodes();
    const { code, tier } = codes.offer('decide');
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(tier).toBe('decide');
    expect(codes.redeem(code)).toEqual({
      ok: true,
      tier: 'decide',
      pairedBy: null,
    });
    expect(codes.redeem(code)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts the code as a person types it', () => {
    const codes = new PairingCodes();
    const { code } = codes.offer('operator');
    expect(codes.redeem(` ${code.toLowerCase().replace('-', ' ')} `).ok).toBe(
      true
    );
    expect(normalizePairingCode('abcd-oil0')).toBe('ABCD0110');
  });

  it('refuses an expired code', () => {
    let now = new Date('2026-10-20T00:00:00Z');
    const codes = new PairingCodes({ clock: () => now, ttlMs: 60_000 });
    const { code } = codes.offer('operator');
    now = new Date('2026-10-20T00:01:00Z');
    expect(codes.redeem(code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('burns every open code after too many wrong guesses', () => {
    const codes = new PairingCodes({ maxFailures: 3 });
    const { code } = codes.offer('operator');
    for (let i = 0; i < 3; i++) codes.redeem('ZZZZ-ZZZZ');
    expect(codes.redeem(code)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps an open code through fewer wrong guesses than the limit', () => {
    const codes = new PairingCodes({ maxFailures: 3 });
    const { code } = codes.offer('operator');
    for (let i = 0; i < 2; i++) codes.redeem('ZZZZ-ZZZZ');
    expect(codes.redeem(code).ok).toBe(true);
  });
});

describe('PairedDevices', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispatch-devices-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('speaks for the operator at the paired tier, through the registry', () => {
    const devices = new PairedDevices('owner');
    const { token, device } = devices.add('phone', 'decide');
    const registry = new TokenRegistry(
      { agentToken: 'a'.repeat(64), appToken: 'b'.repeat(64) },
      'owner',
      null,
      null,
      devices
    );
    expect(registry.resolve(token)).toEqual({
      handle: 'owner',
      ref: 'human:owner',
      tier: 'decide',
      device: device.id,
    });
    devices.revoke(device.id);
    expect(registry.resolve(token)).toBeNull();
  });

  it('survives a restart as hashes in a 0600 file, never the token', () => {
    const path = join(dir, 'paired-devices.json');
    const first = new PairedDevices('owner', { store: fileDeviceStore(path) });
    const { token, device } = first.add('laptop', 'operator');
    const raw = Bun.file(path).text();
    return raw.then((text) => {
      expect(text).not.toContain(token);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const second = new PairedDevices('owner', {
        store: fileDeviceStore(path),
      });
      expect(second.list().map((d) => d.id)).toEqual([device.id]);
      expect(second.lookup(sha256(token)).kind).toBe('valid');
    });
  });

  it('unpairing a device unpairs every device it paired, transitively', () => {
    const devices = new PairedDevices('owner');
    const laptop = devices.add('laptop', 'operator').device;
    const phone = devices.add('phone', 'decide', laptop.id).device;
    const tablet = devices.add('tablet', 'request', phone.id).device;
    const other = devices.add('other', 'operator').device;
    expect(devices.revoke(laptop.id).sort()).toEqual(
      [laptop.id, phone.id, tablet.id].sort()
    );
    expect(devices.list().map((d) => d.id)).toEqual([other.id]);
    expect(devices.revoke('d-missing')).toEqual([]);
  });

  it('loads an unreadable file as no devices', () => {
    const path = join(dir, 'paired-devices.json');
    writeFileSync(path, '{not json');
    expect(
      new PairedDevices('owner', { store: fileDeviceStore(path) }).list()
    ).toEqual([]);
  });
});

describe('pairing over the API', () => {
  let fakeHome: string;
  let root: string;
  let handle: ServerHandle;
  let baseUrl: string;
  const originalHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = mkdtempSync(join(tmpdir(), 'dispatch-pairing-'));
    runGitSync(root, ['init', '-b', 'main']);
    runGitSync(root, ['config', 'user.email', 'owner@example.com']);
    runGitSync(root, ['config', 'user.name', 'Owner']);
    writeFileSync(join(root, 'README.md'), '# test\n');
    runGitSync(root, ['add', '-A']);
    runGitSync(root, ['commit', '-m', 'initial']);
    TaskStore.init(root);
    handle = await startServer({ rootDir: root, port: 0, webDistDir: null });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return rawFetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function offer(token: string, tier?: string): Promise<Response> {
    return call(
      'POST',
      '/api/pair/offer',
      token,
      tier === undefined ? {} : { tier }
    );
  }

  async function pair(
    tier = 'operator'
  ): Promise<{ token: string; device: { id: string }; handle: string }> {
    const offered = (await (
      await offer(handle.tokens.appToken, tier)
    ).json()) as {
      code: string;
    };
    const res = await call('POST', '/api/pair', null, {
      code: offered.code,
      name: 'my laptop',
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      token: string;
      device: { id: string };
      handle: string;
    };
  }

  it('pairs a device with no credential but the code, as the operator', async () => {
    const paired = await pair('decide');
    const who = (await (
      await call('GET', '/api/whoami', paired.token)
    ).json()) as { handle: string; tier: string; device?: string };
    expect(who.handle).toBe(paired.handle);
    expect(who.tier).toBe('decide');
    expect(who.device).toBe(paired.device.id);
    const listed = (await (
      await call('GET', '/api/devices', handle.tokens.appToken)
    ).json()) as { devices: { id: string; name: string }[] };
    expect(listed.devices).toEqual([
      expect.objectContaining({ id: paired.device.id, name: 'my laptop' }),
    ]);
  });

  it('stores a device name without control characters', async () => {
    const offered = (await (await offer(handle.tokens.appToken)).json()) as {
      code: string;
    };
    const res = await call('POST', '/api/pair', null, {
      code: offered.code,
      name: '\u001b[2Jphone\u0007',
    });
    expect(
      ((await res.json()) as { device: { name: string } }).device.name
    ).toBe('[2Jphone');
  });

  it('refuses a wrong code', async () => {
    const res = await call('POST', '/api/pair', null, { code: 'ZZZZ-ZZZZ' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      'pair_code_invalid'
    );
  });

  it('unpairing a device stops its token at once', async () => {
    const paired = await pair();
    const res = await call(
      'DELETE',
      `/api/devices/${paired.device.id}`,
      handle.tokens.appToken
    );
    expect(res.status).toBe(200);
    expect((await call('GET', '/api/whoami', paired.token)).status).toBe(401);
  });

  it('an operator-tier device can pair another device', async () => {
    const laptop = await pair('operator');
    expect((await offer(laptop.token, 'decide')).status).toBe(200);
  });

  it('the shared agent token cannot pair itself a human credential', async () => {
    // At request tier, so the tier cap cannot be what refuses it.
    expect((await offer(handle.tokens.agentToken, 'request')).status).toBe(403);
  });

  it('a teammate cannot mint a device that speaks for the operator', async () => {
    const issued = (await (
      await call('POST', '/api/team/tokens', handle.tokens.appToken, {
        email: 'lead@example.com',
        tier: 'operator',
      })
    ).json()) as { token: string };
    expect((await offer(issued.token, 'request')).status).toBe(403);
    expect((await call('GET', '/api/devices', issued.token)).status).toBe(403);
  });

  it('a device it paired goes with it when a device is unpaired', async () => {
    const laptop = await pair('operator');
    const offered = (await (await offer(laptop.token, 'decide')).json()) as {
      code: string;
    };
    const phone = (await (
      await call('POST', '/api/pair', null, { code: offered.code })
    ).json()) as { token: string };
    await call(
      'DELETE',
      `/api/devices/${laptop.device.id}`,
      handle.tokens.appToken
    );
    expect((await call('GET', '/api/whoami', phone.token)).status).toBe(401);
  });

  it('a code a device offered dies with that device', async () => {
    const laptop = await pair('operator');
    const offered = (await (await offer(laptop.token, 'decide')).json()) as {
      code: string;
    };
    await call(
      'DELETE',
      `/api/devices/${laptop.device.id}`,
      handle.tokens.appToken
    );
    const res = await call('POST', '/api/pair', null, { code: offered.code });
    expect(res.status).toBe(401);
  });

  it('a device cannot unpair one paired above its tier, but can unpair itself', async () => {
    const laptop = await pair('operator');
    const phone = await pair('decide');
    expect(
      (await call('DELETE', `/api/devices/${laptop.device.id}`, phone.token))
        .status
    ).toBe(403);
    expect(
      (await call('DELETE', `/api/devices/${phone.device.id}`, phone.token))
        .status
    ).toBe(200);
    expect((await call('GET', '/api/whoami', laptop.token)).status).toBe(200);
  });

  it('a device cannot pair one above its own tier', async () => {
    const phone = await pair('decide');
    expect((await offer(phone.token, 'operator')).status).toBe(403);
  });
});
