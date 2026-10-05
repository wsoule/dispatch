import { buildOp } from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGitSync } from '../../orchestrator/helpers.js';
import { licenseFor, testKeys } from '../licenseKeys.js';
import { foundedTeamWith } from './helpers/messagingReplica.js';
import type {
  MessagingReplica,
  RecordingDocsPort,
} from './helpers/messagingReplica.js';

// T20: doc ops routed to the docs module's DocsPort (the docs plan binds it;
// cross-plan edit XD1). A recording port stands in for the docs side here.
let open: MessagingReplica[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A bare repo for a team that syncs over git, as daemons do.
function bareRemote(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-docs-git-')));
  dirs.push(dir);
  const remote = join(dir, 'remote.git');
  runGitSync(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  return remote;
}
// A second op `r` signs at `seq`, put on the branch ahead of its original.
function fork(r: MessagingReplica, seq: number, n: number): void {
  const log = r.remote.logs.get(r.fed.replica) ?? [];
  const original = docOp(r, seq);
  const forked = buildOp(
    {
      replica: original.replica,
      seq,
      prev: original.prev,
      hlc: original.hlc,
      type: 'doc',
      body: { doc: 'forked', kind: 'put', n },
    },
    r.fed.keys.signPriv
  );
  log.splice(log.indexOf(original), 0, forked);
}
const docOp = (r: MessagingReplica, seq: number): FederatedOp => {
  const op = (r.remote.logs.get(r.fed.replica) ?? []).find(
    (o) => o.seq === seq
  );
  if (op === undefined) throw new Error(`no op ${seq}`);
  return op as FederatedOp;
};
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

  it('re-delivers asked-for ops over the git transport too', async () => {
    open = await foundedTeamWith(
      { docs: true, gitRemote: bareRemote() },
      'ada',
      'bob'
    );
    const op = sync(at(1)).publish({ doc: 'd-15', kind: 'put', n: 1 });
    sync(at(1)).publish({ doc: 'd-15', kind: 'put', n: 2 });
    await at(0).settleWith(at(1));
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1, 2]);
    sync(at(0)).rereadOps(at(1).fed.replica, [op.seq]);
    await at(0).service.syncNow();
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1, 2, 1]);
  }, 60_000);

  it('refuses a reread op whose body was changed under its signed header', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const op = sync(at(1)).publish({ doc: 'd-16', kind: 'put', n: 1 });
    await at(0).settleWith(at(1));
    const log = at(1).remote.logs.get(at(1).fed.replica) ?? [];
    const i = log.findIndex((o) => o.seq === op.seq);
    log[i] = {
      ...docOp(at(1), op.seq),
      body: { doc: 'd-16', kind: 'put', n: 99 },
    };
    sync(at(0)).rereadOps(at(1).fed.replica, [op.seq]);
    await at(0).service.syncNow();
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1]);
  });

  it('checks the revocation cut itself, parking while contested', async () => {
    open = await foundedTeamWith(
      { docs: true, admins: ['cy', 'bob'] },
      'ada',
      'cy',
      'bob'
    );
    const [ada, cy, bob] = [at(0), at(1), at(2)];
    const op = sync(bob).publish({ doc: 'd-17', kind: 'put', n: 1 });
    // Cy revokes bob below the doc op, which is on the branch.
    cy.roster.revoke(bob.fed.replica, 'left');
    await bob.service.syncNow();
    await ada.settleWith(cy);
    const view = ada.roster.view();
    if (view === null) throw new Error('no view');
    const ctx = {
      view,
      now: new Date(),
      evidence: { runs: new Map(), agents: new Map() },
    };
    const signed = docOp(bob, op.seq);
    expect(sync(ada).stage(signed, ctx)).toBe('dropped');
    expect(docs(ada).dropped).toEqual([
      { replica: bob.fed.replica, seq: op.seq, reason: 'revoked', n: 1 },
    ]);
    expect(docs(ada).seen).toEqual([]);
    bob.roster.revoke(cy.fed.replica, 'no, you');
    await ada.settleWith(bob);
    const fought = ada.roster.view();
    if (fought === null) throw new Error('no view');
    expect(sync(ada).stage(signed, { ...ctx, view: fought })).toBe('parked');
  });

  it('speaks only for humans', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    await at(0).settleWith(at(1));
    expect(
      sync(at(0)).speaksFor(at(1).fed.replica, 'agent:bob/claude-code')
    ).toBe(false);
  });

  it('rereads only the op whose hash was kept, never a fork of it (FW-R37(2))', async () => {
    open = await foundedTeamWith({ docs: true, seenOpsKept: 0 }, 'ada', 'bob');
    const op = sync(at(1)).publish({ doc: 'd-18', kind: 'put', n: 1 });
    for (let i = 2; i <= 4; i++)
      sync(at(1)).publish({ doc: 'd-18', kind: 'put', n: i });
    await at(0).settleWith(at(1));
    fork(at(1), op.seq, 99);
    sync(at(0)).rereadOps(at(1).fed.replica, [op.seq]);
    await at(0).service.syncNow();
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1, 2, 3, 4, 1]);
  });

  it('refuses a fork at or below a revocation cut on reread (FW-R37(2))', async () => {
    open = await foundedTeamWith(
      { docs: true, seenOpsKept: 0, admins: ['cy'] },
      'ada',
      'bob',
      'cy'
    );
    const [ada, bob, cy] = [at(0), at(1), at(2)];
    const op = sync(bob).publish({ doc: 'd-19', kind: 'put', n: 1 });
    await ada.settleWith(bob);
    await cy.settleWith(bob);
    cy.roster.revoke(bob.fed.replica, 'left');
    await ada.settleWith(cy);
    fork(bob, op.seq, 99);
    sync(ada).rereadOps(bob.fed.replica, [op.seq]);
    await ada.service.syncNow();
    expect(docs(ada).seen.map((s) => s.n)).toEqual([1, 1]);
  });

  it('refuses a reread with no kept hash for it', async () => {
    open = await foundedTeamWith({ docs: true, seenOpsKept: 0 }, 'ada', 'bob');
    const op = sync(at(1)).publish({ doc: 'd-20', kind: 'put', n: 1 });
    await at(0).settleWith(at(1));
    at(0).fed.db.query('DELETE FROM fed_reread_seen').run();
    sync(at(0)).rereadOps(at(1).fed.replica, [op.seq]);
    await at(0).service.syncNow();
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([1]);
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

  it("hands the docs port each published op's clock", async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    docs(at(1)).pending = [
      { doc: 'd-10', kind: 'put', n: 1 },
      { doc: 'd-10', kind: 'put', n: 2 },
    ];
    await at(1).service.syncNow();
    const ops = (at(1).remote.logs.get(at(1).fed.replica) ?? []).filter(
      (o) => o.type === 'doc'
    );
    expect(docs(at(1)).publishedClocks).toEqual([ops.map((o) => o.hlc)]);
  });

  it('publishes at most 200 doc ops a pass, the rest next pass', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    docs(at(1)).pending = Array.from({ length: 205 }, (_, i) => ({
      doc: 'd-11',
      kind: 'put' as const,
      n: i,
    }));
    docs(at(1)).keepUnpublished = true;
    await at(1).service.syncNow();
    expect(docs(at(1)).publishedBatches.map((b) => b.length)).toEqual([200]);
    await at(1).service.syncNow();
    expect(docs(at(1)).publishedBatches.map((b) => b.length)).toEqual([200, 5]);
  });

  it('skips a body too large to publish, with a note, and sends the rest', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    docs(at(1)).pending = [
      { doc: 'd-12', kind: 'put', n: 1, text: 'x'.repeat(1_100_000) },
      { doc: 'd-12', kind: 'put', n: 2 },
    ] as never;
    await at(0).settleWith(at(1));
    expect(docs(at(1)).publishedClocks[0]?.[0]).toBe('');
    expect(docs(at(0)).seen.map((s) => s.n)).toEqual([2]);
    expect(
      at(1)
        .fed.problems()
        .some((p) => p.subject === 'doc:d-12')
    ).toBe(true);
  });

  it('publishes no doc ops from an observer', async () => {
    open = await foundedTeamWith(
      { docs: true, observers: ['bob'] },
      'ada',
      'bob'
    );
    docs(at(1)).pending = [{ doc: 'd-13', kind: 'put', n: 1 }];
    await at(1).service.syncNow();
    expect(docs(at(1)).publishedBatches).toEqual([]);
  });

  it('counts applied doc ops in the pass status, for quiescence', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const before = at(0).service.status().applied;
    sync(at(1)).publish({ doc: 'd-14', kind: 'put', n: 1 });
    await at(0).settleWith(at(1));
    expect(at(0).service.status().applied).toBe(before + 1);
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
