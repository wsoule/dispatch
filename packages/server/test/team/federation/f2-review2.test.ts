import type { Message } from '@dispatch-foo/protocol';
import { sealPayload } from '@dispatch-foo/protocol/federation';
import type { MailTarget } from '@dispatch-foo/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { foundedTeam, foundedTeamWith } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

// The re-verify of b9700c73 (FW-R33): each finding's repro, as a test.
let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const human = (h: string) => ({ address: `human:${h}`, canDecide: true });
const DAY = 24 * 60 * 60 * 1000;
const advance = (rs: MessagingReplica[], ms: number) => {
  for (const r of rs) r.clock.now = new Date(r.clock.now.getTime() + ms);
};
const parked = (r: MessagingReplica) =>
  r.fed.db
    .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_parked')
    .get()?.n ?? 0;

describe('N1: held task mail survives a late handoff (FW-R33(1))', () => {
  it('forwards a month-old held copy to the next run, and keeps it until delivered', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const id = ada.store.create({ title: 'handed on', assignee: 'human' }).meta
      .id;
    for (const r of [bob, cy]) await r.settleWith(ada);
    // Bob's run claims the task and ends before ada's mail reaches it.
    await bob.startExecute(id, 'r-0000000000b1');
    await ada.settleWith(bob);
    bob.host.endRun(id);
    const { message } = await ada.engine.send(
      { to: [`task:${id}`], kind: 'message', body: 'context' },
      human('ada')
    );
    await bob.settleWith(ada);
    await cy.settleWith(ada);
    expect(
      bob.messages.deliveries({ messageId: message.id }).map((d) => d.state)
    ).toEqual(['held']);
    bob.presence.runEnded({
      id: 'r-0000000000b1',
      taskId: id,
      kind: 'execute',
    });
    advance(open, 31 * DAY);
    for (const r of open) await r.service.syncNow();
    await cy.startExecute(id, 'r-0000000000c1');
    await bob.settleWith(cy);
    // Bob forwarded; its copy stays until cy says it was delivered.
    expect(bob.messages.deliveries({ messageId: message.id })).toHaveLength(1);
    await cy.settleWith(bob);
    expect(cy.host.pushed.map((p) => p.messageId)).toContain(message.id);
    await bob.settleWith(cy);
    expect(bob.messages.deliveries({ messageId: message.id })).toEqual([]);
  });

  it('accepts a forward of an op this machine only saw as a stub', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const id = ada.store.create({ title: 'stubbed', assignee: 'human' }).meta
      .id;
    for (const r of [bob, cy]) await r.settleWith(ada);
    await bob.startExecute(id, 'r-0000000000b2');
    await ada.settleWith(bob);
    bob.host.endRun(id);
    const { message } = await ada.engine.send(
      { to: [`task:${id}`], kind: 'message', body: 'stubbed context' },
      human('ada')
    );
    await bob.settleWith(ada);
    // Cy reads only the stub of ada's mail op.
    const op = (ada.remote.logs.get(ada.fed.replica) ?? []).find(
      (e) => e.type === 'mail'
    );
    if (op === undefined) throw new Error('no mail op');
    const { stubOf } = await import('@dispatch-foo/protocol/federation');
    ada.remote.tamper(ada.fed.replica, op.seq, (e) => stubOf(e as never));
    await cy.settleWith(ada);
    bob.presence.runEnded({
      id: 'r-0000000000b2',
      taskId: id,
      kind: 'execute',
    });
    await cy.startExecute(id, 'r-0000000000c2');
    await bob.settleWith(cy);
    await cy.settleWith(bob);
    expect(cy.host.pushed.map((p) => p.messageId)).toContain(message.id);
  });
});

describe('N2: an unassigned task has no remote home (FW-R33(2))', () => {
  it("holds an unassigned task's mail at its origin, and moves it once assigned", async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    const id = ada.store.create({ title: 'nobody yet' }).meta.id;
    await bob.settleWith(ada);
    await bob.startExecute(id, 'r-0000000000b3');
    await ada.settleWith(bob);
    expect(ada.homes.of(`task:${id}`)).toEqual([]);
    const { message } = await ada.engine.send(
      { to: [`task:${id}`], kind: 'message', body: 'wait for an owner' },
      human('ada')
    );
    await bob.settleWith(ada);
    expect(bob.messages.getMessage(message.id)).toBeNull();
    ada.store.update(id, { assignee: 'human' });
    await bob.settleWith(ada);
    await ada.settleWith(bob);
    await bob.settleWith(ada);
    expect(bob.host.pushed.map((p) => p.messageId)).toContain(message.id);
  });

  it('counts a delivery report only from a machine the message was sealed to', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const id = ada.store.create({ title: 'held', assignee: 'human' }).meta.id;
    await bob.settleWith(ada);
    await bob.startExecute(id, 'r-0000000000b4');
    await ada.settleWith(bob);
    const { message } = await ada.engine.send(
      { to: [`task:${id}`], kind: 'message', body: 'for the run' },
      human('ada')
    );
    await ada.service.syncNow();
    // Bob's run ends; cy's run is then the task's live run, though ada's
    // mail was never sealed to cy, and cy reports a read it never had.
    bob.host.endRun(id);
    bob.presence.runEnded({
      id: 'r-0000000000b4',
      taskId: id,
      kind: 'execute',
    });
    await ada.settleWith(bob);
    await cy.startExecute(id, 'r-0000000000c4');
    await ada.settleWith(cy);
    expect(ada.homes.taskLiveRun(id)?.replica).toBe(cy.fed.replica);
    cy.fed.append({
      type: 'state',
      seal: (stamp) => {
        const { to, sealed } = sealPayload({
          replica: cy.fed.replica,
          seq: stamp.seq,
          type: 'state',
          payload: {
            entries: [
              {
                t: 'delivery',
                message: message.id,
                recipient: `task:${id}`,
                state: 'read',
                at: cy.clock.now.toISOString(),
              },
            ],
          } as never,
          recipients: new Map([[ada.fed.replica, ada.fed.keys.sealPub]]),
        });
        return { to, sealed };
      },
    });
    await ada.settleWith(cy);
    expect(
      ada.messages.remoteDeliveries({ messageId: message.id })[0]?.state
    ).not.toBe('read');
  });
});

describe('N3: a resolve that arrives before its claim waits (FW-R33(3))', () => {
  it('binds the run the same way on a machine that reads the resolve first', async () => {
    open = await foundedTeamWith(
      { observers: ['ops'] },
      'ada',
      'bob',
      'cy',
      'ops'
    );
    const [ada, bob, cy, ops] = [at(0), at(1), at(2), at(3)];
    const run = 'r-0000000000d3';
    // Cy's clock runs ahead, so its claim can sort after ada's resolve.
    cy.clock.now = new Date(cy.clock.now.getTime() + 3 * 60_000);
    bob.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    cy.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    await bob.service.syncNow();
    await cy.service.syncNow();
    await ada.service.syncNow();
    ada.presence.resolve(run, cy.fed.replica);
    await ada.service.syncNow();
    // Ops reads both claims and the resolve in one pull.
    await ops.service.syncNow();
    await ops.service.syncNow();
    expect(ada.hooks.remoteRunTask(run)).toBe('t-00000a01');
    expect(ops.homes.taskLiveRun('t-00000a01')?.replica ?? null).toBe(
      ada.homes.taskLiveRun('t-00000a01')?.replica ?? null
    );
    expect(
      ops.fed.db
        .query<{ replica: string }, [string]>(
          'SELECT replica FROM fed_runs WHERE run = ?'
        )
        .get(run)?.replica
    ).toBe(cy.fed.replica);
  });
});

describe('N4: validator caps hold every honest producer (FW-R33(4))', () => {
  it('accepts an agent whose client name is as long as registration allows', async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    bob.messages.putAgent({
      address: 'agent:bob/long',
      displayName: 'long',
      client: 'c'.repeat(100),
      tokenHash: 'a'.repeat(64),
      status: 'approved',
      muted: false,
      approvedBy: null,
      createdAt: '2026-09-26T00:00:00.000Z',
    });
    await ada.settleWith(bob);
    expect(ada.messages.getAgent('agent:bob/long')?.client).toBe(
      'c'.repeat(100)
    );
  });
});

describe('N5: every park is capped, and restage stays within a budget (FW-R33(5))', () => {
  it('drops the oldest parked op of a publisher past the cap', async () => {
    open = await foundedTeamWith({ maxParkedPerPublisher: 2 }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    for (let i = 0; i < 4; i++) {
      const m: Message = {
        id: `m-07park${i}`,
        thread: `m-07park${i}`,
        replyTo: null,
        from: `run:r-00000000d${i}`,
        to: ['human:ada'],
        kind: 'message',
        body: 'parked',
        refs: [],
        urgent: false,
        blocking: false,
        wake: 'none',
        createdAt: bob.clock.now.toISOString(),
        hlc: bob.hooks.hlc(),
      };
      const target: MailTarget = {
        recipient: 'human:ada',
        via: 'direct',
        homes: [ada.fed.replica],
      };
      bob.mailOut.publish(m, [target], [ada.fed.replica]);
    }
    await ada.settleWith(bob);
    expect(parked(ada)).toBe(2);
    expect(
      ada.fed
        .problems()
        .some((p) => p.subject === `mail-drop:${bob.fed.replica}`)
    ).toBe(true);
  });
});

describe('FW-R33 minors', () => {
  it("gives the sender's other device the full target list", async () => {
    open = await foundedTeam('ada', 'bob', 'ada');
    const [ada, bob, ada2] = [at(0), at(1), at(2)];
    const id = ada.store.create({ title: 'on ada2', assignee: 'human' }).meta
      .id;
    await ada2.settleWith(ada);
    await ada2.startExecute(id, 'r-0000000000a2');
    await ada.settleWith(ada2);
    const { message } = await ada.engine.send(
      { to: ['human:bob', `task:${id}`], kind: 'message', body: 'both' },
      human('ada')
    );
    await ada2.settleWith(ada);
    const rows = ada2.messages
      .remoteDeliveries({ messageId: message.id })
      .map((r) => r.recipient);
    expect(rows).toContain('human:bob');
    void bob;
  });
});
