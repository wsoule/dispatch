import { afterEach, describe, expect, it } from 'bun:test';

import { licenseFor, testKeys } from '../licenseKeys.js';
import { foundedTeamWith } from './helpers/messagingReplica.js';
import type {
  MessagingReplica,
  RecordingDocsPort,
} from './helpers/messagingReplica.js';

// T20: doc ops routed to the docs module's DocsPort (the docs plan binds it;
// cross-plan edit XD1). A recording port stands in for the docs side here.
let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const docs = (r: MessagingReplica): RecordingDocsPort => {
  if (r.docs === undefined) throw new Error('no docs on this replica');
  return r.docs.port;
};
const sync = (r: MessagingReplica) => {
  if (r.docs === undefined) throw new Error('no docs on this replica');
  return r.docs.sync;
};
const parked = (r: MessagingReplica) =>
  r.fed.db
    .query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM fed_parked WHERE op_json LIKE \'%"type":"doc"%\''
    )
    .get()?.n;

describe('doc ops (the routing the docs plan binds to)', () => {
  it("reach the docs port in clock order, speaking for the publisher's own human only", async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    sync(at(1)).publish({ doc: 'd-1', kind: 'put', n: 1 });
    sync(at(1)).publish({ doc: 'd-1', kind: 'put', n: 2 });
    await at(0).settleWith(at(1));
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1, 2]);
    expect(
      docs(at(0)).seen.every(
        (s) => s.replica === at(1).fed.replica && s.forBob && !s.forAda
      )
    ).toBe(true);
    // Outside a pass too, for the docs module's own checks (XD1e).
    expect(sync(at(0)).speaksFor(at(1).fed.replica, 'human:bob')).toBe(true);
    expect(sync(at(0)).speaksFor(at(1).fed.replica, 'human:ada')).toBe(false);
  });

  it('keeps a parked doc op in fed_parked and offers it again next pass', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    docs(at(0)).answer = 'parked';
    sync(at(1)).publish({ doc: 'd-2', kind: 'put', n: 1 });
    await at(0).settleWith(at(1));
    expect(parked(at(0))).toBe(1);
    docs(at(0)).answer = 'applied';
    await at(0).service.syncNow();
    expect(docs(at(0)).seen).toHaveLength(2);
    expect(parked(at(0))).toBe(0);
  });

  it('re-delivers the ops a docs fold asks for again', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const op = sync(at(1)).publish({ doc: 'd-3', kind: 'put', n: 1 });
    sync(at(1)).publish({ doc: 'd-3', kind: 'put', n: 2 });
    await at(0).settleWith(at(1));
    sync(at(0)).rereadOps(at(1).fed.replica, [op.seq]);
    await at(0).service.syncNow();
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1, 2, 1]);
    // Once only.
    await at(0).service.syncNow();
    expect(docs(at(0)).seen).toHaveLength(3);
  });

  it('never re-delivers an op that is not a doc op of that publisher', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    sync(at(1)).publish({ doc: 'd-7', kind: 'put', n: 1 });
    await at(0).settleWith(at(1));
    // Bob's key op is seq 1.
    sync(at(0)).rereadOps(at(1).fed.replica, [1]);
    await at(0).service.syncNow();
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1]);
  });

  it('publishes what the docs port has pending each pass, then tells it (XD1b)', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    docs(at(1)).pending = [
      { doc: 'd-5', kind: 'put', n: 1 },
      { doc: 'd-5', kind: 'put', n: 2 },
    ];
    await at(0).settleWith(at(1));
    expect(docs(at(1)).publishedBatches).toEqual([[1, 2]]);
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1, 2]);
    await at(1).service.syncNow();
    expect(docs(at(1)).publishedBatches).toHaveLength(1);
  });

  it('tells the docs port when a complete pass ends (XD1d)', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const before = docs(at(0)).passes;
    await at(0).service.syncNow();
    expect(docs(at(0)).passes).toBe(before + 1);
  });

  it('tells the docs port when retention drops a parked doc op for overflow (XD1c)', async () => {
    open = await foundedTeamWith(
      { docs: true, maxParkedPerPublisher: 1 },
      'ada',
      'bob'
    );
    docs(at(0)).answer = 'parked';
    const first = sync(at(1)).publish({ doc: 'd-8', kind: 'put', n: 1 });
    sync(at(1)).publish({ doc: 'd-8', kind: 'put', n: 2 });
    await at(0).settleWith(at(1));
    expect(docs(at(0)).dropped).toEqual([
      { replica: at(1).fed.replica, seq: first.seq, reason: 'overflow', n: 1 },
    ]);
  });

  it('tells the docs port when a revocation below a parked doc op drops it (XD1c)', async () => {
    open = await foundedTeamWith(
      { docs: true, admins: ['cy'] },
      'ada',
      'bob',
      'cy'
    );
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    docs(ada).answer = 'parked';
    const op = sync(bob).publish({ doc: 'd-6', kind: 'put', n: 1 });
    await ada.settleWith(bob);
    expect(parked(ada)).toBe(1);
    // Cy never read bob's doc op, so the cut is below it.
    cy.roster.revoke(bob.fed.replica, 'left the team');
    await ada.settleWith(cy);
    await ada.service.syncNow();
    expect(docs(ada).dropped).toEqual([
      { replica: bob.fed.replica, seq: op.seq, reason: 'revoked', n: 1 },
    ]);
    expect(parked(ada)).toBe(0);
  });

  it('keeps a parked doc op while its publisher contests the revocation', async () => {
    open = await foundedTeamWith(
      { docs: true, admins: ['cy', 'bob'] },
      'ada',
      'cy',
      'bob'
    );
    // Cy and bob revoke each other: bob reads as revoked while the fight is open.
    const [ada, cy, bob] = [at(0), at(1), at(2)];
    docs(ada).answer = 'parked';
    sync(bob).publish({ doc: 'd-9', kind: 'put', n: 1 });
    await ada.settleWith(bob);
    cy.roster.revoke(bob.fed.replica, 'left');
    bob.roster.revoke(cy.fed.replica, 'no, you');
    await ada.settleWith(bob);
    await ada.settleWith(cy);
    await ada.service.syncNow();
    expect(ada.roster.view()?.revoked.has(bob.fed.replica)).toBe(true);
    expect(docs(ada).dropped).toEqual([]);
    expect(parked(ada)).toBe(1);
  });

  it("holds a paused replica's doc ops like any other op", async () => {
    const lk = testKeys();
    const license = {
      key: licenseFor(lk.privateKey, {
        seats: 4,
        expiresAt: '2026-09-28T00:00:00.000Z',
      }),
      publicKey: lk.publicKey,
    };
    open = await foundedTeamWith(
      { docs: true, license },
      'ada',
      'bob',
      'cy',
      'dee'
    );
    const [ada, dee] = [at(0), at(3)];
    for (const r of open) r.clock.now = new Date('2026-09-29T10:00:00.000Z');
    sync(dee).publish({ doc: 'd-4', kind: 'put', n: 1 });
    await ada.settleWith(dee);
    expect(docs(ada).seen).toEqual([]);
  });
});
