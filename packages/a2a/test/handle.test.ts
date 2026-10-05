import { DEFAULT_A2A } from '@dispatch/core';
import { beforeEach, describe, expect, it } from 'bun:test';

import { handleA2A } from '../src/server/handle.js';
import { IpLimiter } from '../src/server/limits.js';
import { decodePageToken, encodePageToken } from '../src/server/paging.js';
import { ENVELOPE_URI } from '../src/uris.js';
import { facts, msg, ROOT } from './facts.js';
import { FakePort } from './fakePort.js';

let port: FakePort;
let limiter: IpLimiter;
beforeEach(() => {
  port = new FakePort();
  limiter = new IpLimiter();
});

function call(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    ip?: string;
  } = {}
) {
  const headers = new Headers({
    'A2A-Version': '1.0',
    authorization: 'Bearer good',
    'content-type': 'application/json',
    ...init.headers,
  });
  const req = new Request(`http://agent.test${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined
      ? {}
      : {
          body:
            typeof init.body === 'string'
              ? init.body
              : JSON.stringify(init.body),
        }),
  });
  return handleA2A(req, port, {
    basePath: '/a2a/v1',
    policy: DEFAULT_A2A,
    clientIp: init.ip ?? '203.0.113.9',
    limiter,
  });
}

const ask = (over: Record<string, unknown> = {}) => ({
  message: {
    messageId: 'c-1',
    role: 'ROLE_USER',
    parts: [{ text: 'Is /sessions final?' }],
    ...over,
  },
  configuration: { returnImmediately: true },
});

async function reason(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as {
    error?: { details?: { reason?: string }[] };
  };
  return body.error?.details?.[0]?.reason;
}

describe('the extensions a bearer client presents', () => {
  it('passes the A2A-Extensions header to authenticate', async () => {
    await call('/a2a/v1/tasks/x', {
      headers: {
        'A2A-Extensions':
          'https://a.example/x, https://dispatch.foo/a2a/ext/sig/v1',
      },
    });
    expect(port.calls.find((c) => c.method === 'authenticate')?.args).toEqual([
      'good',
      ['https://a.example/x', 'https://dispatch.foo/a2a/ext/sig/v1'],
    ]);
  });
});

describe('routes', () => {
  it('sends an ask and answers with the task as application/json', async () => {
    const res = await call('/a2a/v1/message:send', { body: ask() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as {
      task: { id: string; status: { state: string } };
    };
    expect(body.task).toMatchObject({
      id: 'm-root',
      status: { state: 'TASK_STATE_WORKING' },
    });
    expect(port.calls.find((c) => c.method === 'open')?.args[0]).toMatchObject({
      clientMessageId: 'c-1',
      kind: 'ask',
    });
  });

  it('answers a plain message with a direct agent message', async () => {
    port.onOpen = () => ({
      kind: 'reply',
      text: 'Delivered to human:wyat (m-9).',
      about: { id: 'm-9', thread: 'm-9' },
    });
    const res = await call('/a2a/v1/message:send', {
      body: ask({ metadata: { [ENVELOPE_URI]: { kind: 'notice' } } }),
      headers: { 'A2A-Extensions': ENVELOPE_URI },
    });
    const body = (await res.json()) as { message: Record<string, unknown> };
    expect(body.message).toMatchObject({
      role: 'ROLE_AGENT',
      contextId: 'm-9',
      metadata: { [ENVELOPE_URI]: { id: 'm-9', thread: 'm-9' } },
    });
    expect(res.headers.get('A2A-Extensions')).toBe(ENVELOPE_URI);
  });

  it('gets, lists and cancels', async () => {
    expect((await call('/a2a/v1/tasks/m-root')).status).toBe(200);
    const list = (await (await call('/a2a/v1/tasks')).json()) as {
      tasks: unknown[];
      nextPageToken: string;
      totalSize: number;
    };
    expect(list).toMatchObject({ nextPageToken: '', totalSize: 1 });
    expect(list.tasks).toHaveLength(1);
    expect(
      (await call('/a2a/v1/tasks/m-root:cancel', { method: 'POST', body: {} }))
        .status
    ).toBe(200);
    expect(port.calls.some((c) => c.method === 'cancel')).toBe(true);
  });

  it.each([
    ['POST', '/a2a/v1/tasks/m-root/pushNotificationConfigs'],
    ['GET', '/a2a/v1/tasks/m-root/pushNotificationConfigs/p1'],
    ['GET', '/a2a/v1/tasks/m-root/pushNotificationConfigs'],
    ['DELETE', '/a2a/v1/tasks/m-root/pushNotificationConfigs/p1'],
  ])('%s %s is PUSH_NOTIFICATION_NOT_SUPPORTED', async (method, path) => {
    const res = await call(path, {
      method,
      ...(method === 'POST' ? { body: {} } : {}),
    });
    expect(res.status).toBe(400);
    expect(await reason(res)).toBe('PUSH_NOTIFICATION_NOT_SUPPORTED');
  });

  it('refuses the extended card as UNSUPPORTED_OPERATION', async () => {
    const res = await call('/a2a/v1/extendedAgentCard');
    expect(await reason(res)).toBe('UNSUPPORTED_OPERATION');
  });

  it('404s anything else, 405s OPTIONS and never sends CORS headers', async () => {
    expect((await call('/api/tasks')).status).toBe(404);
    expect((await call('/a2a/v1/nope')).status).toBe(404);
    const options = await call('/a2a/v1/tasks', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test' },
    });
    expect(options.status).toBe(405);
    expect(options.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves the card unauthenticated with an ETag and answers 304 to a match', async () => {
    const res = await call('/.well-known/agent-card.json', {
      headers: { authorization: '', 'A2A-Version': '' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const etag = res.headers.get('etag') ?? '';
    expect(
      (
        await call('/.well-known/agent-card.json', {
          headers: { 'if-none-match': etag },
        })
      ).status
    ).toBe(304);
  });
});

describe('checks in order', () => {
  it('needs A2A-Version 1.0, any patch, in the header or the query', async () => {
    for (const version of ['', '0.3']) {
      const res = await call('/a2a/v1/tasks', {
        headers: { 'A2A-Version': version },
      });
      expect(res.status).toBe(400);
      expect(await reason(res)).toBe('VERSION_NOT_SUPPORTED');
    }
    expect(
      (await call('/a2a/v1/tasks', { headers: { 'A2A-Version': '1.0.1' } }))
        .status
    ).toBe(200);
    expect(
      (
        await call('/a2a/v1/tasks?A2A-Version=1.0', {
          headers: { 'A2A-Version': '' },
        })
      ).status
    ).toBe(200);
  });

  it.each([
    [{ authorization: '' }, 401, 'AUTH_MISSING_TOKEN'],
    [{ authorization: 'Bearer nobody' }, 401, 'AUTH_INVALID_TOKEN'],
    [{ authorization: 'Bearer revoked' }, 401, 'AUTH_AGENT_REVOKED'],
    [{ authorization: 'Bearer pending' }, 403, 'AUTH_AGENT_PENDING'],
  ])('auth %j → %i %s', async (headers, status, why) => {
    const res = await call('/a2a/v1/tasks', { headers });
    expect(res.status).toBe(status);
    expect(await reason(res)).toBe(why);
    if (status === 401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('refuses a token in the query string without looking it up', async () => {
    const res = await call('/a2a/v1/tasks?access_token=good', {
      headers: { authorization: '' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('"field":"query"');
    expect(port.calls.some((c) => c.method === 'authenticate')).toBe(false);
  });

  it('refuses a query token in any letter case', async () => {
    const res = await call('/a2a/v1/tasks?Access_Token=good');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('"field":"query"');
  });

  it('answers 429 with Retry-After when the port refuses the request', async () => {
    port.requestAdmission = { ok: false, retryAfterSec: 7 };
    const res = await call('/a2a/v1/tasks');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
  });

  it('locks out failing requests from one IP but never a valid bearer (the tunnel case)', async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await call('/a2a/v1/tasks', {
            headers: { authorization: 'Bearer nobody' },
          })
        ).status
      ).toBe(401);
    expect(
      (
        await call('/a2a/v1/tasks', {
          headers: { authorization: 'Bearer nobody' },
        })
      ).status
    ).toBe(429);
    expect((await call('/a2a/v1/tasks')).status).toBe(200);
  });

  it('needs a JSON body and caps it at 256 KiB', async () => {
    expect(
      (
        await call('/a2a/v1/message:send', {
          body: ask(),
          headers: { 'content-type': 'text/plain' },
        })
      ).status
    ).toBe(415);
    expect(
      (
        await call('/a2a/v1/message:send', {
          body: ask(),
          headers: { 'content-type': 'application/a2a+json' },
        })
      ).status
    ).toBe(200);
    const big = ask({ parts: [{ text: 'x'.repeat(300 * 1024) }] });
    expect((await call('/a2a/v1/message:send', { body: big })).status).toBe(
      413
    );
  });
});

describe('errors', () => {
  it('404s another client’s task, never 403', async () => {
    const res = await call('/a2a/v1/tasks/m-root', {
      headers: { authorization: 'Bearer other' },
    });
    expect(res.status).toBe(404);
    expect(await reason(res)).toBe('TASK_NOT_FOUND');
  });

  it.each([
    [{ urgent: true }, 'URGENT_NOT_ALLOWED'],
    [{ wake: 'request' }, 'WAKE_NOT_ALLOWED'],
    [{ kind: 'x-deploy' }, 'KIND_NOT_ALLOWED'],
  ])('refuses envelope %j with 403 %s', async (envelope, why) => {
    const res = await call('/a2a/v1/message:send', {
      body: ask({ metadata: { [ENVELOPE_URI]: envelope } }),
    });
    expect(res.status).toBe(403);
    expect(await reason(res)).toBe(why);
  });

  it('maps an invalid field to its A2A path with google.rpc.BadRequest', async () => {
    const res = await call('/a2a/v1/message:send', {
      body: ask({ metadata: { [ENVELOPE_URI]: { choices: 'yes' } } }),
    });
    const body = (await res.json()) as {
      error: {
        status: string;
        details: {
          '@type': string;
          fieldViolations?: { field: string }[];
        }[];
      };
    };
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.details[1].fieldViolations?.[0].field).toBe(
      `message.metadata[${ENVELOPE_URI}].choices`
    );
  });

  it('refuses a continuation of a finished task, and a contextId that is not the task’s', async () => {
    port.tasks.set(
      'm-done',
      facts({
        id: 'm-done',
        answer: msg({ kind: 'answer', replyTo: 'm-root' }),
      })
    );
    const finished = await call('/a2a/v1/message:send', {
      body: ask({ taskId: 'm-done' }),
    });
    expect(await reason(finished)).toBe('UNSUPPORTED_OPERATION');
    const mismatch = await call('/a2a/v1/message:send', {
      body: ask({ taskId: 'm-root', contextId: 'm-elsewhere' }),
    });
    expect(JSON.stringify(await mismatch.json())).toContain(
      '"field":"message.contextId"'
    );
    expect(port.calls.some((c) => c.method === 'continue')).toBe(false);
  });

  it('shows the re-ask sentence when an answer matched no choice', async () => {
    port.onContinue = () => ({ reask: 'Answer with one of: us | eu' });
    const res = await call('/a2a/v1/message:send', {
      body: ask({ taskId: 'm-root', parts: [{ text: 'mars' }] }),
    });
    const body = (await res.json()) as {
      task: { status: { message: { parts: { text: string }[] } } };
    };
    expect(body.task.status.message.parts[0].text).toBe(
      'Answer with one of: us | eu'
    );
  });

  it('frees the stream slot when the stream cannot start', async () => {
    port.watchError = new Error('a2a.db is locked');
    const subscribed = await call('/a2a/v1/tasks/m-root:subscribe');
    const streamed = await call('/a2a/v1/message:stream', {
      body: { message: ask().message },
    });
    expect([subscribed.status, streamed.status]).toEqual([500, 500]);
    expect(port.openStreams).toBe(0);
  });

  it('answers a blocking send whose watch throws with a 500', async () => {
    port.watchError = new Error('a2a.db is locked');
    const res = await call('/a2a/v1/message:send', {
      body: { message: ask().message },
    });
    expect(res.status).toBe(500);
    expect(
      ((await res.json()) as { error: { status: string } }).error.status
    ).toBe('INTERNAL');
  });
});

describe('ListTasks', () => {
  it('normalizes statusTimestampAfter with an offset to UTC before asking the port', async () => {
    await call(
      '/a2a/v1/tasks?statusTimestampAfter=2026-09-25T12:00:00%2B02:00&pageSize=500'
    );
    expect(port.calls.find((c) => c.method === 'list')?.args[0]).toMatchObject({
      after: '2026-09-25T10:00:00.000Z',
      pageSize: 100,
    });
  });

  it('reads pageSize=0 as the default 50', async () => {
    await call('/a2a/v1/tasks?pageSize=0');
    expect(port.calls.find((c) => c.method === 'list')?.args[0]).toMatchObject({
      pageSize: 50,
    });
  });

  it('omits artifacts unless includeArtifacts=true', async () => {
    port.tasks.set(
      'm-root',
      facts({
        answer: msg({ kind: 'answer', replyTo: 'm-root', from: 'human:wyat' }),
      })
    );
    const plain = (await (await call('/a2a/v1/tasks')).json()) as {
      tasks: { artifacts?: unknown }[];
    };
    expect(plain.tasks[0].artifacts).toBeUndefined();
    const full = (await (
      await call('/a2a/v1/tasks?includeArtifacts=true')
    ).json()) as { tasks: { artifacts?: unknown[] }[] };
    expect(full.tasks[0].artifacts).toHaveLength(1);
  });
});

describe('egress', () => {
  it('never writes a gate question’s body even if a port puts one in scope', async () => {
    const gate = msg({
      id: 'm-gate',
      replyTo: 'm-root',
      from: 'agent:dispatch',
      kind: 'question',
      body: 'Run `rm -rf SECRET_INPUT`?',
      data: {
        type: 'tool-approval',
        requestId: 'q',
        runId: 'r-00000a',
        tool: 'Bash',
        input: { command: 'SECRET_INPUT' },
      },
    });
    port.tasks.set('m-root', facts({ scope: [ROOT, gate] }));
    const res = await call('/a2a/v1/tasks/m-root');
    expect(JSON.stringify(await res.json())).not.toContain('SECRET_INPUT');
  });
});

describe('page tokens', () => {
  it('round-trips the store cursor and refuses a token it did not issue', () => {
    const cursor = { statusAt: '2026-09-25T10:00:00.000Z', id: 'm-root' };
    expect(decodePageToken(encodePageToken(cursor))).toEqual(cursor);
    expect(() => decodePageToken('not-a-token')).toThrow('pageToken');
  });
});

describe('IpLimiter', () => {
  it('limits card fetches per minute and frees the window after it', () => {
    let now = 0;
    const cards = new IpLimiter({ now: () => now, cardPerMinute: 2 });
    expect(cards.allowCard('198.51.100.1')).toBeNull();
    expect(cards.allowCard('198.51.100.1')).toBeNull();
    expect(cards.allowCard('198.51.100.1')).toBe(60);
    expect(cards.allowCard('198.51.100.2')).toBeNull();
    now = 60_001;
    expect(cards.allowCard('198.51.100.1')).toBeNull();
  });

  it('locks an IP out after too many auth failures, until the lock expires', () => {
    let now = 0;
    const auth = new IpLimiter({
      now: () => now,
      failuresPerMinute: 2,
      lockMs: 5_000,
    });
    auth.authFailed('198.51.100.1');
    auth.authFailed('198.51.100.1');
    expect(auth.lockedFor('198.51.100.1')).toBeNull();
    auth.authFailed('198.51.100.1');
    expect(auth.lockedFor('198.51.100.1')).toBe(5);
    expect(auth.lockedFor('198.51.100.2')).toBeNull();
    now = 5_000;
    expect(auth.lockedFor('198.51.100.1')).toBeNull();
  });
});

describe('push-notification configs (P4)', () => {
  const path = '/a2a/v1/tasks/m-root/pushNotificationConfigs';
  const body = {
    url: 'https://hooks.example.com/a2a',
    token: 'SECRET-TOKEN',
    authentication: { scheme: 'Bearer', credentials: 'SECRET-CRED' },
  };

  it('creates, gets, lists and deletes, and deleting twice succeeds', async () => {
    port.enablePush();
    const created = (await (
      await call(path, { body: { ...body, id: 'cfg-1' } })
    ).json()) as { id: string; taskId: string; url: string };
    expect(created).toMatchObject({
      id: 'cfg-1',
      taskId: 'm-root',
      url: 'https://hooks.example.com/a2a',
    });
    expect(await (await call(`${path}/cfg-1`)).json()).toMatchObject({
      id: 'cfg-1',
      authentication: { scheme: 'Bearer' },
    });
    expect(await (await call(path)).json()).toEqual({
      configs: [expect.objectContaining({ id: 'cfg-1' })],
      nextPageToken: '',
    });
    for (const _ of [1, 2])
      expect((await call(`${path}/cfg-1`, { method: 'DELETE' })).status).toBe(
        200
      );
  });

  it('never echoes the token or credentials back', async () => {
    port.enablePush();
    const texts = [
      await (await call(path, { body: { ...body, id: 'cfg-1' } })).text(),
      await (await call(`${path}/cfg-1`)).text(),
      await (await call(path)).text(),
    ];
    for (const text of texts) {
      expect(text).not.toContain('SECRET');
      expect(text).toContain('cfg-1');
    }
  });

  it('answers an unknown config and a foreign task as TASK_NOT_FOUND', async () => {
    port.enablePush();
    const missing = await call(`${path}/nope`);
    expect(missing.status).toBe(404);
    expect(await reason(missing)).toBe('TASK_NOT_FOUND');
    const foreign = await call(path, {
      body,
      headers: { authorization: 'Bearer other' },
    });
    expect(await reason(foreign)).toBe('TASK_NOT_FOUND');
  });

  it('creates an inline config from a send, validating it before anything is sent', async () => {
    const configs = port.enablePush();
    await call('/a2a/v1/message:send', {
      body: {
        ...ask(),
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: body,
        },
      },
    });
    expect([...configs.configs.values()]).toEqual([
      expect.objectContaining({ taskId: 'm-root', url: body.url }),
    ]);
    const bad = await call('/a2a/v1/message:send', {
      body: {
        ...ask({ messageId: 'c-9' }),
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: { url: 'nope' },
        },
      },
    });
    expect(bad.status).toBe(400);
    expect(port.calls.filter((c) => c.method === 'open')).toHaveLength(1);
  });

  it('checks an inline config with the port before sending, and sends nothing when refused', async () => {
    const configs = port.enablePush();
    configs.refuse = 'private';
    const res = await call('/a2a/v1/message:send', {
      body: {
        ...ask(),
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: { url: 'https://private.example.com/a' },
        },
      },
    });
    expect(res.status).toBe(400);
    expect(port.calls.some((c) => c.method === 'open')).toBe(false);
  });

  it('refuses push routes and an inline config when the port has no push support', async () => {
    const res = await call('/a2a/v1/message:send', {
      body: {
        ...ask(),
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: body,
        },
      },
    });
    expect(await reason(res)).toBe('PUSH_NOTIFICATION_NOT_SUPPORTED');
    expect(port.calls.some((c) => c.method === 'open')).toBe(false);
    expect(await reason(await call(path))).toBe(
      'PUSH_NOTIFICATION_NOT_SUPPORTED'
    );
  });
});

describe('the JWKS and the card URL (P4)', () => {
  const bare = { authorization: '', 'A2A-Version': '' };

  it('serves the port’s JWKS unauthenticated, and 404s without one', async () => {
    expect(
      (await call('/.well-known/jwks.json', { headers: bare })).status
    ).toBe(404);
    port.cardInputs = {
      ...port.cardInputs,
      jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1' }] },
    };
    const res = await call('/.well-known/jwks.json', { headers: bare });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await res.json()).toEqual({
      keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1' }],
    });
  });

  it('answers HEAD on the JWKS with its headers and no body', async () => {
    port.cardInputs = {
      ...port.cardInputs,
      jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1' }] },
    };
    const res = await call('/.well-known/jwks.json', {
      method: 'HEAD',
      headers: bare,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('');
  });

  it('never builds the card URL from Host or X-Forwarded-* headers', async () => {
    const res = await call('/.well-known/agent-card.json', {
      headers: {
        ...bare,
        host: 'evil.example.net',
        'x-forwarded-host': 'evil.example.net',
        'x-forwarded-proto': 'http',
      },
    });
    const text = await res.text();
    expect(text).toContain(port.cardInputs.publicUrl);
    expect(text).not.toContain('evil.example.net');
    expect(port.calls.filter((c) => c.method === 'card')).toEqual([
      { method: 'card', args: [] },
    ]);
  });
});
