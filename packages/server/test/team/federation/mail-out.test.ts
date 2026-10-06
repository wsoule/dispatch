import { fingerprint, openPayload } from '@dispatch-foo/protocol/federation';
import type {
  FederatedOp,
  MailPayload,
} from '@dispatch-foo/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryRemote } from './helpers/memoryTransport.js';
import {
  foundedTeam,
  foundedTeamWith,
  messagingReplica,
} from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';
import { MemoryV1 } from './helpers/serviceReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const mailOps = (r: MessagingReplica) =>
  r.fed.outbox().filter((o) => o.type === 'mail');
const opened = (op: FederatedOp | undefined, r: MessagingReplica) =>
  op === undefined
    ? null
    : (openPayload(
        op,
        r.fed.replica,
        r.fed.keys.sealPriv
      ) as MailPayload | null);
const human = (h: string) => ({ address: `human:${h}`, canDecide: true });

describe('observers only on mail that leaves (spec "Observers")', () => {
  it('adds an admitted observer to a DM that crosses machines, and it can open it', async () => {
    open = await foundedTeamWith({ observers: ['ops'] }, 'ada', 'bob', 'ops');
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'crosses machines' },
      human('ada')
    );
    at(0).mailOut.collect();
    const [op] = mailOps(at(0));
    expect(op?.to).toEqual([at(1).fed.replica, at(2).fed.replica].sort());
    expect(opened(op, at(2))).not.toBeNull();
  });

  it('publishes nothing, observer included, when every participant lives on one replica', async () => {
    open = await foundedTeamWith({ observers: ['ops'] }, 'ada', 'bob', 'ops');
    await at(0).engine.send(
      { to: ['human:ada'], kind: 'message', body: 'stays on this machine' },
      { address: 'agent:dispatch', canDecide: true }
    );
    at(0).mailOut.collect();
    expect(mailOps(at(0))).toEqual([]);
  });

  it('sends an observer no DM addressed to its own handle: it is home to nobody', async () => {
    open = await foundedTeamWith({ observers: ['ops'] }, 'ada', 'bob', 'ops');
    await at(0).engine.send(
      { to: ['human:ops'], kind: 'message', body: 'to the observer' },
      human('ada')
    );
    at(0).mailOut.collect();
    expect(mailOps(at(0))).toEqual([]);
  });
});

describe('mail out', () => {
  it("seals a DM to the recipient's replicas only, with the origin's resolution of its targets", async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'lunch?' },
      human('ada')
    );
    at(0).mailOut.collect();
    const [op] = mailOps(at(0));
    expect(op?.to).toEqual([at(1).fed.replica]);
    const payload = opened(op, at(1));
    expect(payload?.message).toMatchObject({ id: message.id, body: 'lunch?' });
    expect(payload !== null && 'origin' in payload.message).toBe(false);
    expect(payload?.targets).toEqual([
      { recipient: 'human:bob', via: 'direct', homes: [at(1).fed.replica] },
    ]);
    expect(opened(op, at(2))).toBeNull();
  });

  it('publishes nothing when every participant lives on this replica, and moves the watermark', async () => {
    open = await foundedTeam('ada', 'bob');
    await at(0).engine.send(
      { to: ['human:ada'], kind: 'message', body: 'note to self' },
      { address: 'agent:dispatch', canDecide: true }
    );
    at(0).mailOut.collect();
    expect(mailOps(at(0))).toEqual([]);
    expect(Number(at(0).fed.meta('mail_rowid'))).toBe(
      at(0).messages.maxRowid()
    );
  });

  it("copies a human sender's message to their other devices", async () => {
    open = await foundedTeam('ada', 'bob', 'ada');
    await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'from my laptop' },
      human('ada')
    );
    at(0).mailOut.collect();
    expect(mailOps(at(0))[0]?.to).toEqual(
      [at(2).fed.replica, at(1).fed.replica].sort()
    );
  });

  it('starts the watermark when this machine joins, so history before never leaves', async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const ada2 = messagingReplica('ada', remote, v1);
    const ada = messagingReplica('ada', remote, v1);
    open.push(ada2, ada);
    // Without the watermark this would reach ada's other device, a home of
    // the human sender, the moment this machine joins.
    await ada.engine.send(
      { to: ['human:bob'], kind: 'message', body: 'before the team existed' },
      human('ada')
    );
    ada2.roster.found('acme');
    await ada.settleWith(ada2);
    await ada2.settleWith(ada);
    ada2.roster.admit(ada.fed.replica, {
      fingerprint: fingerprint(ada.fed.keys.signPub, ada.fed.keys.sealPub),
    });
    for (let i = 0; i < 2; i++) {
      await ada.settleWith(ada2);
      await ada2.settleWith(ada);
    }
    expect(ada.roster.mailReady()).toBe(true);
    expect(ada.homes.of('human:ada')).toHaveLength(2);
    expect(
      (remote.logs.get(ada.fed.replica) ?? []).filter((e) => e.type === 'mail')
    ).toEqual([]);
    // Mail written after joining does leave.
    await ada.engine.send(
      { to: ['human:bob'], kind: 'message', body: 'after joining' },
      human('ada')
    );
    await ada.service.syncNow();
    expect(
      (remote.logs.get(ada.fed.replica) ?? []).filter((e) => e.type === 'mail')
    ).toHaveLength(1);
  });

  it('re-publishes the same message id after a crash between the op and the watermark', async () => {
    open = await foundedTeam('ada', 'bob');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'twice' },
      human('ada')
    );
    at(0).mailOut.collect();
    at(0).fed.setMeta(
      'mail_rowid',
      String(Number(at(0).fed.meta('mail_rowid')) - 1)
    );
    at(0).mailOut.collect();
    const ids = mailOps(at(0)).map((o) => opened(o, at(1))?.message.id);
    expect(ids).toEqual([message.id, message.id]);
  });

  it('seals nothing to a replica whose key the roster has not decided (FW-R31(2))', async () => {
    open = await foundedTeam('ada', 'bob');
    const { message } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'message', body: 'undecided' },
      human('ada')
    );
    at(0)
      .fed.db.query('DELETE FROM fed_keys WHERE replica = ?')
      .run(at(1).fed.replica);
    at(0).mailOut.collect();
    expect(mailOps(at(0))).toEqual([]);
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.message.includes(message.id))
    ).toBe(true);
  });

  it('forwards an original op with its content key re-wrapped, naming only one of its targets', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const id = at(0).store.create({ title: 't', assignee: 'human:bob' }).meta
      .id;
    await at(1).settleWith(at(0));
    await at(0).settleWith(at(1));
    await at(0).engine.send(
      { to: [`task:${id}`], kind: 'message', body: 'held for the task' },
      human('ada')
    );
    at(0).mailOut.collect();
    const original = mailOps(at(0))[0];
    expect(original?.to).toEqual([at(1).fed.replica]);
    if (original === undefined) return;
    const forward = at(1).mailOut.forward(
      original,
      `task:${id}`,
      at(2).fed.replica
    );
    expect(forward?.to).toEqual([at(2).fed.replica]);
    const body = forward?.body as { forward?: FederatedOp } | undefined;
    expect(body?.forward?.sig).toBe(original.sig);
    expect(
      at(1).mailOut.forward(original, 'human:someone-else', at(2).fed.replica)
    ).toBeNull();
    // Cy cannot open the original op itself.
    expect(opened(original, at(2))).toBeNull();
  });
});
