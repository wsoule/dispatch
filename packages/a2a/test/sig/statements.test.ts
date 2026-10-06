import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import { ecThumbprint, publicJwkOf } from '../../src/sig/keys.js';
import {
  checkKeyChange,
  checkRevocation,
  makeKeyChange,
  makeRevocation,
  parseUnpairNotice,
  unpairNotice,
} from '../../src/sig/statements.js';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const AT = new Date('2026-10-01T00:00:00Z');

describe('unpair notices', () => {
  it('round-trips a notice', () => {
    expect(parseUnpairNotice(unpairNotice(ID, AT))).toEqual({
      id: ID,
      at: AT.toISOString(),
    });
  });

  it('refuses another statement kind, a bad id or a bad time', () => {
    const good = unpairNotice(ID, AT);
    expect(
      parseUnpairNotice({ ...good, tag: 'dispatch-a2a-rotate-v1' })
    ).toBeNull();
    expect(parseUnpairNotice({ ...good, id: 'short' })).toBeNull();
    expect(parseUnpairNotice({ ...good, at: 'yesterday' })).toBeNull();
    expect(parseUnpairNotice([good])).toBeNull();
    expect(parseUnpairNotice(null)).toBeNull();
  });
});

describe('key-change and revocation statements', () => {
  const pair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = publicJwkOf(
      publicKey.export({ format: 'jwk' }) as Record<string, string>
    );
    return { privateKey, jwk, tp: ecThumbprint(jwk)! };
  };
  const k1 = pair();
  const k2 = pair();
  const k3 = pair();

  it('a key change verifies only under the old key, and names the new one', () => {
    const s = makeKeyChange({
      oldJwk: k1.jwk,
      oldKey: k1.privateKey,
      newJwk: k2.jwk,
      at: AT,
    });
    expect(checkKeyChange(s, k1.jwk)).toEqual({
      ok: true,
      newJwk: k2.jwk,
      newThumbprint: k2.tp,
      at: AT.toISOString(),
    });
    // Under another pinned key: the old thumbprint does not match.
    expect(checkKeyChange(s, k3.jwk).ok).toBe(false);
    // Signed by someone else for k1.
    const forged = makeKeyChange({
      oldJwk: k1.jwk,
      oldKey: k3.privateKey,
      newJwk: k2.jwk,
      at: AT,
    });
    expect(checkKeyChange(forged, k1.jwk).ok).toBe(false);
    // A changed field breaks the signature.
    expect(
      checkKeyChange(
        { ...s, at: new Date(AT.getTime() + 1).toISOString() },
        k1.jwk
      ).ok
    ).toBe(false);
  });

  it('is tag-separated: a revocation never passes as a key change, nor the reverse', () => {
    const r = makeRevocation({ oldJwk: k1.jwk, oldKey: k1.privateKey, at: AT });
    expect(checkRevocation(r, k1.jwk)).toEqual({
      ok: true,
      at: AT.toISOString(),
    });
    expect(checkKeyChange(r, k1.jwk).ok).toBe(false);
    const s = makeKeyChange({
      oldJwk: k1.jwk,
      oldKey: k1.privateKey,
      newJwk: k2.jwk,
      at: AT,
    });
    expect(checkRevocation(s, k1.jwk).ok).toBe(false);
    // The same signature over the other tag does not verify.
    expect(
      checkRevocation({ v: 1, revoked: k1.tp, at: s.at, sig: s.sig }, k1.jwk).ok
    ).toBe(false);
  });

  it('refuses a statement for a different old thumbprint, and malformed input', () => {
    const r = makeRevocation({ oldJwk: k1.jwk, oldKey: k1.privateKey, at: AT });
    expect(checkRevocation(r, k2.jwk).ok).toBe(false);
    expect(checkKeyChange({ v: 1 }, k1.jwk).ok).toBe(false);
    expect(checkKeyChange('x', k1.jwk).ok).toBe(false);
    expect(
      checkKeyChange(
        {
          v: 1,
          old: k1.tp,
          new: { kty: 'EC' },
          at: AT.toISOString(),
          sig: 'AA',
        },
        k1.jwk
      ).ok
    ).toBe(false);
  });
});
