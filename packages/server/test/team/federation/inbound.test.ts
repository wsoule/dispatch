import type { Message } from '@dispatch-foo/protocol';
import {
  b64u,
  sealPayload,
  unwrapContentKey,
} from '@dispatch-foo/protocol/federation';
import type { FederatedOp } from '@dispatch-foo/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { foundedTeam, foundedTeamWith } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const human = (h: string) => ({ address: `human:${h}`, canDecide: true });
const kinds = (r: MessagingReplica) =>
  r.fed.db
    .query<{ kind: string }, []>('SELECT kind FROM fed_audit ORDER BY id')
    .all()
    .map((row) => row.kind);
// A message `from` authors, stamped with a fresh tick of `by`'s clock, as
// its origin would store it.
const authored = (
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
const toBob = (bob: MessagingReplica) => [
  { recipient: 'human:bob', via: 'direct' as const, homes: [bob.fed.replica] },
];

// A holder hands an original op on to `to` for a target the original never
// had: MailOut.forward refuses that, so this signs it by hand.
function forgeForward(
  holder: MessagingReplica,
  original: FederatedOp,
  target: string,
  to: MessagingReplica
): void {
  const key = unwrapContentKey(
    original,
    holder.fed.replica,
    holder.fed.keys.sealPriv
  );
  if (key === null) throw new Error('the holder cannot open the original');
  holder.fed.append({
    type: 'mail',
    body: { forward: original as never },
    seal: (stamp) => {
      const { to: sealedTo, sealed } = sealPayload({
        replica: holder.fed.replica,
        seq: stamp.seq,
        type: 'mail',
        payload: { target, key: b64u(key) },
        recipients: new Map([[to.fed.replica, to.fed.keys.sealPub]]),
      });
      return { to: sealedTo, sealed };
    },
  });
}

describe('mail in', () => {
  it("delivers a teammate's DM into this replica's messages.db with its origin", async () => {
    open = await foundedTeam('ada', 'bob');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'lunch?' },
      human('ada')
    );
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage(message.id)).toMatchObject({
      body: 'lunch?',
      origin: at(0).fed.replica,
    });
    expect(at(1).messages.deliveries({ messageId: message.id })[0]?.state).toBe(
      'notified'
    );
    expect(at(1).stateCalls.received).toEqual([
      [message.id, at(0).fed.replica],
    ]);
  });

  it('drops mail whose sender the origin cannot speak for, with a problem', async () => {
    open = await foundedTeam('ada', 'bob');
    const forged = authored(at(0), 'm-01forged', 'human:bob', ['human:bob']);
    at(0).mailOut.publish(forged, toBob(at(1)), [at(1).fed.replica]);
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage('m-01forged')).toBeNull();
    expect(
      at(1)
        .fed.problems()
        .some(
          (p) =>
            p.subject === `mail-drop:${at(0).fed.replica}` &&
            p.message.includes('ada cannot speak for human:bob')
        )
    ).toBe(true);
    expect(kinds(at(1))).toContain('speaks-for');
  });

  it('drops a forward that names a target outside the original op, with a problem', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'for bob' },
      human('ada')
    );
    at(0).mailOut.collect();
    const original = at(0)
      .fed.outbox()
      .filter((o) => o.type === 'mail')[0];
    if (original === undefined) throw new Error('no mail op');
    await at(0).service.syncNow();
    forgeForward(at(1), original, 'human:cy', at(2));
    await at(2).settleWith(at(1));
    // A forward read before its original waits for it, then is judged.
    await at(2).service.syncNow();
    expect(at(2).messages.getMessage(message.id)).toBeNull();
    expect(
      at(2)
        .fed.problems()
        .some(
          (p) =>
            p.subject === `mail-drop:${at(1).fed.replica}` &&
            p.message ===
              `bob forwarded ${message.id} to human:cy, which is not one of its targets`
        )
    ).toBe(true);
    expect(kinds(at(2))).toContain('speaks-for');
  });

  it('records a remote message the engine refuses as a problem and an audit row', async () => {
    open = await foundedTeam('ada', 'bob');
    const bad = authored(at(0), 'm-01refused', 'human:ada', ['human:bob'], {
      data: { type: 'x-policy' },
    });
    at(0).mailOut.publish(bad, toBob(at(1)), [at(1).fed.replica]);
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage('m-01refused')).toBeNull();
    expect(
      at(1)
        .fed.problems()
        .some(
          (p) =>
            p.subject === `mail-drop:${at(0).fed.replica}` &&
            p.message.includes('m-01refused')
        )
    ).toBe(true);
    expect(kinds(at(1))).toContain('refused-message');
    expect(at(1).stateCalls.refused).toContainEqual([
      'm-01refused',
      expect.stringMatching(/^forbidden: /),
      at(0).fed.replica,
    ]);
  });

  // FW-R31(1): a payload's clock is bound to its op's.
  it("holds a message whose clock is far from its op's, like a far-future op", async () => {
    open = await foundedTeam('ada', 'bob');
    const skewed = authored(at(0), 'm-01skewed', 'human:ada', ['human:bob'], {
      hlc: `${String(at(0).clock.now.getTime() + 24 * 60 * 60 * 1000)}.0001.${at(0).fed.replica}`,
    });
    at(0).mailOut.publish(skewed, toBob(at(1)), [at(1).fed.replica]);
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage('m-01skewed')).toBeNull();
    expect(
      at(1)
        .fed.problems()
        .some(
          (p) => p.subject.startsWith('op:') && p.message.includes('ahead of')
        )
    ).toBe(true);
    const parked = at(1)
      .fed.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_parked')
      .get()?.n;
    expect(parked).toBe(1);
  });

  it('holds a publisher over the hourly quota until the hour turns, while its board ops keep applying', async () => {
    open = await foundedTeamWith(
      { remoteMailPerReplicaPerHour: 2 },
      'ada',
      'bob'
    );
    for (let i = 0; i < 3; i++)
      await at(0).engine.send(
        { to: ['human:bob'], kind: 'message', body: `n${i}` },
        human('ada')
      );
    const task = at(0).store.create({ title: 'board op after mail' }).meta.id;
    await at(1).settleWith(at(0));
    expect(at(1).messages.recentThreads(10)).toHaveLength(2);
    expect(at(1).store.get(task)?.meta.title).toBe('board op after mail');
    expect(
      at(1)
        .fed.problems()
        .some((p) => p.subject === `quota:${at(0).fed.replica}`)
    ).toBe(true);
    at(1).clock.now = new Date(at(1).clock.now.getTime() + 60 * 60 * 1000);
    await at(1).service.syncNow();
    expect(at(1).messages.recentThreads(10)).toHaveLength(3);
  });

  it("leaves a publisher's mail unread while too much of it is queued", async () => {
    open = await foundedTeamWith({ maxWaitingPerPublisher: 1 }, 'ada', 'bob');
    for (const body of ['one', 'two'])
      await at(0).engine.send(
        { to: ['human:bob'], kind: 'message', body },
        human('ada')
      );
    await at(1).settleWith(at(0));
    expect(at(1).messages.recentThreads(10)).toHaveLength(1);
    await at(1).service.syncNow();
    expect(at(1).messages.recentThreads(10)).toHaveLength(2);
  });

  it('retries a store error three times, then drops the op with a problem; the board never waits', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).failReceives(4);
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'unlucky' },
      human('ada')
    );
    const task = at(0).store.create({ title: 'still flows' }).meta.id;
    for (let i = 0; i < 3; i++) await at(1).settleWith(at(0));
    expect(at(1).store.get(task)?.meta.title).toBe('still flows');
    expect(at(1).messages.getMessage(message.id)).toBeNull();
    expect(
      at(1)
        .fed.problems()
        .some(
          (p) =>
            p.subject.startsWith('mail-drop:') &&
            p.message.includes('dropped after 3 attempts')
        )
    ).toBe(true);
  });

  it('parks mail from a run whose presence has not arrived, with no time limit', async () => {
    open = await foundedTeam('ada', 'bob');
    const run = 'r-0000000000aa';
    const early = authored(at(0), 'm-02early', `run:${run}`, ['human:bob']);
    at(0).mailOut.publish(early, toBob(at(1)), [at(1).fed.replica]);
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage('m-02early')).toBeNull();
    const later = new Date(at(1).clock.now.getTime() + 8 * 24 * 60 * 60 * 1000);
    at(1).clock.now = later;
    at(0).clock.now = later;
    at(0).startRun({ id: run, taskId: null, kind: 'review' });
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage('m-02early')?.body).toBe('m-02early');
  });

  it('skips mail not sealed to this replica, and never counts it', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'for bob' },
      human('ada')
    );
    await at(2).settleWith(at(0));
    expect(at(2).messages.recentThreads(10)).toEqual([]);
    expect(at(2).inbound.waiting(at(0).fed.replica)).toBe(0);
    expect(at(2).fed.problems()).toEqual([]);
  });

  // FW-R31(5): a parked row goes with its publisher's revocation only once
  // that revocation is settled, not while it is contested.
  async function parkedFromRevoked(fightBack: boolean) {
    open = await foundedTeamWith({ admins: ['cy', 'bob'] }, 'ada', 'cy', 'bob');
    const [ada, cy, bob] = [at(0), at(1), at(2)];
    const early = authored(bob, 'm-03parked', 'run:r-0000000000ab', [
      'human:ada',
    ]);
    bob.mailOut.publish(
      early,
      [{ recipient: 'human:ada', via: 'direct', homes: [ada.fed.replica] }],
      [ada.fed.replica]
    );
    await ada.settleWith(bob);
    const parked = () =>
      ada.fed.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_parked')
        .get()?.n;
    expect(parked()).toBe(1);
    // Cy has not read bob's mail op, so its cut lands below it.
    cy.roster.revoke(bob.fed.replica, 'left');
    if (fightBack) {
      bob.roster.revoke(cy.fed.replica, 'no, you');
      await ada.settleWith(bob);
    }
    await ada.settleWith(cy);
    await ada.service.syncNow();
    expect(ada.roster.view()?.revoked.has(bob.fed.replica)).toBe(true);
    return parked();
  }

  it('drops parked mail above an uncontested revocation of its publisher', async () => {
    expect(await parkedFromRevoked(false)).toBe(0);
  });

  it('keeps parked mail while its publisher contests the revocation', async () => {
    expect(await parkedFromRevoked(true)).toBe(1);
  });
});
