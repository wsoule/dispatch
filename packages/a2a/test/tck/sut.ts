import { DEFAULT_A2A } from '@dispatch/core';

import { handleA2A } from '../../src/server/handle.js';
import { IpLimiter } from '../../src/server/limits.js';
import { TckBridgePort } from './tckPort.js';

// Serves handleA2A over the TCK's scenario port. The SUT tests the binding,
// not auth: it supplies a bearer when the TCK sends none.
export function startSut(port = 0): {
  port: number;
  stop: () => Promise<void>;
} {
  const bridge = new TckBridgePort();
  const limiter = new IpLimiter({
    cardPerMinute: 10_000,
    failuresPerMinute: 10_000,
  });
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const headers = new Headers(req.headers);
      if (!headers.has('authorization'))
        headers.set('authorization', 'Bearer tck');
      return handleA2A(new Request(req, { headers }), bridge, {
        basePath: '/a2a/v1',
        policy: DEFAULT_A2A,
        clientIp: '127.0.0.1',
        limiter,
      });
    },
  });
  bridge.publicUrl = `http://127.0.0.1:${server.port}`;
  return { port: server.port ?? 0, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const sut = startSut(Number(process.env.PORT ?? 0));
  console.log(`TCK SUT on http://127.0.0.1:${sut.port}`);
}
