import type { Message } from '@dispatch-foo/protocol';
import { sealPayload } from '@dispatch-foo/protocol/federation';
import type { MailTarget } from '@dispatch-foo/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { MailOut } from '../../../src/team/federation/mail.js';
import { forgeInner, forward } from './helpers/forgeMail.js';
import { MemoryRemote } from './helpers/memoryTransport.js';
import {
  foundedTeam,
  foundedTeamWith,
  messagingReplica,
} from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';
import { MemoryV1 } from './helpers/serviceReplica.js';

// The F2 review of T14/T15 (FW-R32): each finding's repro, as a test.
let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const human = (h: string) => ({ address: `human:${h}`, canDecide: true });
const MIN = 60_000;
const advance = (rs: MessagingReplica[], ms: number) => {
  for (const r of rs) r.clock.now = new Date(r.clock.now.getTime() + ms);
};
const problems = (r: MessagingReplica, prefix: string) =>
  r.fed.problems().filter((p) => p.subject.startsWith(prefix));
const msg = (
  by: MessagingReplica,
  id: string,
  from: string,
  to: string[],
  over: Partial<Message> = {}
): Message => ({
  id,
  thread: id,
  replyTo: null,
  from,
  to,
  kind: 'message',
  body: id,
  refs: [],
  urgent: false,
  blocking: false,
  wake: 'none',
  createdAt: by.clock.now.toISOString(),
  hlc: by.hooks.hlc(),
  ...over,
});
const target = (recipient: string, r: MessagingReplica): MailTarget => ({
  recipient,
  via: 'direct',
  homes: [r.fed.replica],
});

describe('I1: the hlc binding is one-sided (FW-R32(1))', () => {
  it('delivers honest mail published long after it was written', async () => {
    open = await foundedTeam('ada', 'bob');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'written offline' },
      human('ada')
    );
    advance(open, 10 * MIN);
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage(message.id)?.body).toBe('written offline');
  });

  it('holds a message ahead of now, then applies it and clears its problem', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).clock.now = new Date(at(0).clock.now.getTime() - 4 * MIN);
    const ahead = msg(at(0), 'm-01ahead', 'human:ada', ['human:bob'], {
      hlc: `${String(at(0).clock.now.getTime() + 3 * MIN)}.0001.${at(0).fed.replica}`,
    });
    at(0).mailOut.publish(
      ahead,
      [target('human:bob', at(1))],
      [at(1).fed.replica]
    );
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage('m-01ahead')).toBeNull();
    expect(problems(at(1), 'op:')).toHaveLength(1);
    advance([at(1)], 5 * MIN);
    await at(1).service.syncNow();
    expect(at(1).messages.getMessage('m-01ahead')).not.toBeNull();
    expect(problems(at(1), 'op:')).toEqual([]);
  });
});

describe('I2: a forward carries only an op this machine verified (FW-R32(2))', () => {
  it('refuses a revoked replica speaking as itself below its cut through a forward', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    await ada.settleWith(cy);
    ada.roster.revoke(cy.fed.replica, 'left');
    await ada.service.syncNow();
    const cut = ada.roster.view()?.revoked.get(cy.fed.replica)?.afterSeq ?? 0;
    const forged = msg(cy, 'm-02forged', 'human:cy', ['human:ada']);
    const inner = forgeInner(cy, cut, forged, [target('human:ada', ada)], bob);
    forward(bob, inner, 'human:ada', ada);
    await ada.settleWith(bob);
    expect(ada.messages.getMessage('m-02forged')).toBeNull();
  });

  it("refuses a revoked replica's run mail above its cut through a forward", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const run = 'r-0000000000c1';
    cy.startRun({ id: run, taskId: null, kind: 'review' });
    await ada.settleWith(cy);
    expect(ada.hooks.remoteRunTask(run)).toBeNull();
    ada.roster.revoke(cy.fed.replica, 'left');
    await ada.service.syncNow();
    const seq = (cy.fed.head()?.seq ?? 0) + 5;
    const forged = msg(cy, 'm-03forged', `run:${run}`, ['human:ada']);
    const inner = forgeInner(cy, seq, forged, [target('human:ada', ada)], bob);
    forward(bob, inner, 'human:ada', ada);
    await ada.settleWith(bob);
    expect(ada.messages.getMessage('m-03forged')).toBeNull();
  });
});

describe('I3: a malformed F2 op never stops a pass (FW-R32(3))', () => {
  it('drops malformed presence, channel, agent and state ops, and keeps syncing', async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    for (const body of [
      { kind: 'replica', build: 'x', device: 'y', wall: null },
      {
        kind: 'run',
        run: 'r-0000000000d1',
        task: {},
        runKind: 'execute',
        live: true,
      },
      { kind: 'resolve', run: 7, replica: [] },
    ])
      bob.fed.append({ type: 'presence', body: body as never });
    bob.fed.append({
      type: 'channel',
      body: { channel: 'Not A Name!', member: 'human:bob', joined: true },
    });
    bob.fed.append({
      type: 'channel',
      body: { channel: 'ops', member: 'nobody at all', joined: true },
    });
    bob.fed.append({
      type: 'agent',
      body: {
        address: { x: 1 },
        displayName: 1,
        client: null,
        status: 'approved',
      } as never,
    });
    bob.fed.append({
      type: 'state',
      seal: (stamp) => {
        const { to, sealed } = sealPayload({
          replica: bob.fed.replica,
          seq: stamp.seq,
          type: 'state',
          payload: {
            entries: [{ t: 'delivery', message: {}, recipient: 5 }],
          } as never,
          recipients: new Map([[ada.fed.replica, ada.fed.keys.sealPub]]),
        });
        return { to, sealed };
      },
    });
    const id = bob.store.create({ title: 'after the junk' }).meta.id;
    await ada.settleWith(bob);
    expect(ada.store.get(id)?.meta.title).toBe('after the junk');
    expect(ada.messages.channels().map((c) => c.name)).toEqual([]);
    expect(problems(ada, `malformed:${bob.fed.replica}`)).toHaveLength(1);
  });
});

describe('I4: a message too large to seal never blocks the sender (FW-R32(4))', () => {
  it('splits a channel message by target, so 12k remote-less members cost nothing', async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    // As if a hostile member had joined them: straight into the store.
    const at0 = ada.clock.now.toISOString();
    ada.messages.ensureChannel('big', at0, false);
    for (const m of ['human:ada', 'human:bob'])
      ada.messages.addMember('big', m, at0);
    for (let i = 0; i < 12_000; i++)
      ada.messages.addMember('big', `human:u${i}`, at0);
    const { message } = await ada.engine.send(
      { to: ['channel:big'], kind: 'message', body: 'to everyone' },
      human('ada')
    );
    const id = ada.store.create({ title: 'still syncs' }).meta.id;
    await bob.settleWith(ada);
    expect(bob.store.get(id)?.meta.title).toBe('still syncs');
    expect(bob.messages.getMessage(message.id)?.body).toBe('to everyone');
  }, 60_000);

  it('refuses a message it cannot seal, and moves on', async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    const big = await ada.engine.send(
      { to: ['human:bob'], kind: 'message', body: 'too many targets' },
      human('ada')
    );
    // Thirty thousand recipients homed on bob: one op for bob cannot hold them.
    for (let i = 0; i < 30_000; i++)
      ada.messages.insertRemote({
        messageId: big.message.id,
        recipient: `human:h${i}`,
        via: 'channel',
        state: 'forwarded',
        homes: [bob.fed.replica],
        wakeAt: null,
        refusedBy: [],
        updatedAt: ada.clock.now.toISOString(),
      });
    const after = await ada.engine.send(
      { to: ['human:bob'], kind: 'message', body: 'next one' },
      human('ada')
    );
    await bob.settleWith(ada);
    expect(bob.messages.getMessage(after.message.id)?.body).toBe('next one');
    expect(
      ada.messages.remoteDeliveries({
        messageId: big.message.id,
        recipient: 'human:bob',
      })[0]?.state
    ).toBe('refused');
  }, 60_000);
});

describe('M2: run evidence counts only replicas standing at their op (FW-R32(5))', () => {
  it('binds a run to a member when a revoked replica claims it in the same pull', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    await ada.settleWith(cy);
    ada.roster.revoke(cy.fed.replica, 'left');
    await ada.service.syncNow();
    const run = 'r-0000000000e1';
    cy.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    bob.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    await cy.service.syncNow();
    await bob.service.syncNow();
    await ada.service.syncNow();
    expect(ada.hooks.remoteRunTask(run)).toBe('t-00000a01');
  });

  it('parks mail from a contested run instead of dropping it', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const run = 'r-0000000000e2';
    bob.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    cy.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    await bob.service.syncNow();
    await cy.service.syncNow();
    await ada.service.syncNow();
    const m = msg(bob, 'm-04contested', `run:${run}`, ['human:ada']);
    bob.mailOut.publish(m, [target('human:ada', ada)], [ada.fed.replica]);
    await ada.settleWith(bob);
    expect(ada.messages.getMessage('m-04contested')).toBeNull();
    ada.presence.resolve(run, bob.fed.replica);
    await ada.service.syncNow();
    expect(ada.messages.getMessage('m-04contested')?.body).toBe(
      'm-04contested'
    );
  });
});

describe('M3: one rolling drop note to acknowledge per publisher (FW-R32(6))', () => {
  it('collapses inbound drops into mail-drop:<replica>', async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    for (const id of ['m-05a', 'm-05b'])
      bob.mailOut.publish(
        msg(bob, id, 'human:ada', ['human:ada']),
        [target('human:ada', ada)],
        [ada.fed.replica]
      );
    await ada.settleWith(bob);
    const drops = problems(ada, 'mail-drop:');
    expect(drops.map((p) => p.subject)).toEqual([
      `mail-drop:${bob.fed.replica}`,
    ]);
    expect(problems(ada, 'message:m-05')).toEqual([]);
  });
});

describe('M4: F2 ops wait until this machine is firmly in the team (FW-R32(7))', () => {
  it('applies no channel op while pending on an automatic pin, then applies it', async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const ada = messagingReplica('ada', remote, v1);
    const bob = messagingReplica('bob', remote, v1);
    open.push(ada, bob);
    ada.roster.found('acme');
    await bob.settleWith(ada);
    ada.engine.join('ops', 'human:ada');
    await ada.service.syncNow();
    await bob.service.syncNow();
    expect(bob.roster.mailReady()).toBe(false);
    expect(bob.messages.members('ops')).toEqual([]);
    await ada.settleWith(bob);
    const { fingerprint } = await import('@dispatch-foo/protocol/federation');
    ada.roster.admit(bob.fed.replica, {
      fingerprint: fingerprint(bob.fed.keys.signPub, bob.fed.keys.sealPub),
    });
    for (let i = 0; i < 2; i++) {
      await bob.settleWith(ada);
      await ada.settleWith(bob);
    }
    expect(bob.messages.members('ops')).toEqual(['human:ada']);
  });
});

describe('FW-R32(8) minors', () => {
  it("never homes an assigned task on a run outside its assignee's machines", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const id = ada.store.create({ title: 'for bob', assignee: 'human:bob' })
      .meta.id;
    await cy.settleWith(ada);
    cy.startRun({ id: 'r-0000000000f1', taskId: id, kind: 'execute' });
    await ada.settleWith(cy);
    expect(ada.homes.of(`task:${id}`)).toEqual([bob.fed.replica]);
  });

  it('drains no queued mail while the roster is paused', async () => {
    open = await foundedTeamWith(
      { remoteMailPerReplicaPerHour: 1 },
      'ada',
      'bob',
      'cy'
    );
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    for (const body of ['one', 'two'])
      await ada.engine.send(
        { to: ['human:bob'], kind: 'message', body },
        human('ada')
      );
    await bob.settleWith(ada);
    expect(bob.messages.recentThreads(10)).toHaveLength(1);
    cy.fed.append({
      type: 'roster',
      body: { rv: 9, action: 'from-the-future' } as never,
    });
    await bob.settleWith(cy);
    expect(bob.roster.view()?.unknown).not.toBeNull();
    advance(open, 61 * MIN);
    await bob.service.syncNow();
    expect(bob.messages.recentThreads(10)).toHaveLength(1);
  });

  it('lets a mail backlog hold only mail, never task ops', async () => {
    open = await foundedTeamWith({ maxWaitingPerPublisher: 1 }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    for (const body of ['one', 'two'])
      await ada.engine.send(
        { to: ['human:bob'], kind: 'message', body },
        human('ada')
      );
    // The mail ops go out first, so the task op lands behind them.
    await ada.service.syncNow();
    const id = ada.store.create({ title: 'after the mail' }).meta.id;
    await ada.service.syncNow();
    bob.failReceives(10);
    await bob.service.syncNow();
    expect(bob.store.get(id)?.meta.title).toBe('after the mail');
  });

  it('persists the mail watermark on first use, so a late MailOut still sends', async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    ada.fed.db.query("DELETE FROM fed_meta WHERE key = 'mail_rowid'").run();
    const late = new MailOut({
      fed: ada.fed,
      roster: ada.roster,
      homes: ada.homes,
      messages: ada.messages,
    });
    late.collect();
    expect(ada.fed.meta('mail_rowid')).not.toBeNull();
    const { message } = await ada.engine.send(
      { to: ['human:bob'], kind: 'message', body: 'after' },
      human('ada')
    );
    late.collect();
    await bob.settleWith(ada);
    expect(bob.messages.getMessage(message.id)).not.toBeNull();
  });

  it('forwards only to a machine admitted to the team', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const id = ada.store.create({ title: 't', assignee: 'human:bob' }).meta.id;
    await bob.settleWith(ada);
    await ada.engine.send(
      { to: [`task:${id}`], kind: 'message', body: 'held' },
      human('ada')
    );
    ada.mailOut.collect();
    const original = ada.fed.outbox().find((o) => o.type === 'mail');
    if (original === undefined) throw new Error('no mail op');
    await bob.settleWith(ada);
    // Cy's key is still pinned on bob, but cy is revoked.
    ada.roster.revoke(cy.fed.replica, 'left');
    await bob.settleWith(ada);
    expect(bob.fed.pinned(cy.fed.replica)).not.toBeNull();
    expect(
      bob.mailOut.forward(original, `task:${id}`, cy.fed.replica)
    ).toBeNull();
    expect(
      bob.mailOut.forward(original, `task:${id}`, ada.fed.replica)
    ).not.toBeNull();
  });

  it("does not take a target's homes on the origin's word", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    // Ada claims bob's machine is a home of human:cy.
    const m = msg(ada, 'm-06homes', 'human:ada', ['human:cy']);
    ada.mailOut.publish(m, [target('human:cy', bob)], [bob.fed.replica]);
    await bob.settleWith(ada);
    expect(bob.messages.deliveries({ messageId: 'm-06homes' })).toEqual([]);
    void cy;
  });

  it('never lets a pruned run id be claimed by another machine', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const run = 'r-0000000000f2';
    bob.startRun({ id: run, taskId: 't-00000a02', kind: 'execute' });
    await ada.settleWith(bob);
    bob.host.endRun('t-00000a02');
    bob.presence.runEnded({ id: run, taskId: 't-00000a02', kind: 'execute' });
    await ada.settleWith(bob);
    advance(open, 31 * 24 * 60 * MIN);
    ada.presence.collect(ada.clock.now);
    cy.startRun({ id: run, taskId: 't-00000a02', kind: 'execute' });
    await ada.settleWith(cy);
    expect(ada.hooks.remoteRunTask(run)).toBeNull();
  });
});

describe('T16 concerns', () => {
  it("tells a machine whose run was resolved away, and stops its run's mail", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const run = 'r-0000000000a9';
    bob.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    cy.startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    for (const r of [bob, cy, ada, bob, cy]) await r.service.syncNow();
    ada.presence.resolve(run, cy.fed.replica);
    await bob.settleWith(ada);
    expect(
      bob.fed
        .problems()
        .some(
          (p) =>
            p.message.includes(`run ${run}`) && p.message.includes('resolved')
        )
    ).toBe(true);
    await bob.engine.send(
      { to: ['human:ada'], kind: 'message', body: 'from the losing run' },
      { address: `run:${run}`, canDecide: false }
    );
    bob.mailOut.collect();
    expect(bob.fed.outbox().filter((o) => o.type === 'mail')).toEqual([]);
  });

  it('holds state ops past a per-replica hourly quota', async () => {
    open = await foundedTeamWith({ stateOpsPerHour: 1 }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    const sent = [];
    for (const body of ['a', 'b'])
      sent.push(
        (
          await ada.engine.send(
            { to: ['human:bob'], kind: 'message', body },
            human('ada')
          )
        ).message
      );
    await bob.settleWith(ada);
    for (const m of sent) {
      const d = bob.messages.deliveries({ messageId: m.id })[0];
      bob.engine.markRead(d?.id ?? '');
      await bob.service.syncNow();
    }
    await ada.service.syncNow();
    const read = sent.filter(
      (m) =>
        ada.messages.remoteDeliveries({ messageId: m.id })[0]?.state === 'read'
    );
    expect(read).toHaveLength(1);
    advance(open, 61 * MIN);
    await ada.service.syncNow();
    expect(
      sent.every(
        (m) =>
          ada.messages.remoteDeliveries({ messageId: m.id })[0]?.state ===
          'read'
      )
    ).toBe(true);
  });
});
