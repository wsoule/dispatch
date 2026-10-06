import { afterEach, describe, expect, it } from 'bun:test';

import { closeOrphanedGates } from '../../../src/messaging/gates.js';
import { foundedTeam, sealStateForTest } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const human = (h: string) => ({ address: `human:${h}`, canDecide: true });
const asRun = (id: string) => ({ address: `run:${id}`, canDecide: false });

describe('state across daemons', () => {
  it("converges read state: bob reads, ada's remote row reads read", async () => {
    open = await foundedTeam('ada', 'bob');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'fyi' },
      human('ada')
    );
    await at(1).settleWith(at(0));
    const d = at(1).messages.deliveries({ messageId: message.id })[0];
    at(1).engine.markRead(d?.id ?? '');
    await at(0).settleWith(at(1));
    expect(
      at(0).messages.remoteDeliveries({ messageId: message.id })[0]?.state
    ).toBe('read');
  });

  it("settles a run's question at its origin and tells every home", async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    const { message: q } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'question', blocking: true, body: 'ship it?' },
      asRun('r-0000000000aa')
    );
    await at(1).settleWith(at(0));
    await at(1).engine.reply(q.id, { body: 'yes' }, human('bob'));
    await at(0).settleWith(at(1));
    expect(at(0).engine.answerOf(q.id)?.body).toBe('yes');
    await at(1).settleWith(at(0));
    expect(at(1).messages.settlement(q.id)?.settler).toBe(at(0).fed.replica);
    const answerId = at(0).engine.answerOf(q.id)?.id ?? '';
    expect(at(1).messages.settledAs(answerId)).toBe('accepted');
  });

  it('keeps the first answer the origin applies when two arrive, and supersedes the other everywhere', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    at(0).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    const { message: q } = await at(0).engine.send(
      {
        to: ['human:bob', 'human:cy'],
        kind: 'question',
        blocking: true,
        body: 'which?',
      },
      asRun('r-0000000000aa')
    );
    await at(1).settleWith(at(0));
    await at(2).settleWith(at(0));
    const bobs = await at(1).engine.reply(q.id, { body: 'A' }, human('bob'));
    const cys = await at(2).engine.reply(q.id, { body: 'B' }, human('cy'));
    await at(0).settleWith(at(1));
    await at(0).settleWith(at(2));
    for (const r of [at(1), at(2)]) await r.settleWith(at(0));
    expect(at(0).messages.settledAs(cys.message.id)).toBe('superseded');
    expect(at(0).messages.settledAs(bobs.message.id)).toBe('accepted');
    // FW-R33: on cy, whose machine never sees bob's answer, cy's stays
    // pending; the settler's notice tells cy it was already answered.
    expect(at(2).messages.settledAs(cys.message.id)).toBe('pending');
    expect(
      at(2)
        .messages.recentThreads(20)
        .some((t) =>
          t.root.body.startsWith(`${cys.message.id} was already answered`)
        )
    ).toBe(true);
  });

  it('keeps a remote question answerable after the recipient daemon restarts', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    const { message: q } = await at(0).engine.send(
      {
        to: ['human:bob'],
        kind: 'question',
        blocking: true,
        body: 'still there?',
      },
      asRun('r-0000000000aa')
    );
    await at(1).settleWith(at(0));
    closeOrphanedGates(at(1).engine, {
      isRunLive: () => false,
      taskIdOfRun: () => null,
    });
    expect(at(1).engine.answerOf(q.id)).toBeNull();
    await at(1).engine.reply(q.id, { body: 'yes' }, human('bob'));
    await at(0).settleWith(at(1));
    expect(at(0).engine.answerOf(q.id)?.body).toBe('yes');
  });

  it('refuses a settle from anyone but the settler', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    at(0).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    const { message: q } = await at(0).engine.send(
      {
        to: ['human:bob', 'human:cy'],
        kind: 'question',
        blocking: true,
        body: 'q',
      },
      asRun('r-0000000000aa')
    );
    await at(1).settleWith(at(0));
    await at(2).settleWith(at(0));
    sealStateForTest(
      at(2),
      [
        {
          t: 'settle',
          question: q.id,
          answer: 'm-01fake',
          at: '2026-09-26T10:05:00.000Z',
        },
      ],
      [at(1)]
    );
    await at(1).settleWith(at(2));
    expect(at(1).messages.settlement(q.id)).toBeNull();
    expect(
      at(1)
        .fed.problems()
        .some((p) =>
          p.message.includes("only the question's origin settles it")
        )
    ).toBe(true);
    expect(
      at(1)
        .fed.db.query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM fed_audit WHERE kind = 'speaks-for'"
        )
        .get()?.n
    ).toBe(1);
  });

  it('never believes a settle that arrives before its question from anyone but the origin', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    at(0).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    const { message: q } = await at(0).engine.send(
      {
        to: ['human:bob', 'human:cy'],
        kind: 'question',
        blocking: true,
        body: 'q',
      },
      asRun('r-0000000000aa')
    );
    await at(2).settleWith(at(0));
    // Cy's forged settle reaches bob before ada's question does.
    sealStateForTest(
      at(2),
      [
        {
          t: 'settle',
          question: q.id,
          answer: 'm-01fake',
          at: '2026-09-26T10:05:00.000Z',
        },
      ],
      [at(1)]
    );
    await at(1).settleWith(at(2));
    await at(1).settleWith(at(0));
    expect(at(1).messages.getMessage(q.id)).not.toBeNull();
    expect(at(1).messages.settlement(q.id)).toBeNull();
    expect(at(1).messages.earlySettlements(q.id)).toEqual([]);
    expect(
      at(1)
        .fed.problems()
        .some(
          (p) =>
            p.subject === `message:${q.id}` &&
            p.message.includes("only the question's origin settles it")
        )
    ).toBe(true);
  });

  it("refuses a delivery report from a replica that is not the recipient's home", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'for bob' },
      human('ada')
    );
    await at(1).settleWith(at(0));
    sealStateForTest(
      at(2),
      [
        {
          t: 'delivery',
          message: message.id,
          recipient: 'human:bob',
          state: 'read',
          at: '2026-09-26T10:05:00.000Z',
        },
      ],
      [at(0)]
    );
    await at(0).settleWith(at(2));
    expect(
      at(0).messages.remoteDeliveries({ messageId: message.id })[0]?.state
    ).not.toBe('read');
  });

  it("follows a task's live run: the origin re-publishes held task mail to the claimant", async () => {
    open = await foundedTeam('ada', 'bob');
    const id = at(0).store.create({ title: 'assigned', assignee: 'human' }).meta
      .id;
    const { message } = await at(0).engine.send(
      { to: [`task:${id}`], kind: 'message', body: 'for whoever runs it' },
      human('ada')
    );
    await at(1).settleWith(at(0));
    await at(1).startExecute(id, 'r-0000000000bb');
    await at(0).settleWith(at(1));
    await at(1).settleWith(at(0));
    expect(at(1).host.pushed.map((p) => p.messageId)).toContain(message.id);
    await at(0).settleWith(at(1));
    expect(at(0).messages.deliveries({ messageId: message.id })).toEqual([]);
    expect(
      at(0).messages.remoteDeliveries({ messageId: message.id })[0]?.state
    ).toBe('pushed');
  });

  it('asks for 10-second passes while an asker waits across machines, and stops after the wait', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'question', blocking: true, body: 'waiting' },
      asRun('r-0000000000aa')
    );
    const now = at(0).clock.now;
    const until = at(0).stateOut.fastUntil(now, 600);
    expect(until?.getTime()).toBe(now.getTime() + 600 * 1000);
    expect(
      at(0).stateOut.fastUntil(new Date(now.getTime() + 601 * 1000), 600)
    ).toBeNull();
  });
});
