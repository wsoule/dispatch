import type { Message } from '@dispatch/protocol';
import { gateOf } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';

import type { World } from './world.js';
import { call, invite, liveRun, useWorld, waitFor } from './world.js';

// XH-R9: a teammate's run asks, tells and gates the teammate, not the daemon
// owner (`human:test` here), unless the teammate cannot decide that gate.

const world = useWorld();
const OWNER = 'human:test';

// The open gate of `type`, once there is one.
async function openGate(w: World, type: string): Promise<Message> {
  let found: Message | undefined;
  await waitFor(() => {
    found = w.handle.messaging.engine
      .openBlocking()
      .find((m) => gateOf(m)?.type === type);
    return found !== undefined;
  });
  return found!;
}

// The notices `ref` received, oldest first.
function noticesTo(w: World, ref: string): Message[] {
  const { store } = w.handle.messaging;
  return store
    .deliveries({ recipient: ref })
    .map((d) => store.getMessage(d.messageId))
    .filter((m): m is Message => m?.kind === 'notice');
}

async function proposeMemory(w: World, runToken: string): Promise<void> {
  const r = await call(w, runToken, 'POST', '/api/memory', {
    scope: 'project',
    kind: 'hazard',
    title: 'flaky port',
    body: 'b',
  });
  expect(r.status).toBeLessThan(300);
}

async function proposeDocEdit(w: World, runToken: string): Promise<void> {
  expect(
    (await call(w, w.app, 'POST', '/api/docs', { title: 'Spec', body: 'v1\n' }))
      .status
  ).toBe(201);
  expect(
    (
      await call(w, w.app, 'POST', '/api/docs/spec/status', {
        status: 'accepted',
      })
    ).status
  ).toBe(200);
  const r = await call(w, runToken, 'POST', '/api/docs/spec/edit', {
    ops: [{ op: 'append', text: 'more' }],
  });
  expect(r.status).toBeLessThan(300);
}

// Asks, as the run, to wake a fresh task of the owner's.
async function askToWake(w: World, runToken: string): Promise<void> {
  const t = await call(w, w.app, 'POST', '/api/tasks', { title: 'asleep' });
  const r = await call(w, runToken, 'POST', '/api/messages', {
    to: [`task:${t.json.meta.id}`],
    kind: 'message',
    body: 'please pick this up',
    wake: 'request',
  });
  expect(r.status).toBeLessThan(300);
}

describe("a teammate's run (XH-R9)", () => {
  for (const [type, propose] of [
    ['memory', proposeMemory],
    ['doc', proposeDocEdit],
    ['wake', askToWake],
  ] as const) {
    it(`sends its ${type} gate to a teammate who can decide`, async () => {
      const w = world();
      const ana = await invite(w, 'ana@example.com', 'decide');
      const run = await liveRun(w, ana.token);
      await propose(w, run.runToken);
      const gate = await openGate(w, type);
      expect(gate.to).toEqual([`human:${ana.handle}`]);
    });

    it(`sends its ${type} gate to the owner and tells a request-tier teammate`, async () => {
      const w = world();
      const bo = await invite(w, 'bo@example.com', 'request');
      const run = await liveRun(w, bo.token);
      await propose(w, run.runToken);
      const gate = await openGate(w, type);
      expect(gate.to).toEqual([OWNER]);
      await waitFor(() => noticesTo(w, `human:${bo.handle}`).length > 0);
      expect(noticesTo(w, `human:${bo.handle}`)[0]?.body).toContain(
        `Your run ${run.runId} is waiting on ${OWNER} to decide`
      );
    });
  }

  it('names the teammate as its human in the prompt', async () => {
    const w = world();
    const ana = await invite(w, 'ana@example.com', 'decide');
    await liveRun(w, ana.token);
    const prompt = w.executor.started.at(-1)?.prompt ?? '';
    expect(prompt).toContain(`(to: ["human:${ana.handle}"], kind: "question"`);
    expect(prompt).not.toContain(OWNER);
  });

  it('names a request-tier teammate as its human, and the owner for scope', async () => {
    const w = world();
    const bo = await invite(w, 'bo@example.com', 'request');
    await liveRun(w, bo.token);
    const prompt = w.executor.started.at(-1)?.prompt ?? '';
    expect(prompt).toContain(`(to: ["human:${bo.handle}"], kind: "question"`);
    expect(prompt).toContain(`msg_send(to: ["${OWNER}"], kind: "question"`);
  });

  it("names the owner in the prompt of the owner's run and of a run for no one", async () => {
    const w = world();
    await liveRun(w, w.app);
    expect(w.executor.started.at(-1)?.prompt).toContain(
      `(to: ["${OWNER}"], kind: "question"`
    );
    await liveRun(w, w.agent);
    expect(w.executor.started.at(-1)?.prompt).toContain(
      `(to: ["${OWNER}"], kind: "question"`
    );
  });

  it("keeps the owner's own run's gates with the owner, telling no one", async () => {
    const w = world();
    const run = await liveRun(w, w.app);
    await proposeMemory(w, run.runToken);
    const gate = await openGate(w, 'memory');
    expect(gate.to).toEqual([OWNER]);
    expect(noticesTo(w, OWNER)).toEqual([]);
  });
});

describe("the decision feed for a teammate's run (XH-R4, XH-R9)", () => {
  it("shows a request-tier teammate their run's gate that went to the owner", async () => {
    const w = world();
    const bo = await invite(w, 'bo@example.com', 'request');
    const other = await invite(w, 'cy@example.com', 'request');
    const run = await liveRun(w, bo.token);
    const sent = await call(w, run.runToken, 'POST', '/api/messages', {
      to: [OWNER],
      kind: 'question',
      blocking: true,
      choices: ['grant', 'deny'],
      body: 'PRIVATE-SCOPE: need routes.ts',
      data: { type: 'scope', paths: ['src/routes.ts'], reason: 'handler' },
    });
    expect(sent.status).toBe(201);
    const gateId = sent.json.message.id as string;
    const mine = await call(w, bo.token, 'GET', '/api/decisions');
    expect(mine.text).toContain(gateId);
    const theirs = await call(w, other.token, 'GET', '/api/decisions');
    expect(theirs.text).not.toContain(gateId);
  });
});

// Sends a scope gate as the run to `to`, returning the stored gate.
async function askScopeOf(
  w: World,
  runToken: string,
  to: string[]
): Promise<Message> {
  const sent = await call(w, runToken, 'POST', '/api/messages', {
    to,
    kind: 'question',
    blocking: true,
    choices: ['grant', 'deny'],
    body: 'need routes.ts',
    data: { type: 'scope', paths: ['src/routes.ts'], reason: 'handler' },
  });
  expect(sent.status).toBe(201);
  return sent.json.message as Message;
}

describe('a scope gate addressed to someone who cannot decide (XH-R9)', () => {
  it('goes to the owner instead, and the request-tier operator is told', async () => {
    const w = world();
    const bo = await invite(w, 'bo@example.com', 'request');
    const run = await liveRun(w, bo.token);
    const gate = await askScopeOf(w, run.runToken, [`human:${bo.handle}`]);
    expect(gate.to).toEqual([OWNER]);
    await waitFor(() => noticesTo(w, `human:${bo.handle}`).length > 0);
  });

  it('goes only to a deciding operator, whichever decider the run named, and tells the others', async () => {
    const w = world();
    const ana = await invite(w, 'ana@example.com', 'decide');
    const dee = await invite(w, 'dee@example.com', 'decide');
    const run = await liveRun(w, ana.token);
    const gate = await askScopeOf(w, run.runToken, [
      `human:${dee.handle}`,
      OWNER,
    ]);
    expect(gate.to).toEqual([`human:${ana.handle}`]);
    await waitFor(
      () =>
        noticesTo(w, `human:${dee.handle}`).length > 0 &&
        noticesTo(w, OWNER).length > 0
    );
    expect(noticesTo(w, `human:${dee.handle}`)[0]?.body).toContain(
      `human:${ana.handle}`
    );
  });

  it('goes to an operator who can decide when the run asked a request-tier teammate', async () => {
    const w = world();
    const ana = await invite(w, 'ana@example.com', 'decide');
    const bo = await invite(w, 'bo@example.com', 'request');
    const run = await liveRun(w, ana.token);
    const gate = await askScopeOf(w, run.runToken, [`human:${bo.handle}`]);
    expect(gate.to).toEqual([`human:${ana.handle}`]);
  });

  it("goes to the owner for the owner's run, whoever the run named", async () => {
    const w = world();
    const ana = await invite(w, 'ana@example.com', 'decide');
    const run = await liveRun(w, w.app);
    const gate = await askScopeOf(w, run.runToken, [`human:${ana.handle}`]);
    expect(gate.to).toEqual([OWNER]);
  });
});
