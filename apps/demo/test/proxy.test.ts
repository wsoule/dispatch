import { describe, expect, test } from 'bun:test';

import { parseSessionPath, proxyHttp } from '../src/proxy.js';

describe('parseSessionPath', () => {
  test('routes html, api, ws, alive', () => {
    expect(parseSessionPath('/s/ab12cd34ab12cd34/')).toEqual({
      id: 'ab12cd34ab12cd34',
      kind: 'html',
      rest: '',
    });
    expect(parseSessionPath('/s/ab12cd34ab12cd34')).toEqual({
      id: 'ab12cd34ab12cd34',
      kind: 'html',
      rest: '',
    });
    expect(parseSessionPath('/s/ab12cd34ab12cd34/api/tasks')).toEqual({
      id: 'ab12cd34ab12cd34',
      kind: 'api',
      rest: '/api/tasks',
    });
    expect(parseSessionPath('/s/ab12cd34ab12cd34/ws')).toEqual({
      id: 'ab12cd34ab12cd34',
      kind: 'ws',
      rest: '/ws',
    });
    expect(parseSessionPath('/s/ab12cd34ab12cd34/alive')).toEqual({
      id: 'ab12cd34ab12cd34',
      kind: 'alive',
      rest: '',
    });
    expect(parseSessionPath('/assets/x.js')).toBeNull();
    expect(parseSessionPath('/s/short/api/tasks')).toBeNull(); // ids are exactly 16 hex
    expect(parseSessionPath('/s/ab12cd34ab12cd34ab/api/tasks')).toBeNull(); // 18 hex, too long
    expect(parseSessionPath('/s/ab12cd34ab12cd34/other')).toBeNull(); // unknown suffix
  });
});

// Bun.serve({ port: 0 }) always binds a TCP port synchronously; the return
// type keeps `port` optional for unix-socket servers, which this never is.
function requirePort(server: ReturnType<typeof Bun.serve>): number {
  const port = server.port;
  if (port === undefined) throw new Error('server did not bind a port');
  return port;
}

// Captures what the upstream handler observed via a resolvable promise
// rather than a shared `let` — reading a `let` mutated only inside an async
// closure hits a TypeScript control-flow quirk that keeps it narrowed to its
// initial value at the read site, and a promise also guarantees the handler
// actually ran before we assert on it.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('proxyHttp', () => {
  test('strips Origin and forwards method/body/auth', async () => {
    const seen = deferred<{
      origin: string | null;
      authorization: string | null;
      body: string;
    }>();
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.resolve({
          origin: req.headers.get('origin'),
          authorization: req.headers.get('authorization'),
          body: await req.text(),
        });
        return new Response('ok');
      },
    });
    try {
      const req = new Request(
        'https://public.example/s/ab12cd34ab12cd34/api/tasks',
        {
          method: 'POST',
          headers: {
            origin: 'https://public.example',
            authorization: 'Bearer t',
            'content-type': 'application/json',
          },
          body: '{"x":1}',
        }
      );
      const res = await proxyHttp(req, requirePort(upstream), '/api/tasks');
      expect(res.status).toBe(200);
      const result = await seen.promise;
      expect(result.origin).toBeNull();
      expect(result.authorization).toBe('Bearer t');
      expect(result.body).toBe('{"x":1}');
    } finally {
      void upstream.stop(true);
    }
  });

  test('strips the host header so the upstream sees its own', async () => {
    const seen = deferred<string | null>();
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seen.resolve(req.headers.get('host'));
        return new Response('ok');
      },
    });
    try {
      const port = requirePort(upstream);
      const req = new Request(
        'https://public.example/s/ab12cd34ab12cd34/api/tasks'
      );
      await proxyHttp(req, port, '/api/tasks');
      expect(await seen.promise).toBe(`127.0.0.1:${port}`);
    } finally {
      void upstream.stop(true);
    }
  });

  test('GET requests carry no body', async () => {
    const seen = deferred<boolean>();
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seen.resolve(req.body !== null);
        return new Response('ok');
      },
    });
    try {
      const req = new Request(
        'https://public.example/s/ab12cd34ab12cd34/api/tasks'
      );
      const res = await proxyHttp(req, requirePort(upstream), '/api/tasks');
      expect(res.status).toBe(200);
      expect(await seen.promise).toBe(false);
    } finally {
      void upstream.stop(true);
    }
  });
});
