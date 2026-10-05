import type { Message } from '@dispatch/protocol';
import { sealPayload } from '@dispatch/protocol/federation';
import type { MailTarget } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

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

describe('X2: a forward of an op no longer remembered waits (FW-R35(2))', () => {
  it('parks a forward whose original is past the seen rows, and the holder retries a refusal', async () => {
    open = await foundedTeamWith({ mailSeenKept: 1 }, 'ada', 'bob', 'cy');
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
    // More of ada's mail after it pushes it out of cy's seen rows.
    for (const body of ['one', 'two'])
      await ada.engine.send(
        { to: ['human:cy'], kind: 'message', body },
        human('ada')
      );
    await bob.settleWith(ada);
    await cy.settleWith(ada);
    await cy.service.syncNow();
    bob.presence.runEnded({
      id: 'r-0000000000b1',
      taskId: task,
      kind: 'execute',
    });
    await cy.startExecute(task, 'r-0000000000c1');
    await bob.settleWith(cy);
    await cy.settleWith(bob);
    const parked = cy.fed.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM fed_parked WHERE replica = ?'
      )
      .get(bob.fed.replica)?.n;
    expect(parked).toBe(1);
    // Cy refuses it: bob forwards again on its next pass.
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
    const forwards = (bob.remote.logs.get(bob.fed.replica) ?? []).filter(
      (e) => e.type === 'mail' && e.seq > before
    );
    expect(forwards.length).toBeGreaterThan(0);
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
