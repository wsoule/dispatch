import { describe, expect, it } from 'bun:test';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { ecThumbprint } from '../../src/sig/keys.js';
import { signRequest, signResponse } from '../../src/sig/sign.js';
import { verifyRequest, verifyResponse } from '../../src/sig/verify.js';
import type { VerifyFacts } from '../../src/sig/verify.js';

const GUARD = 5 * 60_000;
const NOW = new Date('2026-10-05T12:00:00.000Z');

function keyPair(): {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyid: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { privateKey, publicKey, keyid: ecThumbprint(jwk)! };
}

const alice = keyPair();
const mallory = keyPair();

function facts(over: Partial<VerifyFacts> = {}): VerifyFacts {
  const seen = new Set<string>();
  return {
    configuredOrigin: 'https://agent.example',
    keyFor: (id) => (id === alice.keyid ? alice.publicKey : null),
    now: NOW,
    guardMs: GUARD,
    rememberNonce: (id, nonce) => {
      const key = `${id} ${nonce}`;
      if (seen.has(key)) return 'replay';
      seen.add(key);
      return 'fresh';
    },
    ...over,
  };
}

const body = new TextEncoder().encode('{"message":{"messageId":"m-1"}}');

// A request as the signer sends it and as the verifier receives it.
function signed(
  over: {
    targetUri?: string;
    now?: Date;
    key?: typeof alice;
    body?: Uint8Array | null;
    headers?: Record<string, string>;
  } = {}
) {
  const headers = new Headers({
    'content-type': 'application/json',
    'a2a-version': '1.0',
    ...over.headers,
  });
  const b = over.body === undefined ? body : over.body;
  const key = over.key ?? alice;
  const out = signRequest({
    method: 'POST',
    targetUri: over.targetUri ?? 'https://agent.example/a2a/v1/message:send',
    headers,
    body: b,
    keyid: key.keyid,
    privateKey: key.privateKey,
    now: over.now ?? NOW,
  });
  for (const [k, v] of Object.entries(out)) headers.set(k, v);
  return {
    method: 'POST',
    path: '/a2a/v1/message:send',
    query: '',
    headers,
    body: b,
  };
}

describe('signed requests', () => {
  it('verifies a request signed by a pinned key', () => {
    expect(verifyRequest(signed(), facts())).toEqual({
      ok: true,
      keyid: alice.keyid,
    });
  });

  it('signs a body-less GET without a digest, binding its query through the target URI', () => {
    const headers = new Headers({ 'a2a-version': '1.0' });
    const out = signRequest({
      method: 'GET',
      targetUri: 'https://agent.example/a2a/v1/tasks?contextId=c-1',
      headers,
      body: null,
      keyid: alice.keyid,
      privateKey: alice.privateKey,
      now: NOW,
    });
    expect(out['content-digest']).toBeUndefined();
    for (const [k, v] of Object.entries(out)) headers.set(k, v);
    const req = {
      method: 'GET',
      path: '/a2a/v1/tasks',
      query: '?contextId=c-1',
      headers,
      body: null,
    };
    expect(verifyRequest(req, facts()).ok).toBe(true);
    expect(verifyRequest({ ...req, query: '?contextId=c-2' }, facts())).toEqual(
      { ok: false, reason: 'sig_bad' }
    );
  });

  it('refuses a request signed for another origin even though Host names this one', () => {
    const req = signed({
      targetUri: 'https://evil.example/a2a/v1/message:send',
      headers: { host: 'agent.example' },
    });
    expect(verifyRequest(req, facts())).toEqual({
      ok: false,
      reason: 'sig_bad',
    });
  });

  it('refuses a body edited after signing, and a missing digest', () => {
    const req = signed();
    expect(
      verifyRequest({ ...req, body: new TextEncoder().encode('{}') }, facts())
    ).toEqual({
      ok: false,
      reason: 'sig_digest',
    });
    req.headers.delete('content-digest');
    expect(verifyRequest(req, facts())).toEqual({
      ok: false,
      reason: 'sig_malformed',
    });
  });

  it('refuses stale, future and over-long windows', () => {
    expect(
      verifyRequest(
        signed({ now: new Date(NOW.getTime() - GUARD - 1000) }),
        facts()
      )
    ).toEqual({
      ok: false,
      reason: 'sig_stale',
    });
    expect(
      verifyRequest(
        signed({ now: new Date(NOW.getTime() + GUARD + 1000) }),
        facts()
      )
    ).toEqual({
      ok: false,
      reason: 'sig_stale',
    });
    const req = signed();
    req.headers.set(
      'signature-input',
      req.headers
        .get('signature-input')!
        .replace(/expires=\d+/, (m) => `expires=${Number(m.slice(8)) + 3600}`)
    );
    expect(verifyRequest(req, facts())).toEqual({
      ok: false,
      reason: 'sig_stale',
    });
  });

  it('refuses a replay, and a key at its nonce cap', () => {
    const f = facts();
    const req = signed();
    expect(verifyRequest(req, f).ok).toBe(true);
    // The signature verified, so the refusal names the key that made it.
    expect(verifyRequest(req, f)).toEqual({
      ok: false,
      reason: 'sig_replay',
      keyid: alice.keyid,
    });
    expect(
      verifyRequest(signed(), facts({ rememberNonce: () => 'full' }))
    ).toEqual({
      ok: false,
      reason: 'sig_busy',
      keyid: alice.keyid,
    });
  });

  it('consumes no nonce for a signature that does not verify', () => {
    let remembered = 0;
    const f = facts({
      rememberNonce: () => {
        remembered += 1;
        return 'fresh';
      },
    });
    expect(
      verifyRequest(signed({ key: { ...mallory, keyid: alice.keyid } }), f)
    ).toEqual({ ok: false, reason: 'sig_bad' });
    expect(remembered).toBe(0);
  });

  it('refuses an unknown key, a missing signature, and a request without A2A-Version', () => {
    expect(verifyRequest(signed({ key: mallory }), facts())).toEqual({
      ok: false,
      reason: 'sig_key_unknown',
    });
    const bare = {
      method: 'POST',
      path: '/a2a/v1/message:send',
      query: '',
      headers: new Headers(),
      body,
    };
    expect(verifyRequest(bare, facts())).toEqual({
      ok: false,
      reason: 'sig_missing',
    });
    const headers = new Headers({ 'content-type': 'application/json' });
    // A2A-Version is required: signing around it is refused, never skipped.
    expect(() =>
      signRequest({
        method: 'POST',
        targetUri: 'https://agent.example/a2a/v1/message:send',
        headers,
        body,
        keyid: alice.keyid,
        privateKey: alice.privateKey,
        now: NOW,
      })
    ).toThrow();
  });

  it('refuses another algorithm, two tagged signatures, and a non-P-256 key', () => {
    const req = signed();
    req.headers.set(
      'signature-input',
      req.headers
        .get('signature-input')!
        .replace('ecdsa-p256-sha256', 'ed25519')
    );
    expect(verifyRequest(req, facts())).toEqual({
      ok: false,
      reason: 'sig_malformed',
    });

    const twice = signed();
    const input = twice.headers.get('signature-input')!;
    const sig = twice.headers.get('signature')!;
    twice.headers.set(
      'signature-input',
      `${input}, ${input.replace(/^a2a=/, 'b=')}`
    );
    twice.headers.set('signature', `${sig}, ${sig.replace(/^a2a=/, 'b=')}`);
    expect(verifyRequest(twice, facts())).toEqual({
      ok: false,
      reason: 'sig_malformed',
    });

    const ed = generateKeyPairSync('ed25519').publicKey;
    expect(verifyRequest(signed(), facts({ keyFor: () => ed }))).toEqual({
      ok: false,
      reason: 'sig_malformed',
    });
  });

  it('ignores a signature an intermediary added under another tag', () => {
    const req = signed();
    req.headers.set(
      'signature-input',
      `proxy=("@method");created=1;tag="other", ${req.headers.get('signature-input')}`
    );
    req.headers.set(
      'signature',
      `proxy=:AAAA:, ${req.headers.get('signature')}`
    );
    expect(verifyRequest(req, facts()).ok).toBe(true);
  });
});

describe('signed responses', () => {
  const request = () => {
    const r = signed();
    return {
      method: 'POST',
      targetUri: 'https://agent.example/a2a/v1/message:send',
      headers: r.headers,
    };
  };
  const respond = (req: ReturnType<typeof request>, key = alice) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const out = signResponse({
      status: 200,
      headers,
      body,
      request: req,
      keyid: key.keyid,
      privateKey: key.privateKey,
      now: NOW,
    });
    for (const [k, v] of Object.entries(out)) headers.set(k, v);
    return { status: 200, headers, body };
  };
  const rf = {
    keyFor: (id: string) => (id === alice.keyid ? alice.publicKey : null),
    now: NOW,
    guardMs: GUARD,
  };

  it('covers every component of the request signature under req', () => {
    const req = request();
    const res = respond(req);
    const input = res.headers.get('signature-input')!;
    for (const c of [
      '"@method";req',
      '"@target-uri";req',
      '"@authority";req',
      '"content-digest";req',
      '"a2a-version";req',
    ])
      expect(input).toContain(c);
    expect(verifyResponse(res, req, rf)).toEqual({
      ok: true,
      keyid: alice.keyid,
    });
  });

  it('refuses a response moved to another request', () => {
    const res = respond(request());
    const other = signed({
      body: new TextEncoder().encode('{"message":{"messageId":"m-2"}}'),
    });
    expect(
      verifyResponse(
        res,
        {
          method: 'POST',
          targetUri: 'https://agent.example/a2a/v1/message:send',
          headers: other.headers,
        },
        rf
      )
    ).toEqual({ ok: false, reason: 'sig_bad' });
  });

  it('refuses a response signed by a key other than the pinned one', () => {
    const req = request();
    expect(verifyResponse(respond(req, mallory), req, rf)).toEqual({
      ok: false,
      reason: 'sig_key_unknown',
    });
  });

  it('refuses a response body edited in transit', () => {
    const req = request();
    const res = respond(req);
    expect(
      verifyResponse({ ...res, body: new TextEncoder().encode('{}') }, req, rf)
    ).toEqual({
      ok: false,
      reason: 'sig_digest',
    });
  });
});

describe('the keys verify needs', () => {
  it('accepts a key object made from a public JWK', () => {
    const jwk = alice.publicKey.export({ format: 'jwk' });
    const again = createPublicKey({ key: jwk, format: 'jwk' });
    expect(verifyRequest(signed(), facts({ keyFor: () => again })).ok).toBe(
      true
    );
    expect(() => createPrivateKey({ key: jwk, format: 'jwk' })).toThrow();
  });
});

describe('review fixes (I1, M1-M4)', () => {
  const getRequest = () => {
    const headers = new Headers({ 'a2a-version': '1.0' });
    const out = signRequest({
      method: 'GET',
      targetUri: 'https://agent.example/a2a/v1/tasks/t-1',
      headers,
      body: null,
      keyid: alice.keyid,
      privateKey: alice.privateKey,
      now: NOW,
    });
    for (const [k, v] of Object.entries(out)) headers.set(k, v);
    return {
      method: 'GET',
      targetUri: 'https://agent.example/a2a/v1/tasks/t-1',
      headers,
    };
  };
  const rf = {
    keyFor: (id: string) => (id === alice.keyid ? alice.publicKey : null),
    now: NOW,
    guardMs: GUARD,
  };

  it('I1: binds a response to its own request, so an identical request cannot take it', () => {
    const first = getRequest();
    const second = getRequest(); // same method, URL and second; another nonce
    const headers = new Headers({ 'content-type': 'application/json' });
    const out = signResponse({
      status: 200,
      headers,
      body,
      request: first,
      keyid: alice.keyid,
      privateKey: alice.privateKey,
      now: NOW,
    });
    for (const [k, v] of Object.entries(out)) headers.set(k, v);
    expect(headers.get('signature-input')).toContain(
      '"signature";key="a2a";req'
    );
    const res = { status: 200, headers, body };
    expect(verifyResponse(res, first, rf).ok).toBe(true);
    expect(verifyResponse(res, second, rf)).toEqual({
      ok: false,
      reason: 'sig_bad',
    });
  });

  it('M1: refuses a path or query that could move the target to another origin', () => {
    const req = signed();
    for (const [path, query] of [
      ['@evil.example/a2a/v1/message:send', ''],
      ['/a2a/v1/message:send?x=1', ''],
      ['/a2a/v1/message:send#f', ''],
      ['/a2a/v1/message:send', 'x=1'],
      ['/a2a/v1/message:send', '?x#y'],
    ])
      expect(verifyRequest({ ...req, path, query }, facts())).toEqual({
        ok: false,
        reason: 'sig_malformed',
      });
    for (const origin of [
      'https://agent.example/base',
      'https://user@agent.example',
      'https://agent.example?q',
      'not a url',
    ])
      expect(
        verifyRequest(signed(), facts({ configuredOrigin: origin }))
      ).toEqual({ ok: false, reason: 'sig_malformed' });
    expect(
      verifyRequest(
        signed(),
        facts({ configuredOrigin: 'https://agent.example/' })
      ).ok
    ).toBe(true);
  });

  it('M2: checks a covered digest against an empty body when none arrived', () => {
    const req = signed();
    expect(verifyRequest({ ...req, body: null }, facts())).toEqual({
      ok: false,
      reason: 'sig_digest',
    });
  });

  it('M3: refuses created or expires written as decimals', () => {
    const req = signed();
    req.headers.set(
      'signature-input',
      req.headers
        .get('signature-input')!
        .replace(/created=(\d+)/, 'created=$1.0')
    );
    expect(verifyRequest(req, facts())).toEqual({
      ok: false,
      reason: 'sig_malformed',
    });
  });

  it('M4: refuses a nonce that is not 22 to 64 base64url characters', () => {
    for (const nonce of [
      'short',
      'has space in it that is long enough',
      'x'.repeat(65),
    ]) {
      const headers = new Headers({
        'content-type': 'application/json',
        'a2a-version': '1.0',
      });
      const out = signRequest({
        method: 'POST',
        targetUri: 'https://agent.example/a2a/v1/message:send',
        headers,
        body,
        keyid: alice.keyid,
        privateKey: alice.privateKey,
        now: NOW,
        nonce,
      });
      for (const [k, v] of Object.entries(out)) headers.set(k, v);
      expect(
        verifyRequest(
          {
            method: 'POST',
            path: '/a2a/v1/message:send',
            query: '',
            headers,
            body,
          },
          facts()
        )
      ).toEqual({ ok: false, reason: 'sig_malformed' });
    }
  });
});
