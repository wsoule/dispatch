import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { exemptLoopbackFromProxy } from '../src/loopbackProxy.js';

describe('exemptLoopbackFromProxy', () => {
  it('adds the loopback names to both spellings of an empty list', () => {
    const env: Record<string, string | undefined> = {};
    exemptLoopbackFromProxy(env);
    expect(env).toEqual({
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    });
  });

  it('keeps every entry already there, in each spelling on its own', () => {
    const env: Record<string, string | undefined> = {
      NO_PROXY: 'corp.internal, .example.com',
      no_proxy: 'localhost',
      HTTP_PROXY: 'http://proxy.corp:3128',
    };
    exemptLoopbackFromProxy(env);
    expect(env).toEqual({
      NO_PROXY: 'corp.internal,.example.com,127.0.0.1,localhost,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      HTTP_PROXY: 'http://proxy.corp:3128',
    });
    // A second call finds nothing missing.
    const once = { ...env };
    exemptLoopbackFromProxy(env);
    expect(env).toEqual(once);
  });

  it('leaves a list that already exempts everything alone', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: '*' };
    exemptLoopbackFromProxy(env);
    expect(env.NO_PROXY).toBe('*');
    expect(env.no_proxy).toBe('127.0.0.1,localhost,::1');
  });

  // The behaviour that matters, in a real Bun process: with HTTP_PROXY and
  // ALL_PROXY pointed at a fake proxy, a fetch to a loopback "daemon" reaches
  // the daemon only after the exemption. The child without it proves the
  // proxy environment is live (its fetch lands on the proxy), so the
  // exempted child's direct answer is the exemption's doing.
  it('keeps a loopback fetch, and its bearer token, off HTTP_PROXY', async () => {
    const proxied: string[] = [];
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        proxied.push(`${req.url} ${req.headers.get('authorization')}`);
        return new Response('proxy');
      },
    });
    const daemon = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('direct'),
    });
    // Runs one child fetch, exempted or not, and returns what it printed.
    const childFetch = async (exempt: boolean): Promise<string> => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/proxy/i.test(key)) env[key] = value;
      }
      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      Object.assign(env, {
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        ALL_PROXY: proxyUrl,
        all_proxy: proxyUrl,
      });
      const script = [
        `import { exemptLoopbackFromProxy } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'loopbackProxy.ts'))};`,
        exempt ? 'exemptLoopbackFromProxy();' : '',
        `const res = await fetch('http://127.0.0.1:${daemon.port}/api/health', { headers: { authorization: 'Bearer secret-token' } });`,
        'process.stdout.write(await res.text());',
      ].join('\n');
      const child = Bun.spawn([process.execPath, '-e', script], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: '' });
      return out;
    };
    try {
      expect(await childFetch(false)).toBe('proxy');
      expect(proxied).toEqual([
        `http://127.0.0.1:${daemon.port}/api/health Bearer secret-token`,
      ]);
      proxied.length = 0;
      expect(await childFetch(true)).toBe('direct');
      expect(proxied).toEqual([]);
    } finally {
      void proxy.stop(true);
      void daemon.stop(true);
    }
  }, 30_000);
});
