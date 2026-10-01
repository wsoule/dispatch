import { fingerprint, hlcWallMs, opHash } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  decodeInviteCode,
  decodeRecoveryCode,
  encodeInviteCode,
  encodeRecoveryCode,
  RosterError,
} from '../../../src/team/federation/roster.js';
import { syncSeats } from '../../../src/team/index.js';
import { licensedManager, licenseFor, testKeys } from '../licenseKeys.js';
import { exchange, feed, testReplica } from './helpers/replica.js';
import type { TestReplica } from './helpers/replica.js';

const open: TestReplica[] = [];
const make = (handle: string, opts?: Parameters<typeof testReplica>[1]) => {
  const r = testReplica(handle, opts);
  open.push(r);
  return r;
};
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});
const fp = (r: TestReplica) =>
  fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);
const auditKinds = (r: TestReplica) =>
  r.fed.db
    .query<{ kind: string }, []>('SELECT kind FROM fed_audit ORDER BY id')
    .all()
    .map((row) => row.kind);
const actionOf = (o: { type: string; body?: unknown }) =>
  o.type === 'roster' ? (o.body as { action: string }).action : o.type;

describe('founding', () => {
  it('publishes key then found, pins itself, and shows a recovery code once', () => {
    const ada = make('ada');
    const { recoveryCode } = ada.roster.found('acme');
    expect(ada.fed.outbox().map(actionOf)).toEqual(['key', 'found']);
    const group = '[0-9A-Z]{4}';
    expect(recoveryCode).toMatch(new RegExp(`^(${group}-){12}${group}$`));
    for (const letter of 'IL' + 'OU')
      expect(recoveryCode).not.toContain(letter);
    expect(ada.roster.view()?.founder).toBe(ada.fed.replica);
    expect(() => ada.roster.found('again')).toThrow(RosterError);
  });

  it('shares an installed license key at founding', () => {
    const lk = testKeys();
    const ada = make('ada', {
      licenseKey: licenseFor(lk.privateKey, { seats: 5 }),
      licensePublicKey: lk.publicKey,
    });
    ada.roster.found('acme');
    expect(ada.roster.seats()).toBe(5);
    expect(ada.fed.outbox().map(actionOf)).toContain('license');
    expect(auditKinds(ada)).toEqual(
      expect.arrayContaining(['founding', 'license'])
    );
  });

  // M5: a founding that fails after its found op folded leaves no stale view.
  it('leaves no founded view behind when founding fails partway', () => {
    const lk = testKeys();
    const ada = make('ada', {
      licenseKey: licenseFor(lk.privateKey, { org: 'x'.repeat(1_100_000) }),
      licensePublicKey: lk.publicKey,
    });
    expect(() => ada.roster.found('acme')).toThrow();
    expect(ada.roster.founded()).toBe(false);
    expect(ada.roster.view()).toBeNull();
    expect(ada.fed.outbox()).toEqual([]);
  });

  it('pins neither of two foundings seen at once, until trust picks one', () => {
    const ada = make('ada');
    const bob = make('bob');
    const cy = make('cy');
    ada.roster.found('acme');
    bob.roster.found('acme-too');
    feed(ada, cy);
    feed(bob, cy);
    expect(cy.roster.founded()).toBe(false);
    expect(
      cy.roster
        .foundingsSeen()
        .map((f) => f.fingerprint)
        .sort()
    ).toEqual([fp(ada), fp(bob)].sort());
    cy.roster.trust(fp(ada));
    expect(cy.roster.view()?.founder).toBe(ada.fed.replica);
    expect(auditKinds(cy)).toEqual(
      expect.arrayContaining(['trust', 'founding'])
    );
  });

  it('lets a founder with no members trust the other founding, and refuses once it has members', () => {
    const ada = make('ada');
    const bob = make('bob');
    const cy = make('cy');
    ada.roster.found('acme');
    bob.roster.found('acme-too');
    feed(ada, bob);
    bob.roster.trust(fp(ada));
    expect(bob.roster.view()?.founder).toBe(ada.fed.replica);
    feed(ada, cy);
    feed(cy, ada);
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    feed(bob, ada);
    expect(() => ada.roster.trust(fp(bob))).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: 'your team already has members',
      })
    );
  });
});

describe('joining and admission', () => {
  it('publishes its key op once it pins a founder, and waits until an admin admits it by fingerprint', () => {
    const ada = make('ada');
    const bob = make('bob');
    ada.roster.found('acme');
    feed(ada, bob);
    expect(bob.fed.outbox().map((o) => o.type)).toEqual(['key']);
    feed(bob, ada);
    expect(ada.roster.view()?.pending).toContain(bob.fed.replica);
    expect(() =>
      ada.roster.admit(bob.fed.replica, {
        fingerprint: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
      })
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    exchange(ada, bob);
    expect(bob.roster.isAdmitted(bob.fed.replica)).toBe(true);
    expect(ada.roster.handleOf(bob.fed.replica)).toBe('bob');
  });

  it('lets a member admit their own device as a member and nothing else', () => {
    const ada = make('ada');
    const bob = make('bob');
    const bob2 = make('bob');
    const cy = make('cy');
    ada.roster.found('acme');
    exchange(ada, bob, bob2, cy);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    exchange(ada, bob, bob2, cy);
    bob.roster.admit(bob2.fed.replica, { fingerprint: fp(bob2) });
    expect(() =>
      bob.roster.admit(cy.fed.replica, { fingerprint: fp(cy) })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }));
    exchange(ada, bob, bob2, cy);
    expect(ada.roster.replicasOfHandle('bob').sort()).toEqual(
      [bob.fed.replica, bob2.fed.replica].sort()
    );
  });

  it('refuses a new handle past the seats with 402 wording', () => {
    const ada = make('ada');
    const others = ['bob', 'cy', 'dee'].map((h) => make(h));
    ada.roster.found('acme');
    exchange(ada, ...others);
    const [bob, cy, dee] = others as [TestReplica, TestReplica, TestReplica];
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    expect(() =>
      ada.roster.admit(dee.fed.replica, { fingerprint: fp(dee) })
    ).toThrow(
      expect.objectContaining({
        code: 'seat_limit',
        message: expect.stringContaining('the free plan covers 3 people'),
      })
    );
  });

  it('carries an invite proof and shows who invited', () => {
    const ada = make('ada');
    const bob = make('bob');
    ada.roster.found('acme');
    const { code } = ada.roster.invite('bob');
    bob.roster.join(code);
    feed(ada, bob);
    feed(bob, ada);
    expect(ada.roster.view()?.invitedBy.get(bob.fed.replica)).toBe('ada');
    expect(() => bob.roster.join(code)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
  });
});

describe('an invite binds which founding a joiner follows (FW-R22 I3)', () => {
  it('ignores a hostile founding seen first, follows the invite’s team, and keeps the invite', () => {
    const ada = make('ada');
    const hal = make('hal');
    const bob = make('bob');
    ada.roster.found('acme');
    hal.roster.found('acme');
    const { code } = ada.roster.invite('bob');
    bob.roster.join(code);
    feed(hal, bob);
    expect(bob.roster.founded()).toBe(false);
    expect(() => bob.roster.trust(fp(hal))).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
    feed(ada, bob);
    expect(bob.roster.view()?.founder).toBe(ada.fed.replica);
    expect(bob.roster.teamId()).toBe(ada.roster.teamId());
    expect(bob.fed.meta('pending_invite')).not.toBeNull();
    feed(bob, ada);
    expect(ada.roster.view()?.invitedBy.get(bob.fed.replica)).toBe('ada');
  });
});

describe('leaving an invite behind (FW-R22 M-e)', () => {
  it('names the way out, and abandoning the invite lets trust pick another founding', () => {
    const ada = make('ada');
    const hal = make('hal');
    const bob = make('bob');
    ada.roster.found('acme');
    hal.roster.found('acme');
    bob.roster.join(ada.roster.invite('bob').code);
    feed(hal, bob);
    expect(() => bob.roster.trust(fp(hal))).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('dispatch team abandon-invite'),
      })
    );
    bob.roster.abandonInvite();
    expect(bob.fed.meta('pending_invite')).toBeNull();
    bob.roster.trust(fp(hal));
    expect(bob.roster.view()?.founder).toBe(hal.fed.replica);
  });

  it('pins on the next reload once the invite stops binding, with no new founding', () => {
    const ada = make('ada');
    const hal = make('hal');
    const bob = make('bob');
    ada.roster.found('acme');
    hal.roster.found('acme');
    bob.roster.join(ada.roster.invite('bob').code);
    feed(hal, bob);
    expect(bob.roster.founded()).toBe(false);
    bob.clock.now = new Date(bob.clock.now.getTime() + 8 * 24 * 60 * 60 * 1000);
    bob.roster.reload();
    expect(bob.roster.view()?.founder).toBe(hal.fed.replica);
  });

  it('stops binding once the invite is past its seven days', () => {
    const ada = make('ada');
    const hal = make('hal');
    const bob = make('bob');
    ada.roster.found('acme');
    hal.roster.found('acme');
    bob.roster.join(ada.roster.invite('bob').code);
    bob.clock.now = new Date(bob.clock.now.getTime() + 8 * 24 * 60 * 60 * 1000);
    hal.clock.now = bob.clock.now;
    feed(hal, bob);
    expect(bob.roster.view()?.founder).toBe(hal.fed.replica);
  });
});

describe('revocation, roles and recovery', () => {
  it('revokes with the cut taken from the cursor, and protects the last admin', () => {
    const ada = make('ada');
    const bob = make('bob');
    ada.roster.found('acme');
    exchange(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    exchange(ada, bob);
    ada.roster.revoke(bob.fed.replica, 'lost laptop');
    const revoke = ada.fed.outbox().at(-1)?.body as {
      afterSeq: number;
      afterHash: string;
    };
    expect(revoke.afterSeq).toBe(
      ada.fed.cursor(bob.fed.replica).head?.seq ?? -1
    );
    expect(() => ada.roster.revoke(ada.fed.replica, 'oops')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
    expect(() => ada.roster.setRole(ada.fed.replica, 'member')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    );
    expect(ada.roster.view()?.members.get(ada.fed.replica)?.role).toBe('admin');
  });

  it('rejoins as the last-ranked admin with the recovery code, announced to everyone', () => {
    const ada = make('ada');
    const bob = make('bob');
    const { recoveryCode } = ada.roster.found('acme');
    exchange(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob), role: 'admin' });
    exchange(ada, bob);
    const ada2 = make('ada');
    feed(ada, ada2);
    ada2.roster.recover(recoveryCode);
    exchange(ada, bob, ada2);
    const me = bob.roster.view()?.members.get(ada2.fed.replica);
    expect(me).toMatchObject({ role: 'admin', recovered: true });
    expect(
      bob.fed
        .problems()
        .some((p) =>
          p.message.includes('became an admin with the recovery code')
        )
    ).toBe(true);
    expect(auditKinds(bob)).toContain('recovery');
  });

  it('refuses a recovery code that is not the current one before publishing', () => {
    const ada = make('ada');
    ada.roster.found('acme');
    const ada2 = make('ada');
    feed(ada, ada2);
    const wrong = encodeRecoveryCode(new Uint8Array(32).fill(1));
    expect(() => ada2.roster.recover(wrong)).toThrow(
      expect.objectContaining({ code: 'invalid' })
    );
    expect(ada2.fed.outbox().map(actionOf)).toEqual(['key']);
  });

  it('speaks for its own handle and its hosts', () => {
    const ada = make('ada');
    const host = make('box');
    ada.roster.found('acme');
    exchange(ada, host);
    ada.roster.admit(host.fed.replica, {
      fingerprint: fp(host),
      hosts: ['eve'],
    });
    exchange(ada, host);
    expect(ada.roster.speaksForHuman(host.fed.replica, 'eve', 10)).toBe(true);
    expect(ada.roster.speaksForHuman(host.fed.replica, 'ada', 10)).toBe(false);
  });

  it('admits an observer that speaks for nobody, not even its own handle', () => {
    const ada = make('ada');
    const ops = make('ops');
    ada.roster.found('acme');
    exchange(ada, ops);
    ada.roster.admit(ops.fed.replica, { fingerprint: fp(ops), observer: true });
    exchange(ada, ops);
    expect(ada.roster.isObserver(ops.fed.replica)).toBe(true);
    expect(ada.roster.speaksForHuman(ops.fed.replica, 'ops', 10)).toBe(false);
    expect(() => ops.roster.invite('ops')).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    );
  });
});

describe('dismissing an op no build reads', () => {
  it('lets an admin dismiss a member’s unreadable op, lifting the pause, and no one else', () => {
    const ada = make('ada');
    const bob = make('bob');
    ada.roster.found('acme');
    exchange(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    exchange(ada, bob);
    const zap = bob.fed.append({
      type: 'roster',
      body: { rv: 9, action: 'zap' },
    });
    // A newer build applies its own op as it publishes it.
    bob.roster.applyVerified(zap, opHash(zap));
    exchange(ada, bob);
    expect(ada.roster.view()?.unknown?.seq).toBe(zap.seq);
    expect(() =>
      bob.roster.dismiss(bob.fed.replica, zap.seq, 'not-the-hash')
    ).toThrow(expect.objectContaining({ code: 'invalid' }));
    const named = { replica: bob.fed.replica, seq: zap.seq };
    const hash = ada.roster.opHashOf(named.replica, named.seq) ?? '';
    expect(() => bob.roster.dismiss(named.replica, named.seq, hash)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    );
    ada.roster.dismiss(named.replica, named.seq, hash);
    expect(ada.roster.view()?.unknown).toBeNull();
    expect(ada.roster.view()?.dismissed).toEqual([
      { ...named, hash, by: ada.fed.replica },
    ]);
    exchange(ada, bob);
    expect(bob.roster.view()?.unknown).toBeNull();
    expect(auditKinds(bob)).toContain('dismiss');
  });

  it('refuses to dismiss an op every build reads', () => {
    const ada = make('ada');
    ada.roster.found('acme');
    const found = ada.fed.outbox()[1];
    const hash = ada.roster.opHashOf(ada.fed.replica, found?.seq ?? 0) ?? '';
    expect(() =>
      ada.roster.dismiss(ada.fed.replica, found?.seq ?? 0, hash)
    ).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});

describe('codes', () => {
  it('round-trips recovery and invite codes and refuses anything else', () => {
    const seed = new Uint8Array(32).map((_, i) => i * 7);
    expect([...decodeRecoveryCode(encodeRecoveryCode(seed))]).toEqual([
      ...seed,
    ]);
    const teamId = 'a'.repeat(32);
    const code = encodeInviteCode({ teamId, seed, relay: 'wss://r.example' });
    expect(decodeInviteCode(code)).toEqual({
      teamId,
      seed: Buffer.from(seed),
      relay: 'wss://r.example',
    });
    expect(
      decodeInviteCode(encodeInviteCode({ teamId, seed, relay: null }))
    ).toMatchObject({ relay: null });
    for (const bad of ['', 'di1.x.y.', 'nope', encodeRecoveryCode(seed)])
      expect(() => decodeInviteCode(bad)).toThrow(RosterError);
    expect(() => decodeRecoveryCode('0000-1111')).toThrow(RosterError);
  });
});

describe('seats once founded', () => {
  it('reads the roster’s seats and not the installed license once a team is founded', () => {
    const lk = testKeys();
    const ada = make('ada', {
      licenseKey: licenseFor(lk.privateKey, { seats: 5 }),
      licensePublicKey: lk.publicKey,
    });
    const team = { license: licensedManager(8) };
    const before = syncSeats(team, ada.roster);
    expect(before.seats()).toBe(8);
    ada.roster.found('acme');
    expect(before.seats()).toBe(5);
    expect(before.seatMessage(5)).toContain('the license for Acme covers 5');
    expect(syncSeats(team).seats()).toBe(8);
  });
});

describe('an op stamped far ahead of this clock (FW-R21)', () => {
  it('is held, not applied or observed, until the clock catches up', () => {
    const ada = make('ada');
    const bob = make('bob');
    ada.roster.found('acme');
    bob.clock.now = new Date(ada.clock.now.getTime() + 60 * 60 * 1000);
    feed(ada, bob);
    const key = bob.fed.outbox()[0];
    feed(bob, ada);
    const subject = `op:${bob.fed.replica}:${key?.seq ?? 0}`;
    expect(ada.fed.pinned(bob.fed.replica)).toBeNull();
    expect(ada.fed.cursor(bob.fed.replica).head).toBeNull();
    expect(ada.roster.view()?.pending).not.toContain(bob.fed.replica);
    expect(ada.fed.problems().map((p) => p.subject)).toContain(subject);
    // Ada's clock did not jump: her next op is stamped at her own time.
    ada.roster.invite('cy');
    const invite = ada.fed.outbox().at(-1);
    expect(hlcWallMs(invite?.hlc ?? '')).toBe(ada.clock.now.getTime());
    ada.clock.now = bob.clock.now;
    feed(bob, ada);
    expect(ada.roster.view()?.pending).toContain(bob.fed.replica);
    expect(ada.fed.problems().map((p) => p.subject)).not.toContain(subject);
  });
});

describe('this machine’s own ops and the clock bound (FW-R22 I4)', () => {
  it('folds its own ops after its wall clock steps back', () => {
    const ada = make('ada');
    const bob = make('bob');
    ada.roster.found('acme');
    exchange(ada, bob);
    // The wall clock steps back an hour; the chain's clock cannot.
    ada.clock.now = new Date(ada.clock.now.getTime() - 60 * 60 * 1000);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    expect(ada.roster.isAdmitted(bob.fed.replica)).toBe(true);
    expect(
      ada.fed
        .problems()
        .some((p) => p.subject.startsWith(`op:${ada.fed.replica}:`))
    ).toBe(false);
  });
});

describe('the audit log', () => {
  it('records every roster op it applies by kind, on the publisher and on a teammate', () => {
    const ada = make('ada');
    const bob = make('bob');
    const ops = make('ops');
    ada.roster.found('acme');
    exchange(ada, bob, ops);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    ada.roster.admit(ops.fed.replica, { fingerprint: fp(ops), observer: true });
    ada.roster.setRole(bob.fed.replica, 'admin');
    ada.roster.setHosts(bob.fed.replica, ['eve']);
    ada.roster.invite('cy');
    ada.roster.replaceRecoveryKey();
    ada.roster.closeLegacy([]);
    exchange(ada, bob, ops);
    const expected = [
      'founding',
      'admission',
      'observer',
      'role',
      'hosts',
      'invite',
      'recovery',
      'legacy-close',
    ];
    expect(auditKinds(ada)).toEqual(expect.arrayContaining(expected));
    expect(auditKinds(bob)).toEqual(expect.arrayContaining(expected));
    bob.roster.revoke(ops.fed.replica, 'decommissioned');
    exchange(ada, bob);
    expect(auditKinds(ada)).toContain('revocation');
  });
});
