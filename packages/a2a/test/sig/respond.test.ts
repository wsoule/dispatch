import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import { ecThumbprint } from '../../src/sig/keys.js';
import { signResponseFor } from '../../src/sig/respond.js';
import { verifyResponse } from '../../src/sig/verify.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const keyid = ecThumbprint(
  publicKey.export({ format: 'jwk' }) as Record<string, string>
)!;

describe('signResponseFor', () => {
  it('covers the content type a string body only gets when it is sent', async () => {
    const request = {
      method: 'POST',
      targetUri: 'https://agent.example.com/a2a/v1/dispatch/unpair',
      headers: new Headers({ signature: 'a2a=:AAAA:' }),
    };
    const signed = await signResponseFor(
      new Response('not found', { status: 404 }),
      request,
      { keyid, privateKey }
    );
    // Through a real server, as a client receives it.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => signed,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      const body = new Uint8Array(await res.arrayBuffer());
      const verdict = verifyResponse(
        { status: res.status, headers: res.headers, body },
        request,
        {
          keyFor: (id) => (id === keyid ? publicKey : null),
          now: new Date(),
          guardMs: 300_000,
        }
      );
      expect(verdict.ok).toBe(true);
      expect(res.headers.get('content-type')).toStartWith('text/plain');
    } finally {
      await server.stop(true);
    }
  });
});
