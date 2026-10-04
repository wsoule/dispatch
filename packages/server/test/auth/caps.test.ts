import { describe, expect, it } from 'bun:test';

import { call, invite, liveRun, useWorld } from './world.js';

// Rate caps a run or agent cannot multiply by fanning out (XH-R2, M4).

const world = useWorld();

describe('the urgent quota for runs', () => {
  it('is shared by every run acting for the same operator', async () => {
    const w = world();
    const ada = await invite(w, 'ada@x.io', 'request');
    const first = await liveRun(w, w.app, 'one');
    const sibling = await liveRun(w, w.app, 'two');
    const adas = await liveRun(w, ada.token, 'ada');
    const urgent = (token: string) =>
      call(w, token, 'POST', '/api/messages', {
        to: ['human:test'],
        kind: 'message',
        body: 'u',
        urgent: true,
      });
    for (let i = 0; i < 10; i++) {
      expect((await urgent(first.runToken)).json.message.urgent).toBe(true);
    }
    // A sibling for the same operator is over the quota already…
    const over = await urgent(sibling.runToken);
    expect(over.json.message.urgent).toBe(false);
    expect(over.json.downgraded).toBe(true);
    // …and a run for someone else keeps its own.
    expect((await urgent(adas.runToken)).json.message.urgent).toBe(true);
  });
});

async function approvedAgent(w: ReturnType<typeof world>, name: string) {
  const reg = await call(w, w.agent, 'POST', '/api/agents/register', {
    name,
    client: 'x',
  });
  await call(
    w,
    w.app,
    'POST',
    `/api/agents/${encodeURIComponent(reg.json.address)}/approve`
  );
  return { address: reg.json.address as string, token: reg.json.token };
}

describe('M4 caps', () => {
  it('bounds the registrations awaiting approval per namespace', async () => {
    const w = world();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const r = await call(w, w.agent, 'POST', '/api/agents/register', {
        name: `bot-${i}`,
        client: 'Approve me',
      });
      statuses.push(r.status);
    }
    expect(statuses.filter((s) => s === 201).length).toBe(10);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    const open = await call(w, w.app, 'GET', '/api/decisions/open');
    const gates = (open.json.items as { data?: { type?: string } }[]).filter(
      (m) => m.data?.type === 'agent-registration'
    );
    expect(gates.length).toBe(10);
    // Deciding one frees a slot.
    const first = w.handle.messaging.store
      .agents()
      .find((a) => a.status === 'pending');
    await call(
      w,
      w.app,
      'POST',
      `/api/agents/${encodeURIComponent(first!.address)}/revoke`
    );
    const again = await call(w, w.agent, 'POST', '/api/agents/register', {
      name: 'bot-late',
      client: 'x',
    });
    expect(again.status).toBe(201);
  });

  it('merges repeated wake asks for one task into one gate', async () => {
    const w = world();
    const a = await approvedAgent(w, 'waker');
    const t = await call(w, w.app, 'POST', '/api/tasks', { title: 'idle' });
    for (let i = 0; i < 5; i++) {
      const r = await call(w, a.token, 'POST', '/api/messages', {
        to: [`task:${t.json.meta.id}`],
        kind: 'message',
        body: `wake ${i}`,
        wake: 'request',
      });
      expect(r.status).toBe(201);
    }
    await new Promise((r) => setTimeout(r, 200));
    const open = await call(w, w.app, 'GET', '/api/decisions/open');
    const wakes = (open.json.items as { data?: { type?: string } }[]).filter(
      (m) => m.data?.type === 'wake'
    );
    expect(wakes.length).toBe(1);
  });

  it('counts new agent-to-agent threads against the breaker', async () => {
    const w = world();
    const a = await approvedAgent(w, 'a1');
    const b = await approvedAgent(w, 'b1');
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await call(w, a.token, 'POST', '/api/messages', {
        to: [b.address],
        kind: 'message',
        body: `fresh ${i}`,
      });
      statuses.push(r.status);
    }
    expect(statuses.filter((s) => s === 201).length).toBe(20);
    expect(statuses.at(-1)).toBe(429);
    // A message that includes a human still goes.
    const human = await call(w, a.token, 'POST', '/api/messages', {
      to: ['human:test', b.address],
      kind: 'message',
      body: 'stuck, please look',
    });
    expect(human.status).toBe(201);
  });
});
