import { Database } from 'bun:sqlite';
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runsDir } from '../../../src/orchestrator/paths.js';
import { mcpCall, SessionExecutor } from '../../a2a/mcp.js';
import { waitFor } from '../../messaging/harness.js';
import { useLinkDaemons } from './daemons.js';
import type { LinkDaemon } from './daemons.js';

// Real daemons exchanging over a scratch bare repo: no listener on either side.
setDefaultTimeout(90_000);

const { daemon, linkPair, home } = useLinkDaemons();
const json = { 'content-type': 'application/json' };
const HUMAN = (d: LinkDaemon) => ({ address: d.owner, canDecide: true });

async function reply(d: LinkDaemon, id: string, body: string) {
  const res = await fetch(
    `http://127.0.0.1:${d.handle.port}/api/messages/${id}/reply`,
    { method: 'POST', headers: json, body: JSON.stringify({ body }) }
  );
  expect(res.status).toBeLessThan(300);
}

function openQuestion(d: LinkDaemon, body: string) {
  return d.handle.messaging.engine.openBlocking().find((m) => m.body === body);
}

describe('A2A over a teammate link (T54)', () => {
  it("a run's blocking msg_send to a2a:bob over a link returns Bob's answer", async () => {
    const executor = new SessionExecutor();
    const ada = await daemon('link-ada-', {
      writeDaemonFile: true,
      registerExecutors: (o: {
        registerExecutor: (n: string, e: SessionExecutor) => void;
      }) => o.registerExecutor('session', executor),
    });
    const bob = await daemon('link-bob-');
    await linkPair(ada, 'bob', bob, 'ada');
    expect(ada.handle.a2a.listening()).toBe(false);
    expect(bob.handle.a2a.listening()).toBe(false);
    const created = (await (
      await fetch(`http://127.0.0.1:${ada.handle.port}/api/tasks`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'ask a teammate' }),
      })
    ).json()) as { meta: { id: string } };
    const run = await ada.handle.orchestrator.dispatch(
      created.meta.id,
      'session'
    );
    await waitFor(() => executor.tokenFile !== null, 5000);
    const call = mcpCall(
      ada.root,
      {
        DISPATCH_HOME: home(),
        DISPATCH_RUN_TOKEN_FILE: executor.tokenFile ?? '',
        DISPATCH_RUN_ID: run.id,
      },
      'msg_send',
      {
        to: ['a2a:bob'],
        kind: 'question',
        blocking: true,
        body: 'Is the /sessions shape final?',
      }
    );
    let q: ReturnType<typeof openQuestion>;
    await waitFor(() => {
      q = openQuestion(bob, 'Is the /sessions shape final?');
      return q !== undefined;
    }, 30_000);
    await reply(bob, q!.id, 'Final.');
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      message: { from: `run:${run.id}`, to: ['a2a:bob'] },
      answer: { from: 'a2a:bob', kind: 'answer' },
    });
  });

  it('a handoff over a link becomes a draft and a gate, A2A-origin', async () => {
    const ada = await daemon('link-ada-');
    const bob = await daemon('link-bob-');
    await linkPair(ada, 'bob', bob, 'ada');
    await ada.handle.messaging.engine.send(
      {
        to: ['a2a:bob'],
        kind: 'handoff',
        body: 'Rate-limit uploads\n\nDetails.',
      },
      HUMAN(ada)
    );
    const store = bob.handle.a2a.store!;
    const client = () => store.clients().find((c) => c.name === 'a2a.ada');
    await waitFor(() => {
      const c = client();
      return c !== undefined && store.tasksOf(c.address).length > 0;
    }, 30_000);
    const row = store.tasksOf(client()!.address)[0];
    expect(row.skill).toBe('handoff');
    expect(row.gate).not.toBeNull();
    expect(row.dispatchTask).not.toBeNull();
    expect(bob.handle.a2a.taskOrigin(row.dispatchTask!)).toBe('a2a');
  });

  it("counts link requests against the receiver's limits", async () => {
    const ada = await daemon('link-ada-');
    const bob = await daemon('link-bob-');
    writeFileSync(
      join(bob.root, '.dispatch', 'config.yml'),
      'a2a:\n  requestsPerMinute: 1\n'
    );
    await linkPair(ada, 'bob', bob, 'ada');
    for (const body of ['first?', 'second?'])
      await ada.handle.messaging.engine.send(
        { to: ['a2a:bob'], kind: 'question', body },
        HUMAN(ada)
      );
    await waitFor(() => openQuestion(bob, 'first?') !== undefined, 30_000);
    for (let i = 0; i < 3; i++) {
      await ada.handle.a2a.links!.settle();
      await bob.handle.a2a.links!.settle();
    }
    expect(openQuestion(bob, 'second?')).toBeUndefined();
  });

  it('re-publishes the current snapshot on resync', async () => {
    const ada = await daemon('link-ada-');
    const bob = await daemon('link-bob-');
    await linkPair(ada, 'bob', bob, 'ada');
    const { message: q } = await ada.handle.messaging.engine.send(
      { to: ['a2a:bob'], kind: 'question', body: 'resync me?' },
      HUMAN(ada)
    );
    const hub = ada.handle.a2a.links!;
    await waitFor(() => hub.taskFor('bob', q.id) !== null, 30_000);
    const taskId = hub.taskFor('bob', q.id)!;
    const before = hub.snapshot('bob', taskId)!.at;
    await new Promise((r) => setTimeout(r, 20));
    expect(hub.publish('bob', { kind: 'resync', taskId })).toBe('published');
    await waitFor(() => hub.snapshot('bob', taskId)!.at !== before, 30_000);
  });

  it('unpair over the link stops both sides; an unpair naming another pairing does nothing', async () => {
    const ada = await daemon('link-ada-');
    const bob = await daemon('link-bob-');
    const id = await linkPair(ada, 'bob', bob, 'ada');
    await ada.handle.a2a.links!.settle();
    await bob.handle.a2a.links!.settle();
    // N4: the payload must name this pairing.
    ada.handle.a2a.links!.publish('bob', {
      kind: 'unpair',
      id: 'A'.repeat(22),
      at: new Date().toISOString(),
    });
    await ada.handle.a2a.links!.settle();
    await bob.handle.a2a.links!.settle();
    expect(bob.handle.a2a.peerStatus('ada')).toBe('active');
    const res = await fetch(
      `http://127.0.0.1:${ada.handle.port}/api/a2a/peers/bob`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(204);
    await waitFor(() => ada.handle.a2a.peerStatus('bob') === null, 30_000);
    await waitFor(
      () => bob.handle.a2a.peerStatus('ada') === 'disabled',
      30_000
    );
    expect(bob.handle.a2a.store!.pairing(id)?.state).toBe('unpaired');
  });

  it('gives a link question 7 days, not 24 hours', async () => {
    const ada = await daemon('link-ada-');
    const bob = await daemon('link-bob-');
    await linkPair(ada, 'bob', bob, 'ada');
    await bob.handle.stop();
    const { message: q } = await ada.handle.messaging.engine.send(
      { to: ['a2a:bob'], kind: 'question', body: 'anyone there?' },
      HUMAN(ada)
    );
    const store = ada.handle.a2a.store!;
    await waitFor(
      () => store.getOutbound(q.id, 'bob')?.state === 'open',
      30_000
    );
    // The store keeps a row's first attempt time; move it in the file.
    const back = (days: number) => {
      const db = new Database(join(runsDir(ada.root), 'a2a.db'));
      db.query(
        'UPDATE outbound SET first_attempt_at = ? WHERE message_id = ?'
      ).run(new Date(Date.now() - days * 86_400_000).toISOString(), q.id);
      db.close();
    };
    back(2);
    ada.handle.a2a.outbound!.peerGone('bob', 'disabled');
    ada.handle.a2a.outbound!.kick('bob');
    await new Promise((r) => setTimeout(r, 500));
    expect(store.getOutbound(q.id, 'bob')?.state).toBe('open');
    back(8);
    // Tracking restarts and finds the row past 7 days.
    ada.handle.a2a.outbound!.peerGone('bob', 'disabled');
    ada.handle.a2a.outbound!.kick('bob');
    await waitFor(
      () => store.getOutbound(q.id, 'bob')?.state === 'failed',
      30_000
    );
    expect(ada.handle.messaging.engine.answerOf(q.id)?.body).toContain(
      '7 days'
    );
  });
});
