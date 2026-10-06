import { describe, expect, it } from 'bun:test';

import { rawFetch } from '../testAuth.js';
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
    const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));

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

    // Her socket is closed as a policy violation and hears nothing more.
    expect(await closed).toBe(1008);
    const heard = frames.length;
    await call(w, w.app, 'POST', '/api/messages', {
      to: ['human:test'],
      kind: 'message',
      body: 'OWNER-NOTE-AFTER-REVOKE',
    });
    await call(w, w.app, 'POST', '/api/tasks', { title: 'after revoke' });
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.slice(heard)).toEqual([]);
  });

  it('cancels the run, and its run token stops working everywhere', async () => {
    const w = world();
    const ada = await invite(w, 'ada@x.io', 'request');
    const run = await liveRun(w, ada.token, 'ada task');
    expect((await call(w, run.runToken, 'GET', '/api/tasks')).status).toBe(200);

    await call(w, w.app, 'DELETE', `/api/team/tokens/${ada.handle}`);
    await waitFor(() => !w.handle.orchestrator.isRunLive(run.runId));

    for (const [method, path, body] of [
      ['GET', '/api/tasks', undefined],
      ['POST', '/api/tasks', { title: 'after revoke' }],
      ['GET', '/api/mailbox', undefined],
      ['GET', '/api/memory?scope=project', undefined],
      [
        'POST',
        '/api/messages',
        { to: ['human:test'], kind: 'message', body: 'x' },
      ],
    ] as const) {
      expect((await call(w, run.runToken, method, path, body)).status).toBe(
        401
      );
    }
  });

  it('an ask racing the revoke is refused, or lands and is closed', async () => {
    const w = world();
    const ada = await invite(w, 'ada@x.io', 'decide');
    // The ask's headers (and so its credential) reach the daemon before the
    // revoke; its body only after the revoke's cascade has run.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"to":["human:test"],'));
        await gate;
        controller.enqueue(
          new TextEncoder().encode(
            '"kind":"question","blocking":true,"body":"late ask"}'
          )
        );
        controller.close();
      },
    });
    const ask = rawFetch(`${w.base}/api/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ada.token}`,
      },
      body,
      duplex: 'half',
    } as RequestInit);
    await new Promise((r) => setTimeout(r, 100));
    expect(
      (await call(w, w.app, 'DELETE', `/api/team/tokens/${ada.handle}`)).status
    ).toBe(200);
    release?.();
    const res = await ask;
    expect([201, 401, 403]).toContain(res.status);
    if (res.status === 201) {
      const { message } = (await res.json()) as { message: { id: string } };
      await waitFor(
        () =>
          !w.handle.messaging.engine
            .openBlocking()
            .some((m) => m.id === message.id)
      );
    }
  });
});
