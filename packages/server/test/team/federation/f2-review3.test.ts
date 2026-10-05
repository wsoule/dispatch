import type { Message } from '@dispatch/protocol';
import { sealPayload } from '@dispatch/protocol/federation';
import type { MailTarget } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { forgeInner, forward } from './helpers/forgeMail.js';
import { foundedTeam, foundedTeamWith } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

// The F2 whole-phase review (FW-R35): each finding's repro, as a test.
let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const human = (h: string) => ({ address: `human:${h}`, canDecide: true });

// `from` reports `entries` to `to` in a state op it signs.
function report(
  from: MessagingReplica,
  to: MessagingReplica,
  entries: unknown[]
): void {
  from.fed.append({
    type: 'state',
    seal: (stamp) => {
      const { to: sealedTo, sealed } = sealPayload({
        replica: from.fed.replica,
        seq: stamp.seq,
        type: 'state',
        payload: { entries } as never,
        recipients: new Map([[to.fed.replica, to.fed.keys.sealPub]]),
      });
      return { to: sealedTo, sealed };
    },
  });
}

describe('X1: a delivery report counts only from a home of its recipient (FW-R35(1))', () => {
  it('keeps a held task copy when a machine sealed for another target reports it', async () => {
    open = await foundedTeam('ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    const task = ada.store.create({ title: 'T', assignee: 'human' }).meta.id;
    await bob.settleWith(ada);
    const { message } = await ada.engine.send(
      { to: ['human:bob', `task:${task}`], kind: 'message', body: 'both' },
      human('ada')
    );
    await bob.settleWith(ada);
    expect(bob.messages.getMessage(message.id)).not.toBeNull();
    const held = () =>
      ada.messages
        .deliveries({ messageId: message.id, recipient: `task:${task}` })
        .map((d) => d.state);
    expect(held()).toEqual(['held']);
    report(bob, ada, [
      {
        t: 'delivery',
        message: message.id,
        recipient: `task:${task}`,
        state: 'pushed',
        at: bob.clock.now.toISOString(),
      },
    ]);
    await ada.settleWith(bob);
    expect(held()).toEqual(['held']);
  });
});

describe('X1b: the hand-off exception covers only the handed recipient (FW-R36(3))', () => {
  it("lets no claimant report another recipient's state", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const task = bob.store.create({ title: 'T', assignee: 'human' }).meta.id;
    for (const r of [ada, cy]) await r.settleWith(bob);
    await ada.startExecute(task, 'r-0000000000a3');
    await bob.settleWith(ada);
    ada.host.endRun(task);
    const { message } = await bob.engine.send(
      { to: [`task:${task}`, 'human:ada'], kind: 'message', body: 'both' },
      human('bob')
    );
    await ada.settleWith(bob);
    ada.presence.runEnded({
      id: 'r-0000000000a3',
      taskId: task,
      kind: 'execute',
    });
    await cy.startExecute(task, 'r-0000000000c3');
    await ada.settleWith(cy);
    await cy.settleWith(ada);
    const mine = () =>
      ada.messages
        .deliveries({ messageId: message.id, recipient: 'human:ada' })
        .map((d) => d.state);
    expect(mine()).toEqual(['notified']);
    report(cy, ada, [
      {
        t: 'delivery',
        message: message.id,
        recipient: 'human:ada',
        state: 'read',
        at: cy.clock.now.toISOString(),
      },
    ]);
    await ada.settleWith(cy);
    expect(mine()).toEqual(['notified']);
  });
});

describe('X2: a forward is applied only against a hash verified here (FW-R36)', () => {
  // Bob held ada's task mail when his run ended; cy's run takes the task.
  async function handoff(forgetOriginal: boolean) {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const task = ada.store.create({ title: 'held', assignee: 'human' }).meta.id;
    for (const r of [bob, cy]) await r.settleWith(ada);
    await bob.startExecute(task, 'r-0000000000b1');
    await ada.settleWith(bob);
    bob.host.endRun(task);
    const { message } = await ada.engine.send(
      { to: [`task:${task}`], kind: 'message', body: 'context' },
      human('ada')
    );
    await bob.settleWith(ada);
    await cy.settleWith(ada);
    if (forgetOriginal)
      // As on a machine that verified ada's op before it kept these rows.
      cy.fed.db
        .query('DELETE FROM fed_mail_seen WHERE replica = ?')
        .run(ada.fed.replica);
    bob.presence.runEnded({
      id: 'r-0000000000b1',
      taskId: task,
      kind: 'execute',
    });
    await cy.startExecute(task, 'r-0000000000c1');
    for (let i = 0; i < 3; i++) {
      await bob.settleWith(cy);
      await cy.settleWith(bob);
    }
    return { ada, bob, cy, task, message };
  }

  it('delivers a forward of an op whose hash this machine verified', async () => {
    const { bob, cy, task, message } = await handoff(false);
    expect(cy.host.pushed.map((p) => p.messageId)).toContain(message.id);
    await bob.settleWith(cy);
    expect(
      bob.messages.deliveries({
        messageId: message.id,
        recipient: `task:${task}`,
      })
    ).toEqual([]);
  });

  it('refuses a forward of an op passed with no hash here; the holder keeps its copy', async () => {
    const { bob, cy, task, message } = await handoff(true);
    expect(cy.host.pushed.map((p) => p.messageId)).not.toContain(message.id);
    expect(
      cy.fed.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_parked')
        .get()?.n
    ).toBe(0);
    expect(
      bob.messages
        .deliveries({ messageId: message.id, recipient: `task:${task}` })
        .map((d) => d.state)
    ).toEqual(['held']);
    expect(
      bob.fed.problems().some((p) => p.subject === `mail-out:${message.id}`)
    ).toBe(true);
    const before = bob.fed.head()?.seq ?? 0;
    await bob.service.syncNow();
    await bob.service.syncNow();
    expect(
      (bob.remote.logs.get(bob.fed.replica) ?? []).filter(
        (e) => e.type === 'mail' && e.seq > before
      )
    ).toEqual([]);
  });

  // FW-R32 I2b, reopened by the branch check: a revoked replica's fork of an
  // old seq, forwarded by a member, is never delivered.
  it("never delivers a revoked replica's fork of an old op through a forward", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    for (let i = 0; i < 6; i++)
      await cy.engine.send(
        { to: ['human:bob'], kind: 'message', body: `n${i}` },
        human('cy')
      );
    await bob.settleWith(cy);
    await ada.settleWith(cy);
    ada.roster.revoke(cy.fed.replica, 'left');
    await ada.service.syncNow();
    await bob.settleWith(ada);
    const mails = (cy.remote.logs.get(cy.fed.replica) ?? []).filter(
      (e) => e.type === 'mail'
    );
    const old = mails[0];
    if (old === undefined) throw new Error('no mail');
    const forged = {
      id: 'm-09forged',
      thread: 'm-09forged',
      replyTo: null,
      from: 'human:cy',
      to: ['human:bob'],
      kind: 'message' as const,
      body: 'forged',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none' as const,
      createdAt: cy.clock.now.toISOString(),
      hlc: old.hlc,
    };
    const inner = forgeInner(
      cy,
      old.seq,
      forged,
      [{ recipient: 'human:bob', via: 'direct', homes: [bob.fed.replica] }],
      ada
    );
    forward(ada, inner, 'human:bob', bob);
    for (let i = 0; i < 2; i++) await bob.settleWith(ada);
    expect(bob.messages.getMessage('m-09forged')).toBeNull();
  });

  it('hands a held copy on again after any other refusal', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const task = ada.store.create({ title: 'held', assignee: 'human' }).meta.id;
    for (const r of [bob, cy]) await r.settleWith(ada);
    await bob.startExecute(task, 'r-0000000000b2');
    await ada.settleWith(bob);
    bob.host.endRun(task);
    const { message } = await ada.engine.send(
      { to: [`task:${task}`], kind: 'message', body: 'context' },
      human('ada')
    );
    await bob.settleWith(ada);
    bob.presence.runEnded({
      id: 'r-0000000000b2',
      taskId: task,
      kind: 'execute',
    });
    await cy.startExecute(task, 'r-0000000000c2');
    await bob.settleWith(cy);
    // Cy refuses before it reads the forward: bob hands it on again.
    report(cy, bob, [
      {
        t: 'refused',
        message: message.id,
        reason: 'not found',
        at: cy.clock.now.toISOString(),
      },
    ]);
    const before = bob.fed.head()?.seq ?? 0;
    await bob.settleWith(cy);
    await bob.service.syncNow();
    expect(
      (bob.remote.logs.get(bob.fed.replica) ?? []).filter(
        (e) => e.type === 'mail' && e.seq > before
      ).length
    ).toBeGreaterThan(0);
  });
});

describe('X3: restage rotates within a publisher (FW-R35(3))', () => {
  it('applies a later parked op behind ops that stay stuck', async () => {
    open = await foundedTeamWith({ restagePerPublisher: 2 }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    const target: MailTarget = {
      recipient: 'human:ada',
      via: 'direct',
      homes: [ada.fed.replica],
    };
    const mail = (id: string, run: string): Message => ({
      id,
      thread: id,
      replyTo: null,
      from: `run:${run}`,
      to: ['human:ada'],
      kind: 'message',
      body: id,
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: bob.clock.now.toISOString(),
      hlc: bob.hooks.hlc(),
    });
    // Three runs that never claim, then one that will.
    for (let i = 0; i < 3; i++)
      bob.mailOut.publish(
        mail(`m-08stuck${i}`, `r-00000000e${i}0`),
        [target],
        [ada.fed.replica]
      );
    bob.mailOut.publish(
      mail('m-08later', 'r-00000000e9a'),
      [target],
      [ada.fed.replica]
    );
    await ada.settleWith(bob);
    bob.startRun({ id: 'r-00000000e9a', taskId: null, kind: 'review' });
    for (let i = 0; i < 4; i++) await ada.settleWith(bob);
    expect(ada.messages.getMessage('m-08later')?.body).toBe('m-08later');
  });
});

describe('FW-R35 minors', () => {
  it('records a forwarder only once the forwarded mail is received, and drops it once delivered', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const task = ada.store.create({ title: 'held', assignee: 'human' }).meta.id;
    for (const r of [bob, cy]) await r.settleWith(ada);
    await bob.startExecute(task, 'r-0000000000b5');
    await ada.settleWith(bob);
    bob.host.endRun(task);
    await ada.engine.send(
      { to: [`task:${task}`], kind: 'message', body: 'context' },
      human('ada')
    );
    await bob.settleWith(ada);
    await cy.settleWith(ada);
    bob.presence.runEnded({
      id: 'r-0000000000b5',
      taskId: task,
      kind: 'execute',
    });
    await cy.startExecute(task, 'r-0000000000c5');
    await bob.settleWith(cy);
    const forwarders = () =>
      cy.fed.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM fed_published WHERE kind = 'forwarder'"
        )
        .get()?.n;
    cy.failReceives(1);
    await cy.settleWith(bob);
    expect(forwarders()).toBe(0);
    await cy.service.syncNow();
    expect(cy.host.pushed.length).toBeGreaterThan(0);
    expect(forwarders()).toBe(0);
  });
});
