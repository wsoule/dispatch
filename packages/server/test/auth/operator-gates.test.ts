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

describe("a teammate's run (XH-R9)", () => {
  for (const [type, propose] of [
    ['memory', proposeMemory],
    ['doc', proposeDocEdit],
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

  it("keeps the owner's own run's gates with the owner, telling no one", async () => {
    const w = world();
    const run = await liveRun(w, w.app);
    await proposeMemory(w, run.runToken);
    const gate = await openGate(w, 'memory');
    expect(gate.to).toEqual([OWNER]);
    expect(noticesTo(w, OWNER)).toEqual([]);
  });
});
