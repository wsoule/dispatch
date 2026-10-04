import type { StreamResponseJson } from '@dispatch/a2a';
import { handleA2A, IpLimiter, PUSH_LIMITS } from '@dispatch/a2a';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { gatherFacts } from '../../src/a2a/facts.js';
import { PushWorker } from '../../src/a2a/push.js';
import { HUMAN, useTempProject, waitFor } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
let posts: { url: string; headers: Headers; body: StreamResponseJson }[];
let hang = false;
let failWith: number | null = null;
// Runs after each recorded post, before its answer.
let onPost: (() => void) | null = null;
let addresses: () => Promise<string[]>;
let pushFetch: typeof fetch;

beforeEach(async () => {
  posts = [];
  hang = false;
  failWith = null;
  onPost = null;
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
    onPost?.();
    return Promise.resolve(new Response(null, { status: failWith ?? 204 }));
  }) as typeof fetch;
  pushFetch = fetchImpl;
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
// Re-sends a still-open task's current state, as any non-final change would.
async function nudge(id: string): Promise<void> {
  f.push.onChanged(f.store.getTask(id)!, (await f.port.facts(f.caller, id))!, {
    force: true,
  });
}
// An A2A task row the client owns, in `state`, for seeding configs.
function seedTask(id: string, state: 'WORKING' | 'COMPLETED'): void {
  const at = new Date().toISOString();
  f.store.insertTask({
    id,
    client: f.caller.address,
    contextId: id,
    skill: 'ask',
    dispatchTask: null,
    gate: null,
    state,
    statusAt: at,
    canceledAt: null,
    declinedAt: null,
    createdAt: at,
  });
}
function seedConfig(taskId: string, id: string): void {
  f.store.putPushConfig({
    id,
    taskId,
    client: f.caller.address,
    url: HOOK,
    token: null,
    authScheme: null,
    authCredentials: null,
    failures: 0,
    disabledAt: null,
    createdAt: new Date().toISOString(),
  });
}
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

  it('caps a client at fifty configs across its live tasks', async () => {
    const id = await ask();
    for (let i = 0; i < PUSH_LIMITS.perClient; i++) {
      seedTask(`m-live-${i}`, 'WORKING');
      seedConfig(`m-live-${i}`, 'hook');
    }
    await expect(
      configs().create(f.caller, id, { id: 'one-more', url: HOOK })
    ).rejects.toMatchObject({ code: 'limited' });
  });

  it('never counts configs on finished or missing tasks toward the cap', async () => {
    const id = await ask();
    for (let i = 0; i < 17; i++) {
      seedTask(`m-done-${i}`, 'COMPLETED');
      for (const n of [1, 2, 3]) seedConfig(`m-done-${i}`, `hook-${n}`);
    }
    for (let i = 0; i < 10; i++) seedConfig(`m-gone-${i}`, 'hook');
    await configs().create(f.caller, id, { id: 'next', url: HOOK });
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
    // Delivered the final event: the config and its secrets are gone.
    await f.push.idle();
    expect(f.store.getPushConfig(id, 'hook')).toBeNull();
  });

  it('deletes a finished task’s configs even when its final event fails', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    failWith = 500;
    await f.messaging.engine.reply(id, { body: 'done' }, HUMAN);
    await waitFor(() => posts.length === 4);
    await f.push.idle();
    expect(f.store.getPushConfig(id, 'hook')).toBeNull();
  });

  it('retries three times, and disables a config after ten consecutive failures', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    failWith = 500;
    await nudge(id);
    await waitFor(() => posts.length === 4);
    await f.push.idle();
    expect(f.store.getPushConfig(id, 'hook')?.failures).toBe(4);
    for (let i = 0; i < 2; i++) await nudge(id);
    await f.push.idle();
    expect(f.store.getPushConfig(id, 'hook')?.disabledAt).not.toBeNull();
  });

  it('disables a config at once when its name now resolves privately, posting nothing', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    addresses = () => Promise.resolve(['169.254.169.254']);
    await nudge(id);
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
    await nudge(id);
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
      await nudge(id);
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

  it('refuses an inline config before the message is sent', async () => {
    addresses = () => Promise.resolve(['10.0.0.5']);
    const res = await handleA2A(
      new Request('http://agent.test/a2a/v1/message:send', {
        method: 'POST',
        headers: {
          'A2A-Version': '1.0',
          authorization: 'Bearer tok-acme',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            messageId: 'c-inline',
            role: 'ROLE_USER',
            parts: [{ text: 'Is /sessions final?' }],
          },
          configuration: {
            returnImmediately: true,
            taskPushNotificationConfig: { url: HOOK },
          },
        }),
      }),
      f.port,
      {
        basePath: '/a2a/v1',
        policy: f.deps.policy(),
        clientIp: '127.0.0.1',
        limiter: new IpLimiter(),
      }
    );
    expect(res.status).toBe(400);
    expect(f.store.tasksOf(f.caller.address)).toEqual([]);
  });

  it('forgets a task’s last snapshot once it has no configs', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    await nudge(id);
    await f.push.idle();
    expect(f.push.snapshotCount()).toBe(1);
    await configs().delete(f.caller, id, 'hook');
    await nudge(id);
    expect(f.push.snapshotCount()).toBe(0);
  });

  it('never pushes to a revoked client', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    const agent = f.messaging.store.getAgent(f.caller.address)!;
    f.messaging.store.putAgent({ ...agent, status: 'revoked' });
    await f.messaging.engine.reply(id, { body: 'Yes, final.' }, HUMAN);
    await Bun.sleep(100);
    await f.push.idle();
    expect(posts).toEqual([]);
  });

  it('checks the client again at each retry, so one revoked during backoff gets nothing more', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    failWith = 500;
    // Revoked as the first attempt fails, so during its retry's delay.
    onPost = () => {
      const agent = f.messaging.store.getAgent(f.caller.address)!;
      f.messaging.store.putAgent({ ...agent, status: 'revoked' });
    };
    await nudge(id);
    await waitFor(() => posts.length === 1);
    await f.push.idle();
    expect(posts).toHaveLength(1);
    expect(f.store.getPushConfig(id, 'hook')?.failures).toBe(1);
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

// A daemon that stopped mid-delivery: a fresh worker over the same a2a.db.
describe('after a restart', () => {
  const restarted = (delaysMs: number[] = [5, 5, 5]) =>
    new PushWorker({
      store: f.store,
      clientActive: () => true,
      lookup: () => addresses(),
      delaysMs,
      fetchImpl: pushFetch,
    });

  it('sends a finished task’s final event once, then deletes its config', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    hang = true;
    await f.messaging.engine.reply(id, { body: 'Yes, final.' }, HUMAN);
    await waitFor(() => f.store.getTask(id)?.state === 'COMPLETED');
    hang = false;
    const worker = restarted();
    worker.resume((row) => gatherFacts(f.deps, row));
    await worker.idle();
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0].body)).toContain('TASK_STATE_COMPLETED');
    expect(f.store.getPushConfig(id, 'hook')).toBeNull();
    worker.resume((row) => gatherFacts(f.deps, row));
    await worker.idle();
    expect(posts).toHaveLength(1);
  });

  it('keeps a failing delivery’s retry count, and resumes from it', async () => {
    const id = await ask();
    await configs().create(f.caller, id, { id: 'hook', url: HOOK });
    failWith = 500;
    // What a2a.db holds as each retry goes out.
    const kept: (number | undefined)[] = [];
    onPost = () => kept.push(f.store.getPushPending(id, 'hook')?.tries);
    await nudge(id);
    await waitFor(() => posts.length === 4);
    await f.push.idle();
    expect(kept).toEqual([undefined, 1, 2, 3]);
    expect(f.store.getPushPending(id, 'hook')).toBeNull();
    onPost = null;
    // Every retry was spent: a restarted worker tries once more, no more.
    f.store.setPushPending(id, 'hook', 3, new Date(0).toISOString());
    posts = [];
    const worker = restarted();
    worker.onChanged(
      f.store.getTask(id)!,
      gatherFacts(f.deps, f.store.getTask(id)!)
    );
    await worker.idle();
    expect(posts).toHaveLength(1);
    failWith = null;
    worker.onChanged(
      f.store.getTask(id)!,
      gatherFacts(f.deps, f.store.getTask(id)!),
      {
        force: true,
      }
    );
    await worker.idle();
    expect(f.store.getPushPending(id, 'hook')).toBeNull();
  });
});
