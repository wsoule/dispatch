import {
  buildOp,
  fingerprint,
  MAX_CLOCK_LEAD_MS,
  opHash,
  sealPayload,
  stubOf,
} from '@dispatch-foo/protocol/federation';
import type { FederatedOp } from '@dispatch-foo/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import { CLOCK_GUARD_MS } from '../../../src/team/federation/service.js';
import { licenseFor, testKeys } from '../licenseKeys.js';
import { MemoryRemote } from './helpers/memoryTransport.js';
import {
  auditKinds,
  MemoryV1,
  serviceReplica,
  settle,
} from './helpers/serviceReplica.js';
import type { ServiceReplica } from './helpers/serviceReplica.js';

const open: ServiceReplica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});
function team(...handles: string[]) {
  const remote = new MemoryRemote();
  const v1 = new MemoryV1();
  const rs = handles.map((h) => serviceReplica(h, remote, v1));
  open.push(...rs);
  return { remote, v1, rs };
}
const fp = (r: ServiceReplica) =>
  fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);
const title = (r: ServiceReplica, id: string) => r.store.get(id)?.meta.title;

describe('FederationService', () => {
  it('before founding runs the v1 pass and touches no v2 transport', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    const id = ada.store.create({ title: 'plain v1' }).meta.id;
    await settle(ada, bob);
    expect(title(bob, id)).toBe('plain v1');
    expect(remote.logs.size).toBe(0);
  });

  // M7: a held v1 change is named under its replica, never over a problem
  // the task already has, and the note goes once the change applies.
  it('holds a v1 change from far ahead under its replica, then clears it', async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    bob.clock.now = new Date(bob.clock.now.getTime() + 60 * 60 * 1000);
    const id = bob.store.create({ title: 'from ahead' }).meta.id;
    ada.ledger.recordProblem(id, 'two tasks share this id', 'then');
    await settle(bob, ada);
    const subject = `replica:${bob.ledger.replica}`;
    expect(title(ada, id)).toBeUndefined();
    expect(ada.ledger.problems().map((p) => [p.task, p.message])).toEqual(
      expect.arrayContaining([
        [id, 'two tasks share this id'],
        [subject, expect.stringContaining('ahead of this machine')],
      ])
    );
    ada.clock.now = bob.clock.now;
    await settle(ada);
    expect(title(ada, id)).toBe('from ahead');
    expect(ada.ledger.problems().map((p) => p.task)).toEqual([id]);
  });

  it('founds, admits by fingerprint and converges the board over signed task ops', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const id = bob.store.create({ title: 'from bob, signed' }).meta.id;
    await settle(ada, bob);
    expect(title(ada, id)).toBe('from bob, signed');
    expect(
      (remote.logs.get(bob.fed.replica) ?? []).map((e) => e.type)
    ).toContain('task');
  });

  it("holds a pending replica's ops with its cursor unmoved, then applies them on admission", async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    const id = bob.store.create({ title: 'waiting' }).meta.id;
    await settle(ada, bob);
    expect(title(ada, id)).toBeUndefined();
    expect(ada.fed.cursor(bob.fed.replica).head).toBeNull();
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    expect(title(ada, id)).toBe('waiting');
  });

  it('halts a forged log with a problem and keeps applying everyone else', async () => {
    const {
      remote,
      rs: [ada, bob, cy],
    } = team('ada', 'bob', 'cy');
    ada.roster.found('acme');
    await settle(ada, bob, cy);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    await settle(ada, bob, cy);
    const forged = bob.store.create({ title: 'honest' }).meta.id;
    await bob.service.syncNow();
    const seq = bob.fed.head()?.seq ?? 0;
    remote.tamper(
      bob.fed.replica,
      seq,
      (e) =>
        ({
          ...e,
          body: { task: forged, kind: 'put', fields: { title: 'forged' } },
        }) as typeof e
    );
    const fromCy = cy.store.create({ title: 'from cy' }).meta.id;
    await settle(ada, cy);
    expect(title(ada, forged)).toBeUndefined();
    expect(title(ada, fromCy)).toBe('from cy');
    expect(
      ada.fed
        .problems()
        .some((p) =>
          p.message.includes(
            `${bob.fed.replica}'s log fails verification at seq ${seq}`
          )
        )
    ).toBe(true);
    expect(auditKinds(ada)).toContain('bad-signature');
  });

  // A verification problem clears once the log reads again, and a replica
  // that keeps failing writes one audit row per window, not one per op.
  it('clears a verification problem when the cursor moves, and rate-limits its audit rows', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const forgeNext = async (name: string) => {
      const id = bob.store.create({ title: name }).meta.id;
      await bob.service.syncNow();
      const seq = bob.fed.head()?.seq ?? 0;
      const log = remote.logs.get(bob.fed.replica) ?? [];
      const honest = log.find((e) => e.seq === seq) as FederatedOp;
      remote.tamper(
        bob.fed.replica,
        seq,
        (e) =>
          ({
            ...e,
            body: { task: id, kind: 'put', fields: { title: 'x' } },
          }) as typeof e
      );
      await ada.service.syncNow();
      return { id, honest };
    };
    const verifyProblem = () =>
      ada.fed.problems().some((p) => p.message.includes('fails verification'));
    const first = await forgeNext('one');
    expect(verifyProblem()).toBe(true);
    // The owner's republish puts the honest op back on the branch.
    remote.logs.get(bob.fed.replica)?.push(first.honest);
    await ada.service.syncNow();
    expect(title(ada, first.id)).toBe('one');
    expect(verifyProblem()).toBe(false);
    await forgeNext('two');
    expect(verifyProblem()).toBe(true);
    expect(auditKinds(ada).filter((k) => k === 'bad-signature')).toHaveLength(
      1
    );
  });

  // fed_seen_ops keeps a window of seqs behind each head, plus a live cut's.
  it('prunes seen-op hashes to a window behind the head', async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const ada = serviceReplica('ada', remote, v1, { seenOpsKept: 2 });
    const bob = serviceReplica('bob', remote, v1);
    open.push(ada, bob);
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    for (const n of [1, 2, 3, 4, 5]) bob.store.create({ title: `t${n}` });
    await settle(bob, ada);
    const head = ada.fed.cursor(bob.fed.replica).head?.seq ?? 0;
    const seqs = ada.fed.db
      .query<{ seq: number }, [string]>(
        'SELECT seq FROM fed_seen_ops WHERE replica = ? ORDER BY seq'
      )
      .all(bob.fed.replica)
      .map((r) => r.seq);
    expect(seqs).toEqual([head - 2, head - 1, head]);
  });

  // A late revocation naming a seq whose hash was pruned here cannot be
  // checked against this machine's history; it says so.
  it('names a cut it cannot check because the hash at afterSeq was pruned', async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const ada = serviceReplica('ada', remote, v1, { seenOpsKept: 2 });
    const bob = serviceReplica('bob', remote, v1);
    const cy = serviceReplica('cy', remote, v1);
    open.push(ada, bob, cy);
    ada.roster.found('acme');
    await settle(ada, bob, cy);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    ada.roster.setRole(cy.fed.replica, 'admin');
    await settle(ada, bob, cy);
    bob.store.create({ title: 'seen by cy' });
    await settle(bob, ada, cy);
    for (const n of [1, 2, 3, 4, 5]) bob.store.create({ title: `t${n}` });
    await settle(bob, ada);
    cy.roster.revoke(bob.fed.replica, 'late');
    await settle(cy, ada);
    expect(
      ada.fed
        .problems()
        .some(
          (p) =>
            p.subject === `team:cut:${bob.fed.replica}` &&
            p.message.includes('cannot be checked')
        )
    ).toBe(true);
  });

  // E: each source of a replica's problem has its own subject, so a clock
  // note never masks a security halt, nor the other way round.
  it('keeps a halt and a clock problem for one replica side by side', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    bob.clock.now = new Date(bob.clock.now.getTime() + 2 * 60 * 60 * 1000);
    bob.store.create({ title: 'from ahead' });
    await bob.service.syncNow();
    await ada.service.syncNow();
    const forged = bob.store.create({ title: 'honest' }).meta.id;
    await bob.service.syncNow();
    const seq = bob.fed.head()?.seq ?? 0;
    remote.tamper(
      bob.fed.replica,
      seq,
      (e) =>
        ({
          ...e,
          body: { task: forged, kind: 'put', fields: { title: 'forged' } },
        }) as typeof e
    );
    await ada.service.syncNow();
    const subjects = ada.fed.problems().map((p) => p.subject);
    expect(subjects).toContain(`clock:${bob.fed.replica}`);
    expect(subjects).toContain(`halt:${bob.fed.replica}`);
  });

  // FW-R23: a reader follows the prev chain, so a junk line with a high seq
  // and a duplicate of a real op neither halt a log nor hide later ops.
  it('follows the chain past a junk high seq and a duplicate', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const first = bob.store.create({ title: 'before the junk' }).meta.id;
    await bob.service.syncNow();
    const log = remote.logs.get(bob.fed.replica) ?? [];
    const last = log.at(-1) as FederatedOp;
    remote.logs.set(bob.fed.replica, [
      ...log,
      last,
      { ...last, seq: 999, sig: 'junk' },
    ]);
    const later = bob.store.create({ title: 'after the junk' }).meta.id;
    await settle(bob, ada);
    expect(title(ada, first)).toBe('before the junk');
    expect(title(ada, later)).toBe('after the junk');
    expect(ada.fed.cursor(bob.fed.replica).halted).toBeNull();
  });

  // S1: a stub shares its op's hash, so a stub placed after the op must not
  // stand in for it; the reader keeps every line and prefers the full one.
  it('reads the full op when a forged stub of it follows on the branch', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const first = bob.store.create({ title: 'the full op' }).meta.id;
    await bob.service.syncNow();
    const log = remote.logs.get(bob.fed.replica) ?? [];
    const last = log.at(-1) as FederatedOp;
    remote.logs.set(bob.fed.replica, [...log, stubOf(last)]);
    const later = bob.store.create({ title: 'after the stub' }).meta.id;
    await settle(bob, ada);
    expect(title(ada, first)).toBe('the full op');
    expect(title(ada, later)).toBe('after the stub');
    expect(ada.fed.cursor(bob.fed.replica).halted).toBeNull();
  });

  // B1: a cut names one history, checked against what this machine read
  // even after its cursor has moved past the cut.
  it("halts a log whose history differs from a revocation's afterHash after the cursor passed it", async () => {
    const {
      rs: [ada, bob, cy],
    } = team('ada', 'bob', 'cy');
    ada.roster.found('acme');
    await settle(ada, bob, cy);
    for (const o of [bob, cy])
      ada.roster.admit(o.fed.replica, { fingerprint: fp(o) });
    await settle(ada, bob, cy);
    bob.store.create({ title: 'one' });
    bob.store.create({ title: 'two' });
    await settle(bob, cy);
    const at = cy.fed.cursor(bob.fed.replica).head?.seq ?? 0;
    const cut = ada.fed.append({
      type: 'roster',
      body: {
        rv: 1,
        action: 'revoke',
        replica: bob.fed.replica,
        afterSeq: at - 1,
        afterHash: 'f'.repeat(64),
        reason: 'another history',
      },
    });
    ada.roster.applyVerified(cut, opHash(cut));
    await ada.service.syncNow();
    await cy.service.syncNow();
    expect(cy.fed.cursor(bob.fed.replica).halted).toContain('revocation');
  });

  // FW-R23: a validly signed different op at a seq already verified is a fork.
  it('halts on a signed rival of an op it already verified', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    bob.store.create({ title: 'one history' });
    await settle(bob, ada);
    const log = remote.logs.get(bob.fed.replica) ?? [];
    const last = log.at(-1) as FederatedOp;
    const rival = buildOp(
      {
        replica: last.replica,
        seq: last.seq,
        prev: last.prev,
        hlc: last.hlc,
        type: 'task',
        body: { task: 't-00000f0d', kind: 'put', fields: { title: 'other' } },
      },
      bob.fed.keys.signPriv
    );
    remote.logs.set(bob.fed.replica, [...log, rival]);
    await ada.service.syncNow();
    expect(ada.fed.cursor(bob.fed.replica).halted).toContain(
      'two ops share this seq'
    );
    expect(auditKinds(ada)).toContain('fork');
  });

  // B2: stop() waits for the pass in flight, so the ledger closes after it.
  it('waits for the pass in flight when stopped', async () => {
    const {
      rs: [ada],
    } = team('ada');
    let done = false;
    const pass = ada.service.syncNow().then(() => {
      done = true;
    });
    await ada.service.stop();
    expect(done).toBe(true);
    await pass;
  });

  // B4: before a key op, the record of minted v1 ops keeps nothing sent.
  it('keeps no minted v1 row the outbox has sent while there is no key op', async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.store.create({ title: 'plain v1' });
    await settle(ada, bob);
    expect(
      ada.fed.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_v1_minted')
        .get()
    ).toEqual({ n: 0 });
  });

  // B7: a branch this machine cannot read for a founding is a problem row.
  it('names a failed read of the branch for a founding as a problem', async () => {
    const {
      remote,
      rs: [ada],
    } = team('ada');
    remote.offline = true;
    await ada.service.syncNow();
    expect(
      ada.fed
        .problems()
        .some((p) => p.message.includes('the remote is unreachable'))
    ).toBe(true);
    remote.offline = false;
    await ada.service.syncNow();
    expect(
      ada.fed
        .problems()
        .some((p) => p.message.includes('the remote is unreachable'))
    ).toBe(false);
  });

  it('audits a fork as a fork and halts the log there', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    bob.store.create({ title: 'one history' });
    await bob.service.syncNow();
    const log = remote.logs.get(bob.fed.replica) ?? [];
    const last = log.at(-1) as FederatedOp;
    // A restored backup: a second, validly signed op at the same seq.
    const other = buildOp(
      {
        replica: last.replica,
        seq: last.seq,
        prev: last.prev,
        hlc: last.hlc,
        type: 'task',
        body: {
          task: 't-00000f0f',
          kind: 'put',
          fields: { title: 'other history' },
        },
      },
      bob.fed.keys.signPriv
    );
    remote.logs.set(bob.fed.replica, [...log, other]);
    await ada.service.syncNow();
    expect(ada.fed.cursor(bob.fed.replica).halted).toContain(
      'two ops share this seq'
    );
    expect(auditKinds(ada)).toContain('fork');
  });

  it('drops ops above a revocation cut', async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    ada.roster.revoke(bob.fed.replica, 'lost laptop');
    const late = bob.store.create({ title: 'after the cut' }).meta.id;
    await settle(bob, ada);
    expect(title(ada, late)).toBeUndefined();
  });

  it('has one clock rule: the guard is the clock backstop, five minutes', () => {
    expect(CLOCK_GUARD_MS).toBe(MAX_CLOCK_LEAD_MS);
    expect(CLOCK_GUARD_MS).toBe(5 * 60 * 1000);
  });

  it("halts a revoked replica's log where its op at the cut does not hash to afterHash", async () => {
    const {
      remote,
      rs: [ada, bob, cy],
    } = team('ada', 'bob', 'cy');
    ada.roster.found('acme');
    await settle(ada, bob, cy);
    for (const o of [bob, cy])
      ada.roster.admit(o.fed.replica, { fingerprint: fp(o) });
    await settle(ada, bob, cy);
    bob.store.create({ title: 'cut here' });
    await bob.service.syncNow();
    await ada.service.syncNow();
    ada.roster.revoke(bob.fed.replica, 'lost laptop');
    const cut = ada.fed.outbox().at(-1)?.body as { afterSeq: number };
    await ada.service.syncNow();
    // Before cy reads it, the op at the cut becomes another, validly signed one.
    const log = remote.logs.get(bob.fed.replica) ?? [];
    const at = log.find((e) => e.seq === cut.afterSeq) as FederatedOp;
    const other = buildOp(
      {
        replica: at.replica,
        seq: at.seq,
        prev: at.prev,
        hlc: at.hlc,
        type: 'task',
        body: { task: 't-00000f0e', kind: 'put', fields: { title: 'other' } },
      },
      bob.fed.keys.signPriv
    );
    remote.logs.set(
      bob.fed.replica,
      log.map((e) => (e.seq === cut.afterSeq ? other : e))
    );
    await cy.service.syncNow();
    expect(cy.fed.cursor(bob.fed.replica).halted).toContain('revocation');
    expect(title(cy, 't-00000f0e')).toBeUndefined();
  });

  it('holds ops more than five minutes ahead until this clock catches up, and flags an hour', async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    bob.clock.now = new Date(bob.clock.now.getTime() + 10 * 60 * 1000);
    const id = bob.store.create({ title: 'from the future' }).meta.id;
    await settle(bob, ada);
    expect(title(ada, id)).toBeUndefined();
    ada.clock.now = new Date(ada.clock.now.getTime() + 10 * 60 * 1000);
    await settle(ada);
    expect(title(ada, id)).toBe('from the future');
    bob.clock.now = new Date(bob.clock.now.getTime() + 2 * 60 * 60 * 1000);
    bob.store.create({ title: 'far future' });
    await settle(bob, ada);
    expect(
      ada.fed
        .problems()
        .some(
          (p) =>
            p.subject === `clock:${bob.fed.replica}` &&
            p.message.includes('ahead')
        )
    ).toBe(true);
    expect(auditKinds(ada)).toContain('clock-hold');
    // E: one stable message while it waits, and none once the clock catches up.
    const clockNotes = () =>
      ada.fed
        .problems()
        .filter((p) => p.subject === `clock:${bob.fed.replica}`)
        .map((p) => p.message);
    const before = clockNotes();
    ada.clock.now = new Date(ada.clock.now.getTime() + 60 * 1000);
    await settle(ada);
    expect(clockNotes()).toEqual(before);
    expect(auditKinds(ada).filter((k) => k === 'clock-hold')).toHaveLength(1);
    ada.clock.now = new Date(ada.clock.now.getTime() + 2 * 60 * 60 * 1000);
    await settle(ada);
    expect(clockNotes()).toEqual([]);
  });

  it('keeps an op of an unknown type in fed_unknown and moves on', async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    bob.fed.append({
      type: 'widget' as never,
      body: { from: 'a newer build' },
    });
    const id = bob.store.create({ title: 'after the widget' }).meta.id;
    await settle(bob, ada);
    expect(title(ada, id)).toBe('after the widget');
    expect(
      ada.fed.db.query('SELECT COUNT(*) AS n FROM fed_unknown').get()
    ).toEqual({ n: 1 });
  });

  // A2A-ruling 1: an a2a op belongs only on a link's branch; on the team
  // log it is dropped with one rolling note and an audit row, never parked.
  it('drops a2a ops on the team log with a rolling note and one audit row, never parking them', async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const linkOp = () =>
      bob.fed.append({
        type: 'a2a',
        seal: (stamp) =>
          sealPayload({
            replica: bob.fed.replica,
            seq: stamp.seq,
            type: 'a2a',
            payload: { kind: 'cancel', taskId: 't-1' },
            recipients: new Map([[ada.fed.replica, ada.fed.keys.sealPub]]),
          }),
      });
    linkOp();
    const last = linkOp();
    const id = bob.store.create({ title: 'after the link ops' }).meta.id;
    await settle(bob, ada);
    expect(title(ada, id)).toBe('after the link ops');
    const unknown = () =>
      ada.fed.db.query('SELECT COUNT(*) AS n FROM fed_unknown').get();
    expect(unknown()).toEqual({ n: 0 });
    const notes = ada.fed
      .problems()
      .filter((p) => p.subject === `link-op:${bob.fed.replica}`);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain(`seq ${last.seq}`);
    // One audit row per publisher, so a flood of them fills no table.
    expect(auditKinds(ada).filter((k) => k === 'link-op')).toHaveLength(1);
  });

  it('pauses a replica past the seats: it publishes nothing and applies nothing', async () => {
    const lk = testKeys();
    const license = licenseFor(lk.privateKey, {
      seats: 4,
      expiresAt: '2026-09-28T00:00:00.000Z',
    });
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const rs = ['ada', 'bob', 'cy', 'dee'].map((h) =>
      serviceReplica(h, remote, v1, {
        licenseKey: h === 'ada' ? license : undefined,
        licensePublicKey: lk.publicKey,
      })
    );
    open.push(...rs);
    const [ada, bob, cy, dee] = rs as [
      ServiceReplica,
      ServiceReplica,
      ServiceReplica,
      ServiceReplica,
    ];
    ada.roster.found('acme');
    await settle(ada, bob, cy, dee);
    for (const o of [bob, cy, dee])
      ada.roster.admit(o.fed.replica, { fingerprint: fp(o) });
    await settle(ada, bob, cy, dee);
    expect(dee.service.status().paused).toBeNull();
    // The shared license expires: three seats again, and dee is the fourth person.
    for (const r of rs) r.clock.now = new Date('2026-09-29T10:00:00.000Z');
    const id = dee.store.create({ title: 'past the seats' }).meta.id;
    await settle(ada, bob, cy, dee);
    expect(dee.service.status().paused).not.toBeNull();
    expect(title(ada, id)).toBeUndefined();
  });

  it('keeps the outbox and says why when the transport cannot be reached', async () => {
    const {
      remote,
      rs: [ada],
    } = team('ada');
    ada.roster.found('acme');
    remote.offline = true;
    await ada.service.syncNow();
    expect(ada.service.status().transport).toBe('git');
    expect(ada.service.status().transportHealth.lastError).toBe(
      'the remote is unreachable'
    );
    expect(remote.logs.size).toBe(0);
    remote.offline = false;
    await ada.service.syncNow();
    expect((remote.logs.get(ada.fed.replica) ?? []).length).toBeGreaterThan(0);
  });

  // E: a route's late sync failure is named until a sync goes through.
  it('clears a route sync failure once a later pass succeeds', async () => {
    const {
      remote,
      rs: [ada],
    } = team('ada');
    ada.roster.found('acme');
    remote.offline = true;
    await ada.service.syncNow();
    ada.fed.problem('team:route', 'the sync after invite failed: offline');
    await ada.service.syncNow();
    expect(ada.fed.problems().some((p) => p.subject === 'team:route')).toBe(
      true
    );
    remote.offline = false;
    await ada.service.syncNow();
    expect(ada.fed.problems().some((p) => p.subject === 'team:route')).toBe(
      false
    );
  });

  // B: a roster pause stops applying, so the status says this machine is paused.
  it('reports a roster pause as paused, naming how to lift it', async () => {
    const {
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const zap = bob.fed.append({
      type: 'roster',
      body: { rv: 9, action: 'zap' },
    });
    bob.roster.applyVerified(zap, opHash(zap));
    await settle(bob, ada);
    expect(ada.service.status().paused).toContain('dispatch team dismiss');
  });

  // FW-R25: pending counts what never reached the remote, not the outbox.
  it('counts ops written but never pushed as pending', async () => {
    const {
      remote,
      rs: [ada],
    } = team('ada');
    ada.roster.found('acme');
    await ada.service.syncNow();
    remote.rejectPush = true;
    ada.store.create({ title: 'stuck' });
    await ada.service.syncNow();
    expect(ada.service.status().pending).toBeGreaterThan(0);
    remote.rejectPush = false;
    await ada.service.syncNow();
    expect(ada.service.status().pending).toBe(0);
  });

  it("drops an observer's board ops: an observer publishes only keys, presence and acks", async () => {
    const {
      rs: [ada, ops],
    } = team('ada', 'ops');
    ada.roster.found('acme');
    await settle(ada, ops);
    ada.roster.admit(ops.fed.replica, {
      fingerprint: fp(ops),
      observer: true,
    });
    await settle(ada, ops);
    // Bypasses the observer's own refusal: a hostile observer signs a task op anyway.
    ops.fed.append({
      type: 'task',
      body: {
        task: 't-0000000b',
        kind: 'put',
        origin: '2026-09-26T10:00:00.000Z',
        fields: { title: 'from an observer' },
      },
    });
    await settle(ops, ada);
    expect(title(ada, 't-0000000b')).toBeUndefined();
    expect(
      ada.fed
        .problems()
        .some(
          (p) =>
            p.subject === `observer:${ops.fed.replica}` &&
            p.message.includes('an observer publishes only')
        )
    ).toBe(true);
    expect(auditKinds(ada)).toContain('speaks-for');
    // The note names what to do, and goes once the replica is no observer.
    const note = () =>
      ada.fed
        .problems()
        .find((p) => p.subject === `observer:${ops.fed.replica}`);
    expect(note()?.message).toContain('dispatch team keys revoke');
    expect(note()?.message).toContain(
      'have its owner join again from a fresh machine id'
    );
    ada.roster.revoke(ops.fed.replica, 'done');
    await settle(ada);
    expect(note()).toBeUndefined();
  });

  it('lists the tasks a revoked replica touched above the cut on a replica that already applied them', async () => {
    const {
      rs: [ada, bob, cy],
    } = team('ada', 'bob', 'cy');
    ada.roster.found('acme');
    await settle(ada, bob, cy);
    for (const o of [bob, cy])
      ada.roster.admit(o.fed.replica, { fingerprint: fp(o) });
    await settle(ada, bob, cy);
    const id = bob.store.create({ title: 'raced' }).meta.id;
    await bob.service.syncNow();
    await cy.service.syncNow();
    expect(title(cy, id)).toBe('raced');
    // Ada has not pulled bob's op, so her cut sits below it.
    ada.roster.revoke(bob.fed.replica, 'lost laptop');
    await ada.service.syncNow();
    await cy.service.syncNow();
    expect(title(ada, id)).toBeUndefined();
    expect(title(cy, id)).toBe('raced');
    expect(
      cy.fed
        .problems()
        .some(
          (p) =>
            p.subject === `team:race:${bob.fed.replica}` &&
            p.message.includes(id)
        )
    ).toBe(true);
    expect(
      ada.fed
        .problems()
        .some((p) => p.subject === `team:race:${bob.fed.replica}`)
    ).toBe(false);
  });

  it('runs the closing race check when a close-legacy op folds here', async () => {
    const {
      v1,
      rs: [ada, bob],
    } = team('ada', 'bob');
    const origin = '2026-09-26T09:00:00.000Z';
    v1.files.set('old-00000099', [
      {
        v: 1,
        replica: 'old-00000099',
        seq: 1,
        hlc: '1758880000001.0000.old-00000099',
        task: 't-00000c01',
        kind: 'put',
        origin,
        fields: { title: 'v1' },
      },
    ]);
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    // Ada closes the window (attesting through seq 1) but has not published yet.
    ada.roster.closeLegacy();
    // The legacy replica writes seq 2; bob applies it while the window is open in his view.
    v1.files.get('old-00000099')?.push({
      v: 1,
      replica: 'old-00000099',
      seq: 2,
      hlc: '1758880000002.0000.old-00000099',
      task: 't-00000c02',
      kind: 'put',
      origin,
      fields: { title: 'late' },
    });
    await bob.service.syncNow();
    expect(title(bob, 't-00000c02')).toBe('late');
    await ada.service.syncNow();
    await bob.service.syncNow();
    expect(
      bob.fed
        .problems()
        .some(
          (p) =>
            p.subject === 'team:race:old-00000099' &&
            p.message.includes('t-00000c02')
        )
    ).toBe(true);
    expect(title(ada, 't-00000c02')).toBeUndefined();
  });

  it('records a problem for mail addressed here that was pruned before this machine read it', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const op = ada.fed.append({
      type: 'mail',
      seal: (stamp) =>
        sealPayload({
          replica: ada.fed.replica,
          seq: stamp.seq,
          type: 'mail',
          payload: { n: 1 },
          recipients: new Map([[bob.fed.replica, bob.fed.keys.sealPub]]),
        }),
    });
    await ada.service.syncNow();
    remote.tamper(ada.fed.replica, op.seq, (e) => stubOf(e as FederatedOp));
    await bob.service.syncNow();
    expect(
      bob.fed
        .problems()
        .some(
          (p) =>
            p.message ===
            `mail from ${ada.fed.replica} seq ${op.seq} was pruned before this machine read it`
        )
    ).toBe(true);
    expect(bob.fed.cursor(ada.fed.replica).halted).toBeNull();
  });

  // S1: a mail stub verifies, so with its full op beside it the sort decides;
  // placed first, it still loses to the full op.
  it('reads the full mail op when its valid stub comes first on the branch', async () => {
    const {
      remote,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const op = ada.fed.append({
      type: 'mail',
      seal: (stamp) =>
        sealPayload({
          replica: ada.fed.replica,
          seq: stamp.seq,
          type: 'mail',
          payload: { n: 1 },
          recipients: new Map([[bob.fed.replica, bob.fed.keys.sealPub]]),
        }),
    });
    await ada.service.syncNow();
    const log = remote.logs.get(ada.fed.replica) ?? [];
    const full = log.find((e) => e.seq === op.seq) as FederatedOp;
    remote.logs.set(ada.fed.replica, [
      ...log.filter((e) => e.seq !== op.seq),
      stubOf(full),
      full,
    ]);
    await bob.service.syncNow();
    expect(
      bob.fed.problems().some((p) => p.message.includes('was pruned'))
    ).toBe(false);
    expect(bob.fed.cursor(ada.fed.replica).head?.seq).toBe(op.seq);
  });
});
