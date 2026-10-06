import { describe, expect, it } from 'bun:test';

import type { World } from '../auth/world.js';
import { call, invite, liveRun, useWorld } from '../auth/world.js';

// GET /api/conversations?with=|about= (Two views' homes), GET /api/channels
// ?member=me, GET /api/docs?unlinked=1, and sends that continue a root.

const world = useWorld();
const OWNER = 'human:test';

interface Row {
  id: string;
  from: string;
  to: string[];
  body: string;
  thread: string;
  replyTo: string | null;
  data?: unknown;
}

async function send(
  w: World,
  token: string,
  body: Record<string, unknown>
): Promise<Row> {
  const r = await call(w, token, 'POST', '/api/messages', {
    kind: 'message',
    ...body,
  });
  if (r.status !== 201) throw new Error(`send: ${r.status} ${r.text}`);
  return r.json.message as Row;
}

async function conversationOf(
  w: World,
  token: string,
  query: string
): Promise<{ status: number; messages: Row[]; next: string | null }> {
  const r = await call(w, token, 'GET', `/api/conversations?${query}`);
  return {
    status: r.status,
    messages: (r.json?.messages ?? []) as Row[],
    next: (r.json?.next ?? null) as string | null,
  };
}

const bodies = (rows: Row[]) => rows.map((m) => m.body);

describe('GET /api/conversations', () => {
  it("gives a request-tier teammate only the pair's own mail, never a 403", async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    const carl = await invite(w, 'carl@example.com', 'request');
    await send(w, w.app, { to: [`human:${sam.handle}`], body: 'to sam' });
    await send(w, w.app, { to: [`human:${carl.handle}`], body: 'to carl' });
    await send(w, sam.token, { to: [OWNER], body: 'sam back' });

    const mine = await conversationOf(w, sam.token, `with=${OWNER}`);
    expect(mine.status).toBe(200);
    expect(bodies(mine.messages)).toEqual(['to sam', 'sam back']);

    // Sam asking about the owner and Carl gets nothing, not an error.
    const other = await conversationOf(
      w,
      sam.token,
      `with=human:${carl.handle}`
    );
    expect(other).toMatchObject({ status: 200, messages: [] });
  });

  it("scopes a task's talk to its participants; a decider sees all of it", async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    const { taskId, runId, runToken } = await liveRun(w, w.app, 'Task');
    const asked = await send(w, runToken, {
      to: [OWNER],
      body: 'run asks the owner',
    });
    await send(w, w.app, {
      to: [`run:${runId}`],
      body: 'owner answers',
      replyTo: asked.id,
    });
    await send(w, w.app, { to: [`task:${taskId}`], body: 'owner to task' });
    await send(w, w.app, { to: [`human:${sam.handle}`], body: 'unrelated' });

    const decider = await conversationOf(w, w.app, `about=task:${taskId}`);
    expect(decider.status).toBe(200);
    expect(bodies(decider.messages)).toEqual([
      'run asks the owner',
      'owner answers',
      'owner to task',
    ]);
    const outsider = await conversationOf(w, sam.token, `about=task:${taskId}`);
    expect(outsider).toEqual({ status: 200, messages: [], next: null });
    // The run reads its own task's talk.
    const own = await conversationOf(w, runToken, `about=task:${taskId}`);
    expect(bodies(own.messages)).toEqual(bodies(decider.messages));
  });

  it('pages newest first with before, oldest-to-newest inside a page', async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    for (const n of [1, 2, 3, 4, 5])
      await send(w, w.app, { to: [`human:${sam.handle}`], body: `m${n}` });
    const first = await conversationOf(w, sam.token, `with=${OWNER}&limit=2`);
    expect(bodies(first.messages)).toEqual(['m4', 'm5']);
    expect(first.next).toBe(first.messages[0].id);
    const second = await conversationOf(
      w,
      sam.token,
      `with=${OWNER}&limit=2&before=${first.next}`
    );
    expect(bodies(second.messages)).toEqual(['m2', 'm3']);
    const last = await conversationOf(
      w,
      sam.token,
      `with=${OWNER}&limit=2&before=${second.next}`
    );
    expect(last).toMatchObject({ next: null });
    expect(bodies(last.messages)).toEqual(['m1']);
    // A limit above the cap is clamped, not refused.
    expect(
      (await conversationOf(w, sam.token, `with=${OWNER}&limit=999`)).status
    ).toBe(200);
  });

  it('serves a channel to whoever its read rule lets read it', async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    const carl = await invite(w, 'carl@example.com', 'request');
    expect(
      (await call(w, sam.token, 'POST', '/api/channels/release/members')).status
    ).toBe(204);
    await send(w, w.app, { to: ['channel:release'], body: 'shipping' });
    const member = await conversationOf(w, sam.token, 'about=channel:release');
    expect(bodies(member.messages)).toEqual(['shipping']);
    const outsider = await conversationOf(
      w,
      carl.token,
      'about=channel:release'
    );
    expect(outsider).toMatchObject({ status: 200, messages: [] });
  });

  it('finds the threads that reference a doc', async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    const root = await send(w, w.app, {
      to: [`human:${sam.handle}`],
      body: 'see the spec',
      refs: [{ type: 'doc', id: 'doc-1' }],
    });
    await send(w, sam.token, {
      to: [OWNER],
      body: 'read it',
      replyTo: root.id,
    });
    await send(w, w.app, { to: [`human:${sam.handle}`], body: 'other' });
    const doc = await conversationOf(w, sam.token, 'about=doc:doc-1');
    expect(bodies(doc.messages)).toEqual(['see the spec', 'read it']);
  });

  it('refuses a malformed query with 400', async () => {
    const w = world();
    for (const q of [
      `with=${OWNER}&about=task:t-1`,
      'about=human:sam',
      'about=nope',
      'with=nope',
      'limit=-1&with=human:sam',
    ])
      expect({ q, status: (await conversationOf(w, w.app, q)).status }).toEqual(
        {
          q,
          status: 400,
        }
      );
  });

  it("keeps the review chat's subject listing", async () => {
    const w = world();
    const r = await call(w, w.app, 'GET', '/api/conversations?subject=run:r-1');
    expect(r.status).toBe(200);
  });
});

describe('draftedBy', () => {
  it('is stripped from a plain send and a reply; other data stays', async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    const spoof = await send(w, sam.token, {
      to: [OWNER],
      body: 'spoofed',
      data: { draftedBy: 'agent:test/overseer', note: 1 },
    });
    expect(spoof.data).toEqual({ note: 1 });
    const bare = await send(w, sam.token, {
      to: [OWNER],
      body: 'bare',
      data: { draftedBy: 'agent:test/overseer' },
    });
    expect(bare.data).toBeUndefined();
    const reply = await call(
      w,
      w.app,
      'POST',
      `/api/messages/${bare.id}/reply`,
      {
        body: 'back',
        data: { draftedBy: 'agent:x/y' },
      }
    );
    expect(reply.status).toBe(201);
    expect(reply.json.message.data).toBeUndefined();
  });
});

describe('GET /api/channels?member=me', () => {
  it("lists only the caller's channels", async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    await call(w, sam.token, 'POST', '/api/channels/release/members');
    await call(w, w.app, 'POST', '/api/channels/ops/members');
    const r = await call(w, sam.token, 'GET', '/api/channels?member=me');
    expect(r.status).toBe(200);
    expect(r.json.channels.map((c: { name: string }) => c.name)).toEqual([
      'release',
    ]);
    const all = await call(w, sam.token, 'GET', '/api/channels');
    expect(all.json.channels.length).toBeGreaterThan(1);
    expect(
      (await call(w, sam.token, 'GET', '/api/channels?member=human:x')).status
    ).toBe(400);
  });
});

describe('GET /api/docs?unlinked=1', () => {
  it('lists team docs linked to no task or milestone', async () => {
    const w = world();
    const t = await call(w, w.app, 'POST', '/api/tasks', { title: 'T' });
    const taskId = t.json.meta.id as string;
    const linked = await call(w, w.app, 'POST', '/api/docs', {
      title: 'Linked',
      body: 'x\n',
      links: [{ target: `task:${taskId}`, rel: 'context' }],
    });
    expect(linked.status).toBe(201);
    const free = await call(w, w.app, 'POST', '/api/docs', {
      title: 'Free',
      body: 'y\n',
    });
    expect(free.status).toBe(201);
    await call(w, w.app, 'POST', '/api/docs', {
      title: 'Mine',
      body: 'z\n',
      scope: 'personal',
    });
    const r = await call(w, w.app, 'GET', '/api/docs?unlinked=1');
    expect(r.status).toBe(200);
    expect(r.json.docs.map((d: { title: string }) => d.title)).toEqual([
      'Free',
    ]);
  });
});

describe('continuing a root', () => {
  it("replies into the newest open root about the run's task", async () => {
    const w = world();
    const { runId } = await liveRun(w, w.app, 'Task');
    const first = await send(w, w.app, {
      to: [`run:${runId}`],
      body: 'one',
      continueThread: true,
    });
    expect(first.replyTo).toBeNull();
    const second = await send(w, w.app, {
      to: [`run:${runId}`],
      body: 'two',
      continueThread: true,
    });
    expect(second.thread).toBe(first.thread);
    expect(second.replyTo).toBe(first.id);
    // Without the flag a send still starts its own root.
    const third = await send(w, w.app, { to: [`run:${runId}`], body: '3' });
    expect(third.thread).toBe(third.id);
  });

  it('never continues a question or handoff root, open or answered', async () => {
    const w = world();
    const { runId, runToken } = await liveRun(w, w.app, 'Task');
    const ask = async (body: string, kind = 'question') =>
      (
        await call(w, runToken, 'POST', '/api/messages', {
          to: [OWNER],
          kind,
          body,
        })
      ).json.message as Row;
    const answered = await ask('which?');
    await call(w, w.app, 'POST', `/api/messages/${answered.id}/reply`, {
      body: 'that one',
    });
    const steer = await send(w, w.app, {
      to: [`run:${runId}`],
      body: 'and also',
      continueThread: true,
    });
    expect(steer.thread).toBe(steer.id);
    // Open asks are newer, yet the steer's plain root is what continues.
    const open = await ask('and now?');
    const handoff = await ask('take this', 'handoff');
    const next = await send(w, w.app, {
      to: [`run:${runId}`],
      body: 'go on',
      continueThread: true,
    });
    expect(next.thread).toBe(steer.id);
    expect([open.thread, handoff.thread]).not.toContain(next.thread);
    expect(next.replyTo).toBe(steer.id);
  });

  it('starts a root when only asks exist', async () => {
    const w = world();
    const { runId, runToken } = await liveRun(w, w.app, 'Task');
    await call(w, runToken, 'POST', '/api/messages', {
      to: [OWNER],
      kind: 'question',
      body: 'open ask',
    });
    const steer = await send(w, w.app, {
      to: [`run:${runId}`],
      body: 'unrelated',
      continueThread: true,
    });
    expect(steer.thread).toBe(steer.id);
    expect(steer.replyTo).toBeNull();
  });

  it("keeps a DM in the pair's newest root, never a third party's", async () => {
    const w = world();
    const sam = await invite(w, 'sam@example.com', 'request');
    const carl = await invite(w, 'carl@example.com', 'request');
    const root = await send(w, w.app, {
      to: [`human:${sam.handle}`],
      body: 'hi sam',
    });
    await send(w, w.app, {
      to: [`human:${sam.handle}`, `human:${carl.handle}`],
      body: 'group',
    });
    const reply = await send(w, sam.token, {
      to: [OWNER],
      body: 'hi back',
      continueThread: true,
    });
    expect(reply.thread).toBe(root.id);
    const toCarl = await send(w, w.app, {
      to: [`human:${carl.handle}`],
      body: 'hi carl',
      continueThread: true,
    });
    expect(toCarl.thread).toBe(toCarl.id);
  });
});
