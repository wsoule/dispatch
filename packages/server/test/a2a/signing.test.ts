import { cardJson, verifyCardSignature } from '@dispatch-foo/a2a';
import {
  credentialsPath,
  normalizeProjectPath,
  writeA2ANextSigningKey,
  writeA2ASigningKey,
} from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  CardSigner,
  finishRotation,
  KEY_OVERLAP_MS,
  loadOrCreateSigningKey,
  loadSigningKeys,
} from '../../src/a2a/signing.js';
import { useTempProject } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();

describe('the signing key', () => {
  it('is made once per project in the 0600 credentials file, and reused with the same kid', () => {
    const first = loadOrCreateSigningKey(project.root());
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(loadOrCreateSigningKey(project.root()).kid).toBe(first.kid);
    expect(first.publicJwk).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      kid: first.kid,
    });
    expect(first.publicJwk).not.toHaveProperty('d');
    expect(readFileSync(credentialsPath(), 'utf8')).toContain(
      first.privateJwk.d
    );
  });
});

describe('a stored key it cannot use', () => {
  const p256 = () =>
    generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      format: 'jwk',
    }) as Record<string, string>;

  it('refuses a well-formed but bogus key', () => {
    writeA2ASigningKey(project.root(), {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAA',
      y: 'BBBB',
      d: 'CCCC',
    });
    expect(() => loadOrCreateSigningKey(project.root())).toThrow(
      'not a usable ES256 private key'
    );
  });

  it('refuses a key whose d does not belong to its x and y', () => {
    const a = p256();
    const b = p256();
    writeA2ASigningKey(project.root(), { ...a, d: b.d });
    expect(() => loadOrCreateSigningKey(project.root())).toThrow(
      'not a usable ES256 private key'
    );
  });

  it('refuses a malformed slot rather than replacing it', () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    const key = normalizeProjectPath(project.root());
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        projects: { [key]: { a2a: { signingKey: { kty: 7 } } } },
      })
    );
    const before = readFileSync(credentialsPath(), 'utf8');
    expect(() => loadOrCreateSigningKey(project.root())).toThrow();
    expect(readFileSync(credentialsPath(), 'utf8')).toBe(before);
  });

  it('never makes a key when the credentials file cannot be parsed', () => {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    const broken = '{"projects": {},}\n';
    writeFileSync(credentialsPath(), broken);
    expect(() => loadOrCreateSigningKey(project.root())).toThrow(
      'cannot be parsed'
    );
    expect(readFileSync(credentialsPath(), 'utf8')).toBe(broken);
  });
});

describe('the daemon card', () => {
  let f: Awaited<ReturnType<typeof bridgeFixture>>;
  let signer: CardSigner;
  beforeEach(async () => {
    f = await bridgeFixture(project.root());
    signer = new CardSigner(loadOrCreateSigningKey(project.root()));
    f.deps.signer = () => signer;
  });
  afterEach(() => f.close());

  it('is signed with jku at the public URL it is built for, and verifies', async () => {
    const inputs = await f.port.card({
      publicUrl: 'https://relay.example.com',
    });
    const [signature] = inputs.signatures ?? [];
    const header = JSON.parse(
      Buffer.from(signature.protected, 'base64url').toString('utf8')
    ) as { jku: string; kid: string };
    expect(header.jku).toBe('https://relay.example.com/.well-known/jwks.json');
    const key = inputs.jwks?.keys.find((k) => k.kid === header.kid);
    const served = JSON.parse(JSON.stringify(cardJson(inputs))) as Record<
      string,
      unknown
    >;
    await expect(
      verifyCardSignature(served, () => Promise.resolve(key as never))
    ).resolves.toBe(true);
  });

  it('publishes public keys only', async () => {
    const inputs = await f.port.card();
    const text = JSON.stringify(inputs.jwks);
    expect(inputs.jwks?.keys).toHaveLength(1);
    expect(inputs.jwks?.keys[0]).not.toHaveProperty('d');
    expect(text).not.toContain(
      loadOrCreateSigningKey(project.root()).privateJwk.d
    );
  });

  it('signs once per distinct card, again for another public URL, and turns push off for a standalone host', async () => {
    const a = await f.port.card();
    const b = await f.port.card();
    expect(b.signatures).toEqual(a.signatures);
    const relay = await f.port.card({
      publicUrl: 'https://relay.example.com',
      standalone: true,
    });
    expect(relay.signatures).not.toEqual(a.signatures);
    expect(relay.pushNotifications).toBe(false);
    expect(a.pushNotifications).toBe(true);
  });

  it('serves the card unsigned when there is no signer', async () => {
    f.deps.signer = () => null;
    const inputs = await f.port.card();
    expect(inputs.signatures).toBeUndefined();
    expect(inputs.jwks).toBeUndefined();
  });
});

describe('a rotation’s overlap', () => {
  const p256 = () =>
    generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      format: 'jwk',
    }) as Record<string, string>;
  const AT = new Date('2026-10-01T00:00:00Z');

  it('signs the card with both keys, serves both, and signs requests with the new key', async () => {
    const k1 = loadOrCreateSigningKey(project.root());
    await writeA2ANextSigningKey(
      project.root(),
      { jwk: p256(), at: AT.toISOString() },
      '{}'
    );
    const keys = loadSigningKeys(project.root(), new Date(AT.getTime() + 1000));
    expect(keys.current.kid).toBe(k1.kid);
    const k2 = keys.next!.key;
    const signer = new CardSigner(keys);
    expect(signer.requestKey().keyid).toBe(k2.kid);
    expect(signer.oldKey()?.keyid).toBe(k1.kid);
    expect(
      signer
        .jwks()
        .keys.map((k) => (typeof k.kid === 'string' ? k.kid : ''))
        .sort((x, y) => x.localeCompare(y))
    ).toEqual([k1.kid, k2.kid].sort((x, y) => x.localeCompare(y)));
    const f = await bridgeFixture(project.root());
    try {
      f.deps.signer = () => signer;
      const inputs = await f.port.card();
      const served = JSON.parse(JSON.stringify(cardJson(inputs))) as Record<
        string,
        unknown
      >;
      for (const only of [k1, k2])
        await expect(
          verifyCardSignature(served, (kid) =>
            kid === only.kid
              ? Promise.resolve(only.publicJwk as never)
              : Promise.reject(new Error('no'))
          )
        ).resolves.toBe(true);
    } finally {
      f.close();
    }
  });

  it('promotes the new key once the overlap is over, and the old key is gone', async () => {
    const k1 = loadOrCreateSigningKey(project.root());
    await writeA2ANextSigningKey(
      project.root(),
      { jwk: p256(), at: AT.toISOString() },
      '{}'
    );
    const during = loadSigningKeys(
      project.root(),
      new Date(AT.getTime() + KEY_OVERLAP_MS - 1)
    );
    expect(during.next).not.toBeNull();
    const after = loadSigningKeys(
      project.root(),
      new Date(AT.getTime() + KEY_OVERLAP_MS)
    );
    expect(after.next).toBeNull();
    expect(after.current.kid).toBe(during.next!.key.kid);
    // Within the overlap nothing is deleted; after it, finishing does.
    expect(
      await finishRotation(
        project.root(),
        new Date(AT.getTime() + KEY_OVERLAP_MS - 1)
      )
    ).toBe(false);
    expect(
      await finishRotation(
        project.root(),
        new Date(AT.getTime() + KEY_OVERLAP_MS)
      )
    ).toBe(true);
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain(
      k1.privateJwk.d
    );
    expect(KEY_OVERLAP_MS).toBe(7 * 24 * 3600 * 1000);
  });
});
