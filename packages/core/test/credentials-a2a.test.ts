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
import { dirname, join } from 'node:path';

import {
  clearPeerCredential,
  clearProjectCredential,
  credentialsPath,
  readCredentials,
  readPeerCredential,
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
