import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import {
  checkUpgradeProof,
  makeUpgradeProof,
  upgradeClientBinding,
} from '../../src/pair/upgrade.js';
import { ecThumbprint, publicJwkOf } from '../../src/sig/keys.js';

const NOW = new Date('2026-10-05T00:00:00Z');
const key = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicJwkOf(
    publicKey.export({ format: 'jwk' }) as Record<string, string>
  );
  return { privateKey, jwk, tp: ecThumbprint(jwk)! };
};
const REACH = {
  kind: 'url' as const,
  card: 'https://alice.example.com/.well-known/agent-card.json',
};
const AUD = 'https://bob.example.com';
const BOUND = { audience: AUD, client: upgradeClientBinding('bearer-1') };

describe('upgrade proofs', () => {
  it('prove the key they carry, and name its thumbprint', () => {
    const k = key();
    const proof = makeUpgradeProof({
      reach: REACH,
      name: 'Alice',
      privateKey: k.privateKey,
      jwk: k.jwk,
      now: NOW,
      ...BOUND,
    });
    const checked = checkUpgradeProof(
      JSON.parse(JSON.stringify(proof)),
      NOW,
      BOUND
    );
    expect(checked).toMatchObject({ ok: true, thumbprint: k.tp });
    if (!checked.ok) throw new Error('refused');
    expect(checked.proof.reach).toEqual(REACH);
  });

  it('refuses another key’s signature, an edited field, an old proof, or junk', () => {
    const k = key();
    const other = key();
    const proof = makeUpgradeProof({
      reach: REACH,
      name: 'Alice',
      privateKey: k.privateKey,
      jwk: k.jwk,
      now: NOW,
      ...BOUND,
    });
    expect(checkUpgradeProof({ ...proof, jwk: other.jwk }, NOW, BOUND).ok).toBe(
      false
    );
    expect(
      checkUpgradeProof({ ...proof, name: 'Mallory' }, NOW, BOUND).ok
    ).toBe(false);
    expect(
      checkUpgradeProof(proof, new Date(NOW.getTime() + 11 * 60_000), BOUND).ok
    ).toBe(false);
    expect(checkUpgradeProof('x', NOW, BOUND).ok).toBe(false);
    expect(
      checkUpgradeProof(
        { ...proof, reach: { kind: 'url', card: 'not a url' } },
        NOW,
        BOUND
      ).ok
    ).toBe(false);
  });
});

describe('upgrade proof binding (review N3)', () => {
  it('holds only for the audience and the client credential it names', () => {
    const k = key();
    const proof = makeUpgradeProof({
      reach: REACH,
      name: 'Alice',
      privateKey: k.privateKey,
      jwk: k.jwk,
      now: NOW,
      ...BOUND,
    });
    expect(checkUpgradeProof(proof, NOW, BOUND).ok).toBe(true);
    expect(
      checkUpgradeProof(proof, NOW, {
        ...BOUND,
        audience: 'https://carol.example.com',
      }).ok
    ).toBe(false);
    expect(
      checkUpgradeProof(proof, NOW, {
        ...BOUND,
        client: upgradeClientBinding('bearer-2'),
      }).ok
    ).toBe(false);
    // Changing the named audience breaks the signature.
    expect(
      checkUpgradeProof(
        { ...proof, audience: 'https://carol.example.com' },
        NOW,
        { ...BOUND, audience: 'https://carol.example.com' }
      ).ok
    ).toBe(false);
  });
});
