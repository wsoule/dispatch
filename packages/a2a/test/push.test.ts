import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  deliverPush,
  parsePushConfig,
  PUSH_TOKEN_HEADER,
  pushConfigJson,
  pushHeaders,
} from '../src/push.js';

describe('parsePushConfig', () => {
  it('reads url, token, authentication and a client id, with empty strings as absent', () => {
    expect(
      parsePushConfig({
        id: 'cfg-1',
        url: 'https://hooks.example.com/a2a',
        token: 't',
        authentication: { scheme: 'Bearer', credentials: 'c' },
      })
    ).toEqual({
      id: 'cfg-1',
      url: 'https://hooks.example.com/a2a',
      token: 't',
      authentication: { scheme: 'Bearer', credentials: 'c' },
    });
    expect(
      parsePushConfig({
        id: '',
        url: 'https://hooks.example.com/a2a',
        token: '',
      })
    ).toEqual({ id: null, url: 'https://hooks.example.com/a2a' });
  });

  it.each([
    [{}, 'url'],
    [{ url: 'not a url' }, 'url'],
    [{ url: 'file:///etc/passwd' }, 'url'],
    [{ url: 'https://h.example.com/', token: 'a\nb' }, 'token'],
    [{ url: 'https://h.example.com/', token: 'a b' }, 'token'],
    [
      { url: 'https://h.example.com/', authentication: { credentials: 'c' } },
      'authentication.scheme',
    ],
    [
      {
        url: 'https://h.example.com/',
        authentication: { scheme: 'Bearer', credentials: 'c\r\nX: 1' },
      },
      'authentication.credentials',
    ],
    [{ url: 'https://h.example.com/', id: 'x'.repeat(129) }, 'id'],
  ])('refuses %j on %s', (raw, field) => {
    expect(() => parsePushConfig(raw)).toThrow(
      expect.objectContaining({ code: 'invalid', field })
    );
  });

  it('says what a URL must be', () => {
    expect(() => parsePushConfig({ url: 'ftp://h.example.com/' })).toThrow(
      'url: must be an http or https URL'
    );
  });

  it('never quotes a refused secret in its error', () => {
    for (const raw of [
      { url: 'https://h.example.com/', token: 'SECRET\nx' },
      {
        url: 'https://h.example.com/',
        authentication: { scheme: 'Bearer', credentials: 'SECRET\nx' },
      },
    ]) {
      let message = '';
      try {
        parsePushConfig(raw);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('SECRET');
    }
  });
});

describe('pushConfigJson', () => {
  it('shows a client its config without the token or credentials', () => {
    expect(
      pushConfigJson({
        id: 'cfg-1',
        taskId: 'm-root',
        url: 'https://hooks.example.com/a2a',
        token: 'tok',
        authentication: { scheme: 'Bearer', credentials: 'cred' },
      })
    ).toEqual({
      id: 'cfg-1',
      taskId: 'm-root',
      url: 'https://hooks.example.com/a2a',
      authentication: { scheme: 'Bearer' },
    });
  });
});

describe('delivery', () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const seen: { headers: Headers; body: unknown }[] = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/ok') {
          seen.push({ headers: req.headers, body: await req.json() });
          return new Response(null, { status: 204 });
        }
        if (path === '/moved')
          return new Response(null, {
            status: 302,
            headers: { location: '/ok' },
          });
        if (path === '/hang') return new Promise<Response>(() => undefined);
        return new Response('no', { status: 500 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  // The local test webhook is the one place delivery may skip the guard.
  const LOCAL = { unguarded: true } as const;
  const config = (url: string) => ({
    id: 'cfg-1',
    taskId: 'm-root',
    url,
    token: 'tok',
    authentication: { scheme: 'Bearer', credentials: 'cred' },
  });
  const event = {
    statusUpdate: {
      taskId: 'm-root',
      contextId: 'm-root',
      status: { state: 'TASK_STATE_COMPLETED' as const },
    },
  };

  it('refuses to deliver without a guard or an explicit unguarded opt-out', async () => {
    await expect(
      deliverPush(config(`${base}/ok`), event, {} as never)
    ).rejects.toThrow('guard');
    expect(seen).toHaveLength(0);
  });

  it('posts one StreamResponse with the authentication and token headers', async () => {
    expect(pushHeaders(config(`${base}/ok`))).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer cred',
      [PUSH_TOKEN_HEADER]: 'tok',
    });
    expect(await deliverPush(config(`${base}/ok`), event, LOCAL)).toEqual({
      ok: true,
    });
    expect(seen[0].body).toEqual(event);
    expect(seen[0].headers.get('authorization')).toBe('Bearer cred');
  });

  it('reports a 5xx, a redirect and a timeout as failures', async () => {
    expect(
      await deliverPush(config(`${base}/fail`), event, LOCAL)
    ).toMatchObject({
      ok: false,
      status: 500,
      refused: false,
    });
    expect(
      await deliverPush(config(`${base}/moved`), event, LOCAL)
    ).toMatchObject({
      ok: false,
      status: 302,
    });
    expect(
      await deliverPush(config(`${base}/hang`), event, {
        ...LOCAL,
        timeoutMs: 50,
      })
    ).toMatchObject({ ok: false, status: null });
  });

  it('with a guard, pins the checked address and never posts to a private one', async () => {
    const urls: string[] = [];
    const fetchImpl = ((input: string | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    const hook = config('https://hooks.example.com/a2a');
    expect(
      await deliverPush(hook, event, {
        fetchImpl,
        guard: { lookup: () => Promise.resolve(['93.184.216.34']) },
      })
    ).toEqual({ ok: true });
    expect(urls).toEqual(['https://93.184.216.34/a2a']);
    expect(
      await deliverPush(hook, event, {
        fetchImpl,
        guard: { lookup: () => Promise.resolve(['10.0.0.5']) },
      })
    ).toMatchObject({ ok: false, status: null, refused: true });
    expect(
      await deliverPush(hook, event, {
        fetchImpl,
        guard: { lookup: () => Promise.reject(new Error('EAI_AGAIN')) },
      })
    ).toMatchObject({ ok: false, status: null, refused: false });
    expect(urls).toHaveLength(1);
  });

  it('never puts the token or credentials in an error', async () => {
    const result = await deliverPush(
      { ...config('https://hooks.example.com/a2a'), token: 'SECRET-TOKEN' },
      event,
      {
        fetchImpl: (() =>
          Promise.reject(
            new Error('boom SECRET-TOKEN cred')
          )) as unknown as typeof fetch,
        guard: { lookup: () => Promise.resolve(['93.184.216.34']) },
      }
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(result)).not.toContain('cred');
  });
});
