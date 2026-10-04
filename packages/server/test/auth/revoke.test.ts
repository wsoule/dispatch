import { describe, expect, it } from 'bun:test';

import { call, invite, liveRun, useWorld, waitFor } from './world.js';

// XH-R3: revoking a teammate takes everything that acted for them with it:
// their agents and A2A clients, their open asks and proposals, their live
// runs and their event sockets.

const world = useWorld();

describe('revoking a teammate', () => {
  it('cascades to their agents, clients, asks, proposals, runs and sockets', async () => {
    const w = world();
    const ada = await invite(w, 'ada@x.io', 'decide');

    const reg = await call(w, ada.token, 'POST', '/api/agents/register', {
      name: 'laptop',
      client: 'claude-code',
    });
    expect(reg.status).toBe(201);
    const agent = {
      address: reg.json.address as string,
      token: reg.json.token,
    };
    expect(
      (
        await call(
          w,
          w.app,
          'POST',
          `/api/agents/${encodeURIComponent(agent.address)}/approve`
        )
      ).status
    ).toBe(200);
    const client = await call(w, ada.token, 'POST', '/api/a2a/clients', {
      name: 'adas-bot',
      approve: true,
    });
    expect(client.status).toBe(201);

    // An ask of hers, and a memory proposal from her agent, both still open.
    const ask = await call(w, ada.token, 'POST', '/api/messages', {
      to: ['human:test'],
      kind: 'question',
      blocking: true,
      body: 'ship it?',
    });
    expect(ask.status).toBe(201);
    const proposal = await call(w, agent.token, 'POST', '/api/memory', {
      scope: 'project',
      kind: 'hazard',
      title: 'from adas agent',
      body: 'b',
    });
    expect(proposal.status).toBeLessThan(300);
    const memoryGate = () =>
      w.handle.messaging.engine
        .openBlocking()
        .some(
          (m) =>
            (m.data as { type?: string } | undefined)?.type === 'memory' &&
            m.body.includes(agent.address)
        );
    expect(memoryGate()).toBe(true);

    const run = await liveRun(w, ada.token, 'ada task');
    const ws = new WebSocket(
      `ws://127.0.0.1:${w.handle.port}/ws?token=${ada.token}`
    );
    await new Promise((r) => (ws.onopen = r));
    const frames: string[] = [];
    ws.onmessage = (e) => frames.push(String(e.data));

    const rv = await call(w, w.app, 'DELETE', `/api/team/tokens/${ada.handle}`);
    expect(rv.status).toBe(200);

    // Her agent and her A2A client are revoked.
    expect(
      (await call(w, agent.token, 'GET', '/api/memory?scope=project')).status
    ).toBe(401);
    expect(w.handle.messaging.store.getAgent(agent.address)?.status).toBe(
      'revoked'
    );
    expect(w.handle.messaging.store.getAgent(client.json.address)?.status).toBe(
      'revoked'
    );

    // Her ask and her agent's proposal no longer wait on anyone.
    const open = w.handle.messaging.engine.openBlocking();
    expect(open.some((m) => m.id === ask.json.message.id)).toBe(false);
    expect(memoryGate()).toBe(false);

    // Her live run stopped.
    await waitFor(() => !w.handle.orchestrator.isRunLive(run.runId));
    expect(
      (await call(w, run.runToken, 'GET', '/api/memory?scope=personal')).status
    ).toBe(401);

    // Her socket hears nothing more (detached; see EventBus.current).
    const heard = frames.length;
    await call(w, w.app, 'POST', '/api/messages', {
      to: ['human:test'],
      kind: 'message',
      body: 'OWNER-NOTE-AFTER-REVOKE',
    });
    await call(w, w.app, 'POST', '/api/tasks', { title: 'after revoke' });
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.slice(heard)).toEqual([]);
    ws.close();
  });
});
