import type { StreamResponseJson } from '@dispatch/a2a';
import { PUSH_LIMITS } from '@dispatch/a2a';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { HUMAN, useTempProject, waitFor } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
let posts: { url: string; headers: Headers; body: StreamResponseJson }[];
let hang = false;
let failWith: number | null = null;
let addresses: () => Promise<string[]>;

beforeEach(async () => {
  posts = [];
  hang = false;
  failWith = null;
  addresses = () => Promise.resolve(['93.184.216.34']);
  // Cast, not annotated: bun-types' `typeof fetch` also carries `preconnect`.
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    if (hang) return new Promise<Response>(() => undefined);
    posts.push({
      url: input instanceof URL ? input.href : input,
      headers: new Headers(init?.headers),
      body: JSON.parse(
        typeof init?.body === 'string' ? init.body : 'null'
      ) as StreamResponseJson,
    });
    return Promise.resolve(new Response(null, { status: failWith ?? 204 }));
  }) as typeof fetch;
  f = await bridgeFixture(
    project.root(),
    {},
    {
      pushFetch: fetchImpl,
      lookup: (host) => addresses().then((a) => (host === '' ? [] : a)),
    }
  );
});
afterEach(() => f.close());

async function ask(clientMessageId = 'c-1'): Promise<string> {
  const opened = await f.port.open(f.caller, {
    clientMessageId,
    contextId: null,
    kind: 'ask',
    to: null,
    replyTo: null,
    body: 'Is /sessions final?',
    refs: [],
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  return opened.taskId;
}
const configs = () => f.port.pushConfigs;
const HOOK = 'https://hooks.example.com/a2a';

describe('push configs', () => {
  it('declares push on the card', async () => {
    expect((await f.port.card()).pushNotifications).toBe(true);
  });

  it('refuses a private webhook URL, a fourth config on one task and a foreign task', async () => {
    const id = await ask();
    addresses = () => Promise.resolve(['10.0.0.5']);
    await expect(
      configs().create(f.caller, id, { id: null, url: HOOK })
    ).rejects.toMatchObject({ field: 'url' });
    addresses = () => Promise.resolve(['93.184.216.34']);
    for (const n of [1, 2, 3])
      await configs().create(f.caller, id, { id: `c${n}`, url: HOOK });
    await expect(
      configs().create(f.caller, id, { id: 'c4', url: HOOK })
    ).rejects.toMatchObject({ code: 'limited' });
    const other = f.addClient('other');
    await expect(configs().get(other, id, 'c1')).rejects.toMatchObject({
      reason: 'TASK_NOT_FOUND',
    });
  });

  it('caps a client at fifty configs across its tasks', async () => {
    const id = await ask();
    for (let i = 0; i < PUSH_LIMITS.perClient; i++)
      f.store.putPushConfig({
        id: `old-${i}`,
        taskId: `m-elsewhere-${i}`,
        client: f.caller.address,
        url: HOOK,
        token: null,
        authScheme: null,
        authCredentials: null,
        failures: 0,
        disabledAt: null,
        createdAt: new Date().toISOString(),
      });
    await expect(
      configs().create(f.caller, id, { id: 'one-more', url: HOOK })
    ).rejects.toMatchObject({ code: 'limited' });
  });

  it('delivers the change as a StreamResponse with the client’s credentials, pinned to the checked address', async () => {
    const id = await ask();
    await configs().create(f.caller, id, {
      id: 'hook',
      url: HOOK,
      token: 'tok',
      authentication: { scheme: 'Bearer', credentials: 'cred' },
    });
    await f.messaging.engine.reply(id, { body: 'Yes, final.' }, HUMAN);
    await waitFor(() => posts.length > 0);
    expect(posts[0].url).toBe('https://93.184.216.34/a2a');
    expect(posts[0].headers.get('host')).toBe('hooks.example.com');
    expect(posts[0].headers.get('authorization')).toBe('Bearer cred');
    expect(posts[0].headers.get('x-a2a-notification-token')).toBe('tok');
    expect(JSON.stringify(posts[0].body)).toContain('TASK_STATE_COMPLETED');
  });

  it('retries three times, and disables a config after ten consecutive failures', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    failWith = 500;
    await f.messaging.engine.reply(id, { body: 'done' }, HUMAN);
    await waitFor(() => posts.length === 4);
    await f.push.idle();
    expect(f.store.getPushConfig(id, 'hook')?.failures).toBe(4);
    for (let i = 0; i < 6; i++)
      f.push.onChanged(
        f.store.getTask(id)!,
        (await f.port.facts(f.caller, id))!,
        { force: true }
      );
    await f.push.idle();
    expect(f.store.getPushConfig(id, 'hook')?.disabledAt).not.toBeNull();
  });

  it('disables a config at once when its name now resolves privately, posting nothing', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    addresses = () => Promise.resolve(['169.254.169.254']);
    await f.messaging.engine.reply(id, { body: 'done' }, HUMAN);
    await waitFor(() => f.store.getPushConfig(id, 'hook')?.disabledAt !== null);
    await f.push.idle();
    expect(posts).toEqual([]);
    expect(f.store.getPushConfig(id, 'hook')?.failures).toBe(0);
  });

  it('retries while the webhook name does not resolve, then delivers', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    let lookups = 0;
    addresses = () =>
      lookups++ < 2
        ? Promise.reject(new Error('EAI_AGAIN'))
        : Promise.resolve(['93.184.216.34']);
    await f.messaging.engine.reply(id, { body: 'done' }, HUMAN);
    await waitFor(() => posts.length === 1);
    await f.push.idle();
    expect(f.store.getPushConfig(id, 'hook')).toMatchObject({
      disabledAt: null,
      failures: 0,
    });
  });

  it('never logs a token or credentials', async () => {
    const logged: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }
    );
    try {
      const id = await ask();
      await configs().create(f.caller, id, {
        id: 'hook',
        url: HOOK,
        token: 'SECRET-TOKEN',
        authentication: { scheme: 'Bearer', credentials: 'SECRET-CRED' },
      });
      addresses = () => Promise.resolve(['10.0.0.5']);
      await f.messaging.engine.reply(id, { body: 'done' }, HUMAN);
      await waitFor(
        () => f.store.getPushConfig(id, 'hook')?.disabledAt !== null
      );
      await f.push.idle();
    } finally {
      spy.mockRestore();
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain('SECRET');
  });

  // Review Focus 5.
  it('a hanging webhook never delays a stream event', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    hang = true;
    let fired = 0;
    const stop = f.port.watch(f.caller, id, () => {
      fired += 1;
    });
    const started = performance.now();
    await f.messaging.engine.reply(id, { body: 'Yes.' }, HUMAN);
    await waitFor(() => fired > 0, 1000);
    expect(performance.now() - started).toBeLessThan(1000);
    stop();
  });
});
