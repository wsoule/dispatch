import { describe, expect, it } from 'bun:test';

import type { RosterOpRef, RosterView } from '../src/roster.js';
import {
  admit,
  demote,
  dismiss,
  junk,
  keysFor,
  op,
  pausedAt,
  promote,
  revoke,
  rosterOf,
  standingOf,
  team,
} from './rosterOps.js';

const A = 'ada-0000000a';
const B = 'bob-0000000b';
const C = 'cy-0000000c';
const D = 'dee-0000000d';
const B2 = 'bob-0000000f';
const OBS = 'obs-00000010';
const P = 'pat-00000011';
const P2 = 'pat-00000012';
const Q = 'quin-00000013';
const K = 'kit-00000014';

const t = team(A, keysFor([A, B, C, D, B2, OBS, P, P2, Q, K]));
const { fold } = t;

const NEWER =
  "a teammate's newer Dispatch changed the roster in a way this build cannot read; upgrade to continue";
const pauseProblem = (o: RosterOpRef, who: string) => ({
  subject: `op:${o.replica}:${o.seq}`,
  message: `${NEWER}, ${who} can dismiss ${o.replica}'s roster op at seq ${o.seq} (${o.hash}), or an admin can revoke ${o.replica} below seq ${o.seq}`,
});
const pauses = (v: RosterView) =>
  v.problems.some((p) => p.message.startsWith(NEWER));
const roles = (v: RosterView) =>
  Object.fromEntries([...v.members.values()].map((m) => [m.replica, m.role]));
// The op a dismiss names.
const namedBy = (d: RosterOpRef) =>
  d.body as unknown as { replica: string; seq: number };
const refused = (d: RosterOpRef) => ({
  subject: `op:${d.replica}:${d.seq}`,
  message: `${d.replica} may not dismiss ${namedBy(d).replica}'s roster op at seq ${namedBy(d).seq}; ignored`,
});
const readable = (d: RosterOpRef) => ({
  subject: `op:${d.replica}:${d.seq}`,
  message: `${d.replica} may not dismiss ${namedBy(d).replica}'s roster op at seq ${namedBy(d).seq}: every build reads it; ignored`,
});

describe('the pause', () => {
  it('pauses on an unreadable op a member or admin published, naming who can lift it', () => {
    const base = [admit(A, 2, 100, C, 'admin'), admit(A, 3, 110, D)];
    const byAdmin = junk(C, 2, 200);
    const v = fold([...base, byAdmin]);
    expect(v.unknown).toEqual(pausedAt(byAdmin));
    // The founder outranks C there, and C may dismiss its own op.
    expect(v.problems).toContainEqual(pauseProblem(byAdmin, `${A} or ${C}`));
    // A newer rv of a known action is as unreadable; any admin may dismiss a member's.
    const byMember = admit(D, 2, 200, B, 'member', { rv: 2 });
    const m = fold([...base, byMember]);
    expect(m.unknown).toEqual(pausedAt(byMember));
    expect(m.problems).toContainEqual(pauseProblem(byMember, `${A} or ${C}`));
  });

  it('never pauses on an unreadable op whose publisher holds no right there', () => {
    const base = [
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 110, D),
      admit(A, 4, 120, OBS, 'member', { observer: true }),
      admit(A, 5, 130, B),
      revoke(A, 6, 300, B, 2),
    ];
    const inert = [
      junk(P, 2, 200), // a pending replica's first roster op
      junk(P, 3, 210), // and its next
      junk(P2, 2, -5000), // a pending replica's, positioned before the founding
      junk(D, 2, -5000), // a member's, positioned before the founding
      junk(D, 2, 50), // a member's, positioned before its admission
      junk(B, 3, 400), // a revoked replica's, above its cut
      junk(B, 4, 250), // backdated before the revocation, still above the cut
      junk(OBS, 2, 200), // an observer's
    ];
    const expected = rosterOf(fold(base));
    for (const o of inert) {
      for (const level of [1, 2, 3]) {
        const v = t.at(level, [...base, o]);
        expect({
          o: o.hash,
          level,
          unknown: v.unknown,
          pauses: pauses(v),
        }).toEqual({
          o: o.hash,
          level,
          unknown: null,
          pauses: false,
        });
      }
      expect(rosterOf(fold([...base, o]))).toEqual(expected);
    }
    // A revoked replica's op at or below its cut still pauses.
    const below = junk(B, 2, 200);
    expect(fold([...base, below]).unknown).toEqual(pausedAt(below));
  });

  it('lifts the pause when its publisher is revoked below the op', () => {
    const base = [admit(A, 2, 100, C, 'admin'), admit(A, 3, 110, D)];
    const byD = junk(D, 3, 200);
    expect(fold([...base, byD]).unknown).toEqual(pausedAt(byD));
    const cut = fold([...base, byD, revoke(A, 4, 300, D, 2)]);
    expect(cut.unknown).toBeNull();
    expect(cut.revoked.has(D)).toBe(true);
    // The founder's machine is lost with an unreadable op out: a junior admin
    // revokes it below that op.
    const byA = junk(A, 4, 200);
    expect(fold([...base, byA]).unknown).toEqual(pausedAt(byA));
    const lost = fold([...base, byA, revoke(C, 2, 300, A, 3)]);
    expect(lost.unknown).toBeNull();
    expect(roles(lost)).toEqual({ [C]: 'admin', [D]: 'member' });
  });

  it('ignores a malformed op at every level: it never pauses and is never eligible', () => {
    const base = [admit(A, 2, 100, C, 'admin')];
    const malformed = [
      op(C, 2, 200, { rv: '2', action: 'teleport' }),
      op(C, 3, 210, { rv: 1.5, action: 'teleport' }),
      op(C, 4, 220, { action: 7 }),
      // Known(1) pairs with the wrong fields.
      op(C, 5, 230, { action: 'admit', replica: D }),
      op(C, 6, 240, { action: 'dismiss', replica: C, seq: 'x', hash: 'h' }),
    ];
    for (const level of [1, 2, 3]) {
      const v = t.at(level, [...base, ...malformed]);
      expect(v.unknown).toBeNull();
      expect(rosterOf(v)).toEqual(rosterOf(t.at(level, base)));
    }
    const [named] = malformed;
    const d = dismiss(A, 3, 300, named);
    const v = fold([...base, ...malformed, d]);
    expect(v.dismissed).toEqual([]);
    expect(v.problems).toContainEqual({
      subject: `op:${A}:3`,
      message: `${A} may not dismiss ${C}'s roster op at seq 2: it is malformed, so no build applies it; ignored`,
    });
  });

  it("reads only Known(1) ops as a pending replica's first roster op, so no dismissal moves it", () => {
    const first = junk(P, 2, 100);
    const recover = t.recover(P, 3, 150);
    const v = fold([first, recover]);
    expect(v.unknown).toBeNull();
    expect(v.members.get(P)).toMatchObject({ role: 'admin', recovered: true });
    const dismissed = fold([first, recover, dismiss(A, 2, 200, first)]);
    expect(dismissed.dismissed.map((d) => d.hash)).toEqual([first.hash]);
    expect(standingOf(dismissed)).toEqual(standingOf(v));
    // A Known(1) op first leaves the recover unread, and nothing can dismiss it.
    const invite = op(P, 2, 100, {
      action: 'invite',
      id: 'i-pat',
      pub: 'P',
      handle: 'pat',
      expires: '2026-10-03T00:00:00.000Z',
    });
    const w = fold([invite, recover, dismiss(A, 2, 200, invite)]);
    expect(w.members.has(P)).toBe(false);
    expect(w.problems).toContainEqual({
      subject: `op:${P}:3`,
      message: `${P}'s recover is not its first roster op; ignored`,
    });
  });

  it('never pauses the relay, which folds the same roster and keeps unreadable ops inert', () => {
    const base = [admit(A, 2, 100, C, 'admin'), admit(A, 3, 110, D)];
    const byC = junk(C, 2, 200);
    const daemon = fold([...base, byC]);
    const relay = fold([...base, byC], { relay: true });
    expect(daemon.unknown).toEqual(pausedAt(byC));
    expect(relay.unknown).toBeNull();
    expect(pauses(relay)).toBe(false);
    expect(rosterOf(relay)).toEqual(rosterOf(daemon));
    // It keeps and applies dismisses as a daemon does.
    const lifted = [...base, byC, dismiss(A, 4, 300, byC)];
    expect(rosterOf(fold(lifted, { relay: true }))).toEqual(
      rosterOf(fold(lifted))
    );
  });

  it('holds an unreadable grant inert once a revocation cuts its publisher below it, whatever fight it might arm', () => {
    const grant = promote(C, 2, 200, D, 2);
    const ops = [
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 110, D),
      grant,
      admit(A, 4, 300, B, 'admin'),
      revoke(D, 2, 410, B, 1),
    ];
    expect(fold(ops).unknown).toEqual(pausedAt(grant));
    for (const level of [1, 2, 3]) {
      const v = t.at(level, [...ops, revoke(B, 2, 400, C, 1)]);
      expect(v.unknown).toBeNull();
      expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'admin', [D]: 'member' });
      expect(v.revoked.has(C)).toBe(true);
    }
  });
});

describe('dismiss', () => {
  it('lifts the pause when an admin dismisses the op, and every level folds the same roster', () => {
    const base = [admit(A, 2, 100, C, 'admin'), admit(A, 3, 110, D)];
    const newer = op(C, 2, 200, {
      rv: 2,
      action: 'transport',
      kind: 'relay',
      url: 'https://relay.test',
    });
    const byA = dismiss(A, 4, 300, newer);
    expect(t.at(1, [...base, newer]).unknown).toEqual(pausedAt(newer));
    // A build that reads the op applies it until it is dismissed.
    expect(t.at(2, [...base, newer]).transport).toEqual({
      kind: 'relay',
      url: 'https://relay.test',
    });
    const views = [1, 2, 3].map((level) => t.at(level, [...base, newer, byA]));
    const [first] = views;
    for (const v of views) {
      expect(v.unknown).toBeNull();
      expect(v.transport).toEqual({ kind: 'git' });
      expect(rosterOf(v)).toEqual(rosterOf(first));
    }
    expect(first.dismissed).toEqual([
      { replica: C, seq: 2, hash: newer.hash, by: A },
    ]);
    expect(first.problems).toContainEqual({
      subject: `op:${A}:4`,
      message: `${A} dismissed ${C}'s roster op at seq 2, so no build applies it`,
    });
  });

  it('lets an admin dismiss its own op, the founder included', () => {
    const base = [admit(A, 2, 100, B, 'admin'), admit(A, 3, 110, D)];
    const byA = junk(A, 4, 200);
    // Nobody ranks before the founder, so only it may dismiss its own op.
    const d = dismiss(B, 2, 300, byA);
    const byB = fold([...base, byA, d]);
    expect(byB.unknown).toEqual(pausedAt(byA));
    expect(byB.problems).toContainEqual(refused(d));
    expect(byB.problems).toContainEqual(pauseProblem(byA, A));
    expect(fold([...base, byA, dismiss(A, 5, 300, byA)]).unknown).toBeNull();
    const junior = junk(B, 2, 200);
    expect(
      fold([...base, junior, dismiss(B, 3, 300, junior)]).unknown
    ).toBeNull();
  });

  it('lets any admin dismiss an op whose publisher was not an admin there', () => {
    const base = [
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 110, B, 'admin'),
      admit(A, 4, 120, D),
    ];
    const byD = junk(D, 2, 200);
    expect(fold([...base, byD, dismiss(B, 2, 300, byD)]).unknown).toBeNull();
    // Two admins may both dismiss it, and each dismissal counts.
    const both = fold([
      ...base,
      byD,
      dismiss(B, 2, 300, byD),
      dismiss(C, 2, 310, byD),
    ]);
    expect(both.dismissed.map((d) => d.by)).toEqual([B, C]);
    // C, demoted below its op, is only a member there, so its junior B may dismiss it.
    const byC = junk(C, 2, 200);
    const demoted = [...base, demote(A, 5, 150, C, 1), byC];
    expect(fold(demoted).unknown).toEqual(pausedAt(byC));
    expect(fold([...demoted, dismiss(B, 2, 300, byC)]).unknown).toBeNull();
  });

  it("refuses a dismiss by a non-admin or by an admin the op's publisher outranks there", () => {
    const base = [
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 110, B, 'admin'),
      admit(A, 4, 120, D),
      admit(A, 5, 130, OBS, 'member', { observer: true }),
      admit(A, 6, 140, B2),
      revoke(A, 7, 150, B2, 1),
      junk(C, 2, 200),
    ];
    const byC = base[6];
    const attempts = [
      dismiss(D, 2, 300, byC), // a member
      dismiss(OBS, 2, 300, byC), // an observer
      dismiss(B2, 2, 300, byC), // a revoked replica
      dismiss(P, 2, 300, byC), // a pending replica
      dismiss(B, 2, 300, byC), // an admin C outranks there
    ];
    for (const d of attempts) {
      const v = fold([...base, d]);
      expect(v.unknown).toEqual(pausedAt(byC));
      expect(v.dismissed).toEqual([]);
      expect(v.problems).toContainEqual(refused(d));
    }
  });

  it("reads the dismissing admin's rank at the dismiss and the publisher's at the named op", () => {
    const x = junk(C, 5, 30);
    const ops = [
      admit(A, 2, 10, C, 'admin'),
      admit(A, 3, 20, B, 'admin'),
      x,
      demote(A, 4, 40, C, 5),
      promote(A, 5, 50, C),
    ];
    // C's standing rank is after B's since its re-promotion, but at x it ranked first.
    const v = fold([...ops, dismiss(B, 2, 60, x)]);
    expect(v.members.get(B)?.rank).toBeLessThan(v.members.get(C)?.rank ?? 0);
    expect(v.unknown).toEqual(pausedAt(x));
    expect(v.dismissed).toEqual([]);
    expect(v.problems).toContainEqual(pauseProblem(x, `${A} or ${C}`));
  });

  it('never dismisses an op every build reads: the founding, a grant, a removal or a dismiss', () => {
    const cutB = revoke(A, 5, 150, B, 1);
    const junkC = junk(C, 2, 200);
    const promoteD = promote(C, 3, 250, D);
    const byA = dismiss(A, 6, 300, junkC);
    const base = [
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 110, B, 'admin'),
      admit(A, 4, 120, D),
      cutB,
      junkC,
      promoteD,
      byA,
    ];
    const expected = fold(base);
    expect(roles(expected)).toEqual({
      [A]: 'admin',
      [C]: 'admin',
      [D]: 'admin',
    });
    expect(expected.unknown).toBeNull();
    const attempts = [
      dismiss(A, 7, 400, t.found),
      dismiss(B, 2, 400, cutB), // by the replica it revokes
      dismiss(A, 7, 400, promoteD),
      dismiss(A, 7, 400, byA),
    ];
    for (const d of attempts) {
      for (const level of [1, 2]) {
        const v = t.at(level, [...base, d]);
        expect({ d: d.hash, roster: rosterOf(v), unknown: v.unknown }).toEqual({
          d: d.hash,
          roster: rosterOf(t.at(level, base)),
          unknown: null,
        });
        expect(v.problems).toContainEqual(readable(d));
      }
    }
  });

  it('ignores a dismiss naming an op this daemon does not hold, or the twin deduplication dropped', () => {
    const base = [admit(A, 2, 100, C, 'admin')];
    const twins = [1, 2]
      .map((n) => op(C, 2, 200, { rv: 7, action: 'x-garbage', n }))
      .sort((a, b) => (a.hash < b.hash ? -1 : 1));
    const [kept, dropped] = twins as [RosterOpRef, RosterOpRef];
    const v = fold([
      ...base,
      ...twins,
      dismiss(A, 3, 300, dropped),
      dismiss(A, 4, 310, { replica: D, seq: 9, hash: 'e'.repeat(64) }),
    ]);
    expect(v.unknown).toEqual(pausedAt(kept));
    expect(v.dismissed).toEqual([]);
    expect(rosterOf(v)).toEqual(rosterOf(fold([...base, ...twins])));
    expect(
      fold([...base, ...twins, dismiss(A, 3, 300, kept)]).unknown
    ).toBeNull();
  });

  it('ignores a stray level field, so no level can pause a build', () => {
    const base = [admit(A, 2, 100, C, 'admin'), admit(A, 3, 110, D)];
    const nowhere = { replica: 'nobody-00000000', seq: 0, hash: 'x' };
    const bad = dismiss(D, 2, 200, nowhere, { level: Number.MAX_SAFE_INTEGER });
    const v = fold([...base, bad]);
    expect(v.unknown).toBeNull();
    expect(rosterOf(v)).toEqual(rosterOf(fold(base)));
    // A pending replica's first roster op, naming the founding at a level of its own.
    const first = dismiss(P, 2, 200, t.found, { level: 424242 });
    const w = fold([...base, first]);
    expect(w.unknown).toBeNull();
    expect(w.problems).toContainEqual(readable(first));
    // An admin's dismiss carrying a level counts like any other.
    const byD = junk(D, 4, 200);
    for (const level of [0, 2, 1e9, 'x'])
      expect(
        fold([...base, byD, dismiss(C, 2, 300, byD, { level })]).unknown
      ).toBeNull();
  });

  it("never lets an invalid dismiss change the roster: rights in the base fold don't depend on what it names", () => {
    // Ops a newer or hostile build wrote at rv 2, which no level may read as rights.
    const revokeB = revoke(A, 4, 200, B, 1, 2);
    const grantD = promote(A, 3, 120, D, 2);
    const revokeByD = revoke(D, 2, 200, B, 1, 2);
    const keyChange = op(A, 3, 200, {
      rv: 2,
      action: 'recovery-key',
      pub: 'next',
    });
    const admitD = admit(C, 2, 150, D, 'member', { rv: 2 });
    const revokeC = revoke(B, 2, 100, C, 2, 2);
    const revokeB2 = revoke(K, 2, 110, B2, 3, 2);
    const strangers = junk(P, 2, 50);
    const demoteB = demote(A, 4, 300, B, 1, 2);
    const promoteAgain = promote(A, 5, 310, B, 2);
    const admitC = admit(A, 2, 100, C, 'admin', { rv: 2 });
    const counter = revoke(C, 2, 310, B, 1, 2);
    const suspend = op(D, 2, 110, {
      action: 'suspend',
      replica: B2,
      afterSeq: 1,
      afterHash: 'h',
    });
    const cases = [
      {
        // B names its own newer revocation before dismissing a member's op.
        base: [
          admit(A, 2, 100, B, 'admin'),
          admit(A, 3, 110, C),
          admitD,
          revokeB,
          dismiss(B, 3, 310, admitD),
        ],
        hostile: [dismiss(B, 2, 300, revokeB), dismiss(P, 2, 300, revokeB)],
        paused: revokeB,
      },
      {
        // A junior names the grant that armed a senior's newer removal of it.
        base: [
          admit(A, 2, 100, D),
          grantD,
          admit(A, 4, 150, B, 'admin'),
          revokeByD,
          dismiss(B, 3, 310, revokeByD),
        ],
        hostile: [dismiss(B, 2, 300, grantD)],
        paused: grantD,
      },
      {
        // A recovered admin names the newer recovery key that would have stopped it.
        base: [
          admit(A, 2, 100, C),
          admitD,
          keyChange,
          t.recover(Q, 2, 300),
          dismiss(Q, 4, 320, admitD),
        ],
        hostile: [dismiss(Q, 3, 310, keyChange)],
        paused: keyChange,
      },
      {
        // A member and a pending stranger name a senior's newer removal of a junior.
        base: [
          admit(A, 2, 10, B, 'admin'),
          admit(A, 3, 20, C, 'admin'),
          admit(A, 4, 30, D),
          admit(A, 5, 40, K, 'admin'),
          admit(A, 6, 50, B2),
          revokeC,
          revokeB2,
          dismiss(C, 2, 120, revokeB2),
        ],
        hostile: [dismiss(D, 2, 130, revokeC), dismiss(P, 2, 130, revokeC)],
        paused: revokeC,
      },
      {
        // Pending replicas name a newer demotion and re-promotion in turn.
        base: [
          admit(A, 2, 100, C, 'admin'),
          admit(A, 3, 200, B, 'admin'),
          strangers,
          demoteB,
          promoteAgain,
          dismiss(B, 2, 400, strangers),
        ],
        hostile: [
          dismiss(P2, 2, 500, promoteAgain),
          dismiss(Q, 2, 510, demoteB),
        ],
        paused: demoteB,
      },
      {
        // A stranger names the newer revocation that would leave a junior's
        // demotion of K void, and so K's dismiss valid.
        base: [
          admit(A, 2, 10, B, 'admin'),
          admit(A, 3, 20, C, 'admin'),
          admit(A, 4, 30, K, 'admin'),
          admit(A, 5, 40, D, 'admin'),
          admit(A, 6, 50, B2),
          demote(C, 2, 100, K, 2),
          revokeC,
          suspend,
          dismiss(K, 3, 120, suspend),
        ],
        hostile: [dismiss(P, 2, 130, revokeC)],
        paused: revokeC,
      },
      {
        // A pending stranger names a senior's newer admission.
        base: [
          admitC,
          admit(A, 3, 200, B, 'admin'),
          revoke(B, 2, 300, C, 1),
          counter,
          dismiss(B, 3, 400, counter),
        ],
        hostile: [dismiss(P, 2, 390, admitC)],
        paused: admitC,
      },
    ];
    for (const { base, hostile, paused } of cases) {
      const without = fold(base);
      const v = fold([...base, ...hostile]);
      expect(without.unknown).toEqual(pausedAt(paused));
      expect({ roster: rosterOf(v), unknown: v.unknown }).toEqual({
        roster: rosterOf(without),
        unknown: without.unknown,
      });
      for (const d of hostile) expect(v.problems).toContainEqual(refused(d));
    }
  });

  it('never lets a lower-ranked admin win a revocation fight by dismissing a counter-move', () => {
    const cRev = revoke(C, 2, 310, B, 1);
    const aRev = revoke(A, 3, 310, B, 1);
    const recovered = revoke(A, 2, 310, Q, 2);
    const promoteD = promote(C, 2, 200, D);
    const dRev = revoke(D, 2, 320, B, 1);
    const cases = [
      // B, admitted after C, or K, a bystander admitted after C, dismisses C's counter.
      {
        base: [
          admit(A, 2, 100, C, 'admin'),
          admit(A, 3, 200, B, 'admin'),
          admit(A, 4, 250, K, 'admin'),
          revoke(B, 2, 300, C, 1),
          cRev,
        ],
        d: [dismiss(B, 3, 400, cRev), dismiss(K, 2, 400, cRev)],
        winner: C,
        loser: B,
      },
      // B dismisses the founder's.
      {
        base: [admit(A, 2, 100, B, 'admin'), revoke(B, 2, 300, A, 2), aRev],
        d: [dismiss(B, 3, 400, aRev)],
        winner: A,
        loser: B,
      },
      // A replica holding a leaked recovery code dismisses the founder's.
      {
        base: [t.recover(Q, 2, 200), revoke(Q, 3, 300, A, 1), recovered],
        d: [dismiss(Q, 4, 400, recovered)],
        winner: A,
        loser: Q,
      },
      // B dismisses C's promotion of D, which armed D's counter-revocation.
      {
        base: [
          admit(A, 2, 100, C, 'admin'),
          admit(A, 3, 110, D),
          promoteD,
          admit(A, 4, 300, B, 'admin'),
          revoke(B, 2, 400, C, 1),
          revoke(D, 2, 410, B, 1),
        ],
        d: [dismiss(B, 3, 600, promoteD)],
        winner: D,
        loser: B,
      },
      // B's cut of C voids C's admission of D, so B's fold shows D no admin.
      {
        base: [
          admit(A, 2, 100, C, 'admin'),
          admit(A, 3, 200, B, 'admin'),
          admit(C, 2, 150, D, 'admin'),
          revoke(B, 2, 300, C, 1),
          dRev,
        ],
        d: [dismiss(B, 3, 400, dRev)],
        winner: D,
        loser: B,
      },
    ];
    for (const { base, d, winner, loser } of cases) {
      for (const level of [1, 2, 3]) {
        const expected = t.at(level, base);
        expect(roles(expected)[winner]).toBe('admin');
        expect(expected.revoked.has(loser)).toBe(true);
        const v = t.at(level, [...base, ...d]);
        expect({ level, roster: rosterOf(v) }).toEqual({
          level,
          roster: rosterOf(expected),
        });
        for (const x of d) expect(v.problems).toContainEqual(readable(x));
      }
    }
  });

  it('keeps the earlier-ranked admin the winner however many dismisses each side sends', () => {
    const counter = revoke(A, 2, 310, Q, 2);
    const base = [t.recover(Q, 2, 200), revoke(Q, 3, 300, A, 1), counter];
    const chain: RosterOpRef[] = [];
    let named = counter;
    for (let n = 0; n < 4; n++) {
      const d =
        n % 2 === 0
          ? dismiss(Q, 4 + n, 400 + n, named)
          : dismiss(A, 3 + n, 400 + n, named);
      chain.push(d);
      named = d;
      const v = fold([...base, ...chain]);
      expect({ n, roles: roles(v), revoked: [...v.revoked.keys()] }).toEqual({
        n,
        roles: { [A]: 'admin' },
        revoked: [Q],
      });
    }
  });

  it('never lets a counter-move at a later rv decide a fight, so dismissing it moves nothing', () => {
    const base = [
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 200, B, 'admin'),
      revoke(B, 2, 300, C, 1),
    ];
    // Above B's cut of C, C's later-rv counter carries no right at any level.
    const counter = revoke(C, 2, 310, B, 1, 2);
    for (const level of [1, 2, 3]) {
      const v = t.at(level, [...base, counter]);
      expect(v.unknown).toBeNull();
      expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'admin' });
      expect(v.revoked.has(C)).toBe(true);
      const dismissed = t.at(level, [
        ...base,
        counter,
        dismiss(B, 3, 400, counter),
      ]);
      expect(standingOf(dismissed)).toEqual(standingOf(v));
    }
  });

  it('never lets an unreadable recover admit its replica or decide the fight that cuts it', () => {
    const recover = t.recover(B2, 2, 200);
    const newer: RosterOpRef = {
      ...recover,
      body: { ...recover.body, rv: 2 } as unknown as RosterOpRef['body'],
    };
    const rest = [
      admit(A, 2, 100, B),
      revoke(B, 2, 300, B2, 1),
      revoke(B2, 3, 310, B, 1),
    ];
    for (const level of [1, 2, 3]) {
      const v = t.at(level, [newer, ...rest]);
      expect(v.unknown).toBeNull();
      expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'member' });
      expect([...v.revoked.keys()]).toEqual([B2]);
    }
  });

  it("leaves a member's unreadable op to an upgrade or the recovery code once every admin machine is lost", () => {
    const base = [admit(A, 2, 100, D), admit(A, 3, 110, B)];
    const byB = junk(B, 2, 200);
    // A member may neither dismiss it nor revoke another handle's machine.
    const stuck = fold([
      ...base,
      byB,
      dismiss(D, 2, 300, byB),
      revoke(D, 3, 310, B, 1),
    ]);
    expect(stuck.unknown).toEqual(pausedAt(byB));
    expect(stuck.revoked.has(B)).toBe(false);
    expect(stuck.problems).toContainEqual(pauseProblem(byB, A));
    // The recovery code admits an admin, which may dismiss a member's op.
    const rec = t.recover(Q, 2, 400);
    expect(
      fold([...base, byB, rec, dismiss(Q, 3, 410, byB)]).unknown
    ).toBeNull();
    // It ranks last, so it lifts the lost founder's own op by revoking the founder below it.
    const byA = junk(A, 4, 200);
    const founders = [...base, byA, rec];
    expect(fold([...founders, dismiss(Q, 3, 410, byA)]).unknown).toEqual(
      pausedAt(byA)
    );
    const revoked = fold([...founders, revoke(Q, 3, 410, A, 3)]);
    expect(revoked.unknown).toBeNull();
    expect(roles(revoked)).toEqual({
      [Q]: 'admin',
      [D]: 'member',
      [B]: 'member',
    });
  });
});
