import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  applyOverrides,
  clientIpFor,
  DEFAULT_LISTENER,
  listenerClientIp,
  listenerSettingsPath,
  parseListenerFlags,
  readListenerSettings,
  resolveListener,
  writeListenerSettings,
} from '../../src/a2a/settings.js';

let home: string;
let root: string;
const originalHome = process.env.DISPATCH_HOME;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-settings-home-')));
  process.env.DISPATCH_HOME = home;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-settings-root-')));
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const on = (over = {}) => ({
  ...DEFAULT_LISTENER,
  enabled: true,
  port: 7450,
  ...over,
});

describe('the settings file', () => {
  it('is off by default and written 0600', () => {
    expect(readListenerSettings(root)).toEqual({
      settings: DEFAULT_LISTENER,
      error: null,
    });
    writeListenerSettings(root, on());
    expect(statSync(listenerSettingsPath(root)).mode & 0o777).toBe(0o600);
    expect(readListenerSettings(root).settings).toEqual(on());
  });

  it('reads a corrupt file as the defaults plus an error, never a throw', () => {
    const path = listenerSettingsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"enabled": tru');
    const read = readListenerSettings(root);
    expect(read.settings).toEqual(DEFAULT_LISTENER);
    expect(read.error).toContain('a2a-listener.json');
  });

  it('reads a file of the wrong shape as the defaults plus an error', () => {
    const path = listenerSettingsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ enabled: 'yes', host: 1 }));
    const read = readListenerSettings(root);
    expect(read.settings).toEqual(DEFAULT_LISTENER);
    expect(read.error).toContain('a2a-listener.json');
  });

  it('fills the keys a short hand-written file leaves out from the defaults', () => {
    const path = listenerSettingsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ enabled: true, port: 7450 }));
    expect(readListenerSettings(root)).toEqual({ settings: on(), error: null });
  });

  it('lets the flags override the file for one boot', () => {
    expect(
      applyOverrides(DEFAULT_LISTENER, {
        host: '0.0.0.0',
        port: 9000,
        publicUrl: 'https://x.example.com',
        tlsCert: '/c',
        tlsKey: '/k',
      })
    ).toEqual({
      ...DEFAULT_LISTENER,
      enabled: true,
      host: '0.0.0.0',
      port: 9000,
      publicUrl: 'https://x.example.com',
      tls: { certPath: '/c', keyPath: '/k' },
    });
  });

  it('leaves the file as read when no flag is given', () => {
    expect(applyOverrides(DEFAULT_LISTENER, undefined)).toEqual(
      DEFAULT_LISTENER
    );
    expect(applyOverrides(DEFAULT_LISTENER, {})).toEqual(DEFAULT_LISTENER);
  });
});

describe('parseListenerFlags', () => {
  it('gives no overrides when no --a2a-* flag is set', () => {
    expect(parseListenerFlags({})).toEqual({ ok: true, overrides: {} });
  });

  it('reads every flag and resolves the TLS files against the working directory', () => {
    expect(
      parseListenerFlags({
        host: '0.0.0.0',
        port: '7450',
        publicUrl: 'https://x.example.com',
        tlsCert: 'certs/a2a.pem',
        tlsKey: 'certs/a2a.key',
      })
    ).toEqual({
      ok: true,
      overrides: {
        host: '0.0.0.0',
        port: 7450,
        publicUrl: 'https://x.example.com',
        tlsCert: resolve('certs/a2a.pem'),
        tlsKey: resolve('certs/a2a.key'),
      },
    });
  });

  it.each(['0', '65536', '1.5', 'seven', ''])(
    'refuses --a2a-port %j',
    (port) => {
      expect(parseListenerFlags({ port })).toEqual({
        ok: false,
        error: `--a2a-port must be a port number, not "${port}"`,
      });
    }
  );

  it.each([{ tlsCert: '/c' }, { tlsKey: '/k' }])(
    'refuses half a TLS pair: %j',
    (flags) => {
      expect(parseListenerFlags(flags)).toEqual({
        ok: false,
        error: '--a2a-tls-cert and --a2a-tls-key go together',
      });
    }
  );
});

describe('resolveListener', () => {
  it('defaults the public URL on loopback', () => {
    expect(resolveListener(on(), [4000])).toEqual({
      ok: true,
      listener: {
        host: '127.0.0.1',
        port: 7450,
        publicUrl: 'http://127.0.0.1:7450',
        tls: null,
        trustForwardedFor: false,
      },
    });
  });

  it.each([
    [on({ host: '192.168.1.5' }), 'host'],
    [on({ host: '0.0.0.0' }), 'tls'],
    [
      on({
        host: '0.0.0.0',
        tls: { certPath: '/missing.pem', keyPath: '/missing.key' },
        publicUrl: 'https://x.example.com',
      }),
      'tls.certPath',
    ],
    [on({ port: null }), 'port'],
    [on({ port: 4000 }), 'port'],
    [on({ publicUrl: 'http://agent.example.com' }), 'publicUrl'],
    [on({ publicUrl: 'http://127.evil.example.com' }), 'publicUrl'],
    [on({ publicUrl: 'not a url' }), 'publicUrl'],
  ])('refuses %j on %s', (settings, key) => {
    expect(resolveListener(settings, [4000])).toMatchObject({
      ok: false,
      key,
    });
  });

  it('binds 127.0.0.1 for localhost, so the default URL is where it listens', () => {
    expect(resolveListener(on({ host: 'localhost' }), [4000])).toMatchObject({
      ok: true,
      listener: { host: '127.0.0.1', publicUrl: 'http://127.0.0.1:7450' },
    });
  });

  it('defaults an https public URL for a loopback listener with TLS', () => {
    expect(
      resolveListener(on({ tls: { certPath: '/c', keyPath: '/k' } }), [4000])
    ).toMatchObject({
      ok: true,
      listener: { publicUrl: 'https://127.0.0.1:7450' },
    });
  });

  it.each([
    'http://localhost:7450',
    'http://[::1]:7450',
    'http://127.0.0.2:7450',
  ])('accepts the plain-http loopback public URL %s', (publicUrl) => {
    expect(resolveListener(on({ publicUrl }), [4000])).toMatchObject({
      ok: true,
      listener: { publicUrl },
    });
  });

  it('refuses an interface host with the choices the A2A listener takes', () => {
    const resolved = resolveListener(on({ host: '192.168.1.5' }), [4000]);
    if (resolved.ok) throw new Error('expected a refusal');
    expect(resolved.key).toBe('host');
    expect(resolved.error).toContain('0.0.0.0');
    expect(resolved.error).not.toContain('daemon');
  });

  it('accepts a loopback listener behind a tunnel with an https public URL', () => {
    expect(
      resolveListener(
        on({
          publicUrl: 'https://acme-agent.example.com',
          trustForwardedFor: true,
        }),
        [4000]
      )
    ).toMatchObject({
      ok: true,
      listener: {
        publicUrl: 'https://acme-agent.example.com',
        trustForwardedFor: true,
      },
    });
  });

  it('accepts a wildcard host with readable TLS files and ignores trustForwardedFor there', () => {
    const cert = join(root, 'cert.pem');
    const key = join(root, 'key.pem');
    writeFileSync(cert, 'x');
    writeFileSync(key, 'x');
    expect(
      resolveListener(
        on({
          host: '0.0.0.0',
          tls: { certPath: cert, keyPath: key },
          publicUrl: 'https://x.example.com',
          trustForwardedFor: true,
        }),
        [4000]
      )
    ).toMatchObject({ ok: true, listener: { trustForwardedFor: false } });
  });
});

describe('clientIpFor', () => {
  const req = (xff?: string) =>
    new Request('http://x.test/', {
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    });
  it('uses the right-most X-Forwarded-For entry only when trusted', () => {
    expect(
      clientIpFor(req('198.51.100.7, 203.0.113.9'), '127.0.0.1', true)
    ).toBe('203.0.113.9');
    expect(clientIpFor(req('198.51.100.7'), '127.0.0.1', false)).toBe(
      '127.0.0.1'
    );
    expect(clientIpFor(req(), '127.0.0.1', true)).toBe('127.0.0.1');
  });
});

describe('batch 5 review R3: the listener trusts X-Forwarded-For only on loopback', () => {
  const req = new Request('http://x/', {
    headers: { 'x-forwarded-for': '192.0.2.1' },
  });
  it('honours it behind a loopback-bound tunnel, never on a network bind', () => {
    expect(
      listenerClientIp(req, '127.0.0.1', {
        host: '127.0.0.1',
        trustForwardedFor: true,
      })
    ).toBe('192.0.2.1');
    expect(
      listenerClientIp(req, '203.0.113.5', {
        host: '0.0.0.0',
        trustForwardedFor: true,
      })
    ).toBe('203.0.113.5');
    expect(
      listenerClientIp(req, '127.0.0.1', {
        host: '127.0.0.1',
        trustForwardedFor: false,
      })
    ).toBe('127.0.0.1');
  });
});
