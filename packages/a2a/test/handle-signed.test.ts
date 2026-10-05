import { DEFAULT_A2A } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import type { AuthResult, BridgePort, Caller } from '../src/port.js';
import { handleA2A } from '../src/server/handle.js';
import { IpLimiter } from '../src/server/limits.js';

const caller: Caller = {
  address: 'agent:wyat/a2a.acme',
  name: 'a2a.acme',
  keyid: 'tp-1',
};

// A port whose signed check answers `result`, and which marks what it signs.
function port(result: AuthResult): { port: BridgePort; signed: number[] } {
  const signed: number[] = [];
  const p = {
    authenticate: () =>
      Promise.resolve({
        ok: false,
        status: 401,
        reason: 'AUTH_INVALID_TOKEN',
        message: 'no',
      }),
    authenticateSigned: () => Promise.resolve(result),
    signResponse: (res: Response) => {
      signed.push(res.status);
      const headers = new Headers(res.headers);
      headers.set('signature', 'a2a=:signed:');
      return Promise.resolve(
        new Response(res.body, { status: res.status, headers })
      );
    },
    admit: () => Promise.resolve({ ok: true }),
  } as unknown as BridgePort;
  return { port: p, signed };
}

const request = () =>
  new Request('https://agent.example/a2a/v1/tasks/t-1', {
    headers: {
      'a2a-version': '1.0',
      'signature-input': 'a2a=();tag="dispatch-a2a-sig-v1"',
    },
  });

const options = {
  basePath: '/a2a/v1' as const,
  policy: DEFAULT_A2A,
  clientIp: '127.0.0.1',
  limiter: new IpLimiter(),
};

describe('replies to a signature that verified but was refused (review J1)', () => {
  it('signs a 401 for a client whose signature verified but who may not call', async () => {
    const { port: p, signed } = port({
      ok: false,
      status: 401,
      reason: 'AUTH_AGENT_REVOKED',
      message: 'revoked',
      verified: caller,
    });
    const res = await handleA2A(request(), p, options);
    expect(res.status).toBe(401);
    expect(signed).toEqual([401]);
    expect(res.headers.get('signature')).toBe('a2a=:signed:');
  });

  it('answers a key at its nonce cap with a signed 429', async () => {
    const { port: p, signed } = port({
      ok: false,
      status: 429,
      reason: 'AUTH_BUSY',
      message: 'busy',
      retryAfterSec: 30,
      verified: caller,
    });
    const res = await handleA2A(request(), p, options);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(signed).toEqual([429]);
  });

  it('never signs a refusal whose signature did not verify', async () => {
    const { port: p, signed } = port({
      ok: false,
      status: 401,
      reason: 'AUTH_INVALID_TOKEN',
      message: 'no',
    });
    const res = await handleA2A(request(), p, options);
    expect(res.status).toBe(401);
    expect(signed).toEqual([]);
  });
});
