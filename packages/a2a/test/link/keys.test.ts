import { generateReplicaKeys } from '@dispatch/protocol/federation';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkLinkKeysBinding,
  LINKKEYS_TAG,
  linkKeysBinding,
  loadOrCreateLinkKeys,
} from '../../src/link/keys.js';
import { ecThumbprint, publicJwkOf } from '../../src/sig/keys.js';

const card = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicJwkOf(
    publicKey.export({ format: 'jwk' }) as Record<string, string>
  );
  return { privateKey, jwk, keyid: ecThumbprint(jwk)! };
};
const AT = new Date('2026-10-05T00:00:00Z');

describe('the link-keys binding', () => {
  it('uses its own tag', () => {
    expect(LINKKEYS_TAG).toBe('dispatch-a2a-linkkeys-v1');
  });

  it('verifies under the card key that made it, and no other', () => {
    const c = card();
    const link = generateReplicaKeys();
    const b = linkKeysBinding({ card: c, link, at: AT });
    expect(typeof b.linkSig).toBe('string');
    expect(checkLinkKeysBinding(JSON.parse(JSON.stringify(b)), c.jwk)).toEqual({
      ok: true,
      signPub: link.signPub,
      sealPub: link.sealPub,
    });
    expect(checkLinkKeysBinding(b, card().jwk).ok).toBe(false);
  });

  it('refuses a binding for other link keys', () => {
    const c = card();
    const b = linkKeysBinding({ card: c, link: generateReplicaKeys(), at: AT });
    const other = generateReplicaKeys();
    expect(
      checkLinkKeysBinding({ ...b, signPub: other.signPub }, c.jwk).ok
    ).toBe(false);
    expect(
      checkLinkKeysBinding({ ...b, sealPub: other.sealPub }, c.jwk).ok
    ).toBe(false);
    expect(checkLinkKeysBinding('x', c.jwk).ok).toBe(false);
  });
});

describe('relay re-review N2: the link key proves possession, and keys are real', () => {
  it('refuses a binding whose link signature is missing or by another key', () => {
    const c = card();
    const link = generateReplicaKeys();
    const b = linkKeysBinding({ card: c, link, at: AT });
    const { linkSig: _dropped, ...withoutLinkSig } = b;
    expect(checkLinkKeysBinding(withoutLinkSig, c.jwk).ok).toBe(false);
    const other = linkKeysBinding({
      card: c,
      link: { ...link, signPriv: generateReplicaKeys().signPriv },
      at: AT,
    });
    expect(checkLinkKeysBinding(other, c.jwk).ok).toBe(false);
  });

  it('refuses keys that are not 32-byte Ed25519 and X25519 publics', () => {
    const c = card();
    const link = generateReplicaKeys();
    for (const bad of [
      { ...link, signPub: 'AAAA' },
      { ...link, sealPub: 'AAAA' },
      { ...link, sealPub: Buffer.alloc(32, 0xff).toString('base64url') },
    ])
      expect(
        checkLinkKeysBinding(
          linkKeysBinding({ card: c, link: bad, at: AT }),
          c.jwk
        ).ok
      ).toBe(false);
  });
});

describe('loadOrCreateLinkKeys', () => {
  let home: string;
  const original = process.env.DISPATCH_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'a2a-link-keys-'));
    process.env.DISPATCH_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('makes the keys once and returns the same ones after', async () => {
    const first = await loadOrCreateLinkKeys('/work/acme');
    expect(first).not.toBeNull();
    expect(await loadOrCreateLinkKeys('/work/acme')).toEqual(first);
  });

  it('leaves the feature off, with a warning, when the slot is malformed', async () => {
    const dir = join(home, '.dispatch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({
        projects: { '/work/acme': { a2a: { linkKeys: { signPriv: 'x' } } } },
      }),
      { mode: 0o600 }
    );
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadOrCreateLinkKeys('/work/acme')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
