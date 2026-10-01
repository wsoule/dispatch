import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  clearPeerCredential,
  clearProjectCredential,
  credentialsPath,
  CredentialsUnreadableError,
  isStaleLock,
  readA2ASigningKey,
  readCredentials,
  readPeerCredential,
  takeOverStaleLock,
  writeA2ASigningKey,
  writePeerCredential,
  writeProjectCredential,
} from '../src/credentials.js';
import { normalizeProjectPath } from '../src/projectPath.js';

const ROOT = '/work/acme-api';
let home: string;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-cred-a2a-')));
  process.env.DISPATCH_HOME = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeRaw(entry: unknown): void {
  mkdirSync(dirname(credentialsPath()), { recursive: true });
  writeFileSync(
    credentialsPath(),
    JSON.stringify({ projects: { [normalizeProjectPath(ROOT)]: entry } })
  );
}

describe('peer credentials', () => {
  it('round-trips a bearer and a header API key per alias, in a 0600 file', () => {
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 'tok-1' });
    writePeerCredential(ROOT, 'beta', {
      scheme: 'api-key',
      token: 'k-2',
      header: 'X-API-Key',
    });
    expect(readPeerCredential(ROOT, 'acme')).toEqual({
      scheme: 'bearer',
      token: 'tok-1',
    });
    expect(readPeerCredential(ROOT, 'beta')).toEqual({
      scheme: 'api-key',
      token: 'k-2',
      header: 'X-API-Key',
    });
    expect(readPeerCredential(ROOT, 'gamma')).toBeNull();
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('replaces an alias on a second write', () => {
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 'old' });
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 'new' });
    expect(readPeerCredential(ROOT, 'acme')?.token).toBe('new');
  });

  it('leaves the linear and typesafe slots alone, and they leave it alone', () => {
    writeProjectCredential(ROOT, 'linear', { apiKey: 'lin' });
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 'tok' });
    writeProjectCredential(ROOT, 'typesafe', { apiKey: 'ts' });
    expect(readCredentials().projects?.[normalizeProjectPath(ROOT)]).toEqual({
      linear: { apiKey: 'lin' },
      typesafe: { apiKey: 'ts' },
      a2a: { peers: { acme: { scheme: 'bearer', token: 'tok' } } },
    });
    clearProjectCredential(ROOT, 'linear');
    clearProjectCredential(ROOT, 'typesafe');
    expect(readPeerCredential(ROOT, 'acme')?.token).toBe('tok');
  });

  it('clears one alias, then the a2a slot, then an emptied project entry', () => {
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 'a' });
    writePeerCredential(ROOT, 'beta', { scheme: 'bearer', token: 'b' });
    clearPeerCredential(ROOT, 'acme');
    expect(readPeerCredential(ROOT, 'acme')).toBeNull();
    expect(readPeerCredential(ROOT, 'beta')).not.toBeNull();
    clearPeerCredential(ROOT, 'beta');
    expect(readCredentials().projects).toBeUndefined();
    clearPeerCredential(ROOT, 'beta');
  });

  it('reads a malformed slot as no credential', () => {
    writeRaw({ a2a: { peers: { acme: { scheme: 'oauth2', token: 7 } } } });
    expect(readPeerCredential(ROOT, 'acme')).toBeNull();
    writeRaw({ a2a: { peers: { acme: { scheme: 'bearer', token: '' } } } });
    expect(readPeerCredential(ROOT, 'acme')).toBeNull();
    writeRaw({ a2a: { peers: 'acme' } });
    expect(readPeerCredential(ROOT, 'acme')).toBeNull();
    writeRaw({ a2a: null });
    expect(readPeerCredential(ROOT, 'acme')).toBeNull();
  });

  it('never reads an inherited property as a credential', () => {
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 'a' });
    expect(readPeerCredential(ROOT, '__proto__')).toBeNull();
    expect(readPeerCredential(ROOT, 'constructor')).toBeNull();
  });
});

describe('the A2A card-signing key', () => {
  const KEY = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' };

  it('round-trips per project in the 0600 file', () => {
    expect(readA2ASigningKey(ROOT)).toEqual({ status: 'absent' });
    writeA2ASigningKey(ROOT, KEY);
    expect(readA2ASigningKey(ROOT)).toEqual({ status: 'ok', jwk: KEY });
    expect(readA2ASigningKey('/work/other')).toEqual({ status: 'absent' });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('lives beside the peer credentials without either disturbing the other', () => {
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 't' });
    writeA2ASigningKey(ROOT, KEY);
    writePeerCredential(ROOT, 'beta', { scheme: 'bearer', token: 'b' });
    expect(readA2ASigningKey(ROOT)).toEqual({ status: 'ok', jwk: KEY });
    clearPeerCredential(ROOT, 'acme');
    clearPeerCredential(ROOT, 'beta');
    expect(readA2ASigningKey(ROOT)).toEqual({ status: 'ok', jwk: KEY });
    expect(readPeerCredential(ROOT, 'acme')).toBeNull();
  });

  it('tells a malformed key apart from an absent one', () => {
    writeRaw({ a2a: { signingKey: { kty: 7 } } });
    expect(readA2ASigningKey(ROOT)).toEqual({ status: 'malformed' });
    writeRaw({ a2a: { signingKey: 'x' } });
    expect(readA2ASigningKey(ROOT)).toEqual({ status: 'malformed' });
  });
});

describe('a credentials file that cannot be parsed', () => {
  const BROKEN = '{"projects": {"/work/x": {"linear": {"apiKey": "k"},}}}\n';

  function writeBroken(): void {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), BROKEN);
  }

  it('is never written over, by any writer', () => {
    writeBroken();
    const writers = [
      () => writeA2ASigningKey(ROOT, { kty: 'EC', d: 'd' }),
      () => writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 't' }),
      () => writeProjectCredential(ROOT, 'linear', { apiKey: 'k2' }),
      // A clear cannot tell whether the secret is still in there.
      () => clearProjectCredential(ROOT, 'linear'),
      () => clearPeerCredential(ROOT, 'acme'),
    ];
    for (const write of writers)
      expect(write).toThrow(CredentialsUnreadableError);
    expect(readFileSync(credentialsPath(), 'utf8')).toBe(BROKEN);
    expect(existsSync(`${credentialsPath()}.lock`)).toBe(false);
  });

  it('reads the signing key as unreadable, not absent', () => {
    writeBroken();
    expect(readA2ASigningKey(ROOT)).toEqual({ status: 'unreadable' });
  });

  it('never quotes the file in its error', () => {
    writeBroken();
    let message = '';
    try {
      writeA2ASigningKey(ROOT, { kty: 'EC', d: 'd' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('cannot be parsed');
    expect(message).not.toContain('apiKey');
  });
});

describe('concurrent writers', () => {
  const SRC = join(import.meta.dir, '../src/credentials.ts');

  // Each child writes `count` peers, one read-modify-write at a time.
  const writer = (tag: string, count: number) =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { writePeerCredential } = await import(${JSON.stringify(SRC)});
         for (let i = 0; i < ${count}; i++)
           writePeerCredential(${JSON.stringify(ROOT)}, '${tag}-' + i, { scheme: 'bearer', token: 't' });`,
      ],
      { env: { ...process.env, DISPATCH_HOME: home }, stderr: 'pipe' }
    );

  it('lose no update when two processes write at once', async () => {
    const children = [writer('a', 25), writer('b', 25)];
    for (const child of children) expect(await child.exited).toBe(0);
    for (const tag of ['a', 'b'])
      for (let i = 0; i < 25; i += 1)
        expect(readPeerCredential(ROOT, `${tag}-${i}`)).not.toBeNull();
    expect(existsSync(`${credentialsPath()}.lock`)).toBe(false);
  });

  // The pid of a process that has already exited.
  const deadPid = async () => {
    const child = Bun.spawn([process.execPath, '-e', '0']);
    await child.exited;
    return child.pid;
  };

  // A writer that waits at a barrier file, so every child meets the stale lock
  // in the same instant.
  const racer = (tag: string, count: number, go: string) =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { existsSync } = await import('node:fs');
         const { writePeerCredential } = await import(${JSON.stringify(SRC)});
         while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1);
         for (let i = 0; i < ${count}; i++)
           writePeerCredential(${JSON.stringify(ROOT)}, '${tag}-' + i, { scheme: 'bearer', token: 't' });`,
      ],
      { env: { ...process.env, DISPATCH_HOME: home }, stderr: 'pipe' }
    );

  it('lose no update when eight writers race to take over a dead holder’s lock', async () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    const lock = `${credentialsPath()}.lock`;
    const dead = await deadPid();
    const tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    let lost = 0;
    for (let round = 0; round < 6; round += 1) {
      rmSync(credentialsPath(), { force: true });
      writeFileSync(lock, `${dead} abandoned-${round}\n`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const go = join(home, `go-${round}`);
      const children = tags.map((tag) => racer(tag, 5, go));
      await Bun.sleep(400);
      writeFileSync(go, '');
      for (const child of children) expect(await child.exited).toBe(0);
      for (const tag of tags)
        for (let i = 0; i < 5; i += 1)
          if (readPeerCredential(ROOT, `${tag}-${i}`) === null) lost += 1;
      expect(existsSync(lock)).toBe(false);
    }
    expect(lost).toBe(0);
  }, 120_000);

  it('a takeover judged on an old lock never removes the lock that replaced it', async () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    const lock = `${credentialsPath()}.lock`;
    const judged = `${await deadPid()} abandoned\n`;
    writeFileSync(lock, judged);
    // A judged it stale, took it over, and now holds a lock of its own.
    takeOverStaleLock(lock, judged);
    const fresh = `${process.pid} a-nonce\n`;
    writeFileSync(lock, fresh);
    // B judged the same old lock stale before A acted; its takeover is late.
    takeOverStaleLock(lock, judged);
    expect(readFileSync(lock, 'utf8')).toBe(fresh);
    expect(
      readdirSync(dirname(lock)).filter((n) => n.includes('.lock.'))
    ).toEqual([]);
  });

  it('judges a lock stale only when its holder has exited or it is old', async () => {
    const now = Date.now();
    expect(isStaleLock(`${await deadPid()} n\n`, now, now)).toBe(true);
    expect(isStaleLock(`${process.pid} n\n`, now, now)).toBe(false);
    expect(isStaleLock(`${process.pid} n\n`, now - 60_000, now)).toBe(true);
    expect(isStaleLock('', now, now)).toBe(false);
    expect(isStaleLock('', now - 60_000, now)).toBe(true);
  });

  it('takes over a fresh lock at once when its holder has exited', async () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    const lock = `${credentialsPath()}.lock`;
    writeFileSync(lock, `${await deadPid()} gone\n`);
    const started = Date.now();
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 't' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over a lock its holder left behind', () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    const lock = `${credentialsPath()}.lock`;
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    writePeerCredential(ROOT, 'acme', { scheme: 'bearer', token: 't' });
    expect(readPeerCredential(ROOT, 'acme')?.token).toBe('t');
    expect(existsSync(lock)).toBe(false);
  });
});
