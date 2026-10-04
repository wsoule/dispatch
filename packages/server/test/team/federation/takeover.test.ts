import {
  buildOp,
  fingerprint,
  generateReplicaKeys,
  opHash,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';

import type { BoardOp } from '../../../src/team/boardSync/engine.js';
import { MemoryRemote } from './helpers/memoryTransport.js';
import { MemoryV1, serviceReplica, settle } from './helpers/serviceReplica.js';
import type { ServiceReplica } from './helpers/serviceReplica.js';

// FW-R24: a key op for someone else's replica id, signed by a key its
// publisher made, is a rival claim: never a fork, a halt or a new pin.

const open: ServiceReplica[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
});
function team(...handles: string[]) {
  const remote = new MemoryRemote();
  const v1 = new MemoryV1();
  const make = (h: string) => {
    const r = serviceReplica(h, remote, v1);
    open.push(r);
    return r;
  };
  return { remote, v1, make, rs: handles.map(make) };
}
const fp = (r: ServiceReplica) =>
  fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);
const title = (r: ServiceReplica, id: string) => r.store.get(id)?.meta.title;

// Puts a rival key op for `replica` at the front of its log on the branch.
function claim(
  remote: MemoryRemote,
  replica: string,
  ms: number,
  fields: { handle?: string; device?: string } = {},
  k = generateReplicaKeys()
): void {
  const op = buildOp(
    {
      replica,
      seq: 1,
      prev: ZERO_HASH,
      hlc: `${String(ms).padStart(13, '0')}.0000.${replica}`,
      type: 'key',
      body: {
        handle: fields.handle ?? 'mallory',
        device: fields.device ?? 'x',
        build: '0',
        signPub: k.signPub,
        sealPub: k.sealPub,
        legacy: null,
      },
    },
    k.signPriv
  );
  remote.logs.set(replica, [op, ...(remote.logs.get(replica) ?? [])]);
}
const rivalProblem = (r: ServiceReplica, replica: string) =>
  r.fed
    .problems()
    .some((p) => p.subject === `key:${replica}` && p.message.includes(replica));

describe('rival key claims (FW-R24)', () => {
  it('R1: a later joiner admits and reads a replica whose id has a rival claim', async () => {
    const {
      remote,
      make,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    claim(remote, bob.fed.replica, ada.clock.now.getTime());
    const cy = make('cy');
    await settle(ada, bob, cy);
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    await settle(ada, bob, cy);
    const id = bob.store.create({ title: 'from bob' }).meta.id;
    await settle(bob, ada, cy);
    for (const r of [ada, cy]) {
      expect(title(r, id)).toBe('from bob');
      expect(r.fed.cursor(bob.fed.replica).halted).toBeNull();
      expect(r.roster.view()?.members.has(bob.fed.replica)).toBe(true);
      expect(r.fed.pinned(bob.fed.replica)?.fingerprint).toBe(fp(bob));
    }
    expect(rivalProblem(cy, bob.fed.replica)).toBe(true);
  });

  it("R5: a revoked member's claim on the revoker's id does not undo the revocation for a new joiner", async () => {
    const {
      remote,
      make,
      rs: [ada, bob, mal],
    } = team('ada', 'bob', 'mal');
    ada.roster.found('acme');
    await settle(ada, bob, mal);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    ada.roster.admit(mal.fed.replica, { fingerprint: fp(mal) });
    await settle(ada, bob, mal);
    ada.roster.revoke(mal.fed.replica, 'left');
    await settle(ada, bob, mal);
    claim(remote, ada.fed.replica, ada.clock.now.getTime());
    const late = mal.store.create({ title: 'after the revocation' }).meta.id;
    await mal.service.syncNow();
    const cy = make('cy');
    await settle(ada, cy);
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    await settle(ada, bob, cy);
    expect(cy.roster.view()?.revoked.has(mal.fed.replica)).toBe(true);
    expect(title(cy, late)).toBeUndefined();
    expect(cy.fed.cursor(ada.fed.replica).halted).toBeNull();
  });

  it('a new machine still finds the founding when the founder id has a rival claim', async () => {
    const {
      remote,
      make,
      rs: [ada],
    } = team('ada');
    ada.roster.found('acme');
    await ada.service.syncNow();
    claim(remote, ada.fed.replica, ada.clock.now.getTime());
    const cy = make('cy');
    await settle(ada, cy);
    expect(cy.roster.founded()).toBe(true);
    expect(cy.roster.teamId()).toBe(ada.roster.teamId());
    expect(rivalProblem(cy, ada.fed.replica)).toBe(true);
  });

  it("R3: a claim on a legacy replica's id does not freeze its v1 lines in the window", async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const old = 'old-00000099';
    const line = (seq: number): BoardOp => ({
      v: 1,
      replica: old,
      seq,
      hlc: `${String(1790416800000 + seq).padStart(13, '0')}.0000.${old}`,
      task: 't-00000a01',
      kind: 'put',
      origin: '2026-09-26T10:00:00.000Z',
      fields: { title: `line ${seq}` },
    });
    v1.files.set(old, [line(1)]);
    const ada = serviceReplica('ada', remote, v1);
    open.push(ada);
    ada.roster.found('acme');
    await ada.service.syncNow();
    claim(remote, old, ada.clock.now.getTime());
    v1.files.set(old, [line(1), line(2)]);
    await settle(ada);
    expect(title(ada, 't-00000a01')).toBe('line 2');
    expect(ada.roster.view()?.members.has(old)).toBe(false);
  });

  // M1: a key op whose handle or device is not printable is never a claim.
  it('ignores a key op with an off-grammar handle or a control character', async () => {
    const {
      remote,
      make,
      rs: [ada],
    } = team('ada');
    ada.roster.found('acme');
    await ada.service.syncNow();
    claim(remote, 'eve-0000000e', ada.clock.now.getTime(), {
      device: 'desk\u001b]0;pwned\u0007',
    });
    claim(remote, 'zed-0000000f', ada.clock.now.getTime(), {
      handle: 'Zed Shaw',
    });
    const cy = make('cy');
    await settle(ada, cy);
    for (const r of [ada, cy]) {
      expect(r.fed.claims('eve-0000000e')).toEqual([]);
      expect(r.fed.claims('zed-0000000f')).toEqual([]);
    }
  });

  // FW-R26(1), the re-verify's R7: a member grinds a key whose fingerprint
  // sorts first, claims bob's id with handle mal, and admits it as an own
  // device. The first accepted admit of bob's id binds; mal's is void.
  it('R7: a later own-device admit naming a held id is void, whatever its fingerprint', async () => {
    const {
      remote,
      make,
      rs: [ada, bob, mal],
    } = team('ada', 'bob', 'mal');
    ada.roster.found('acme');
    await settle(ada, bob, mal);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob), role: 'admin' });
    ada.roster.admit(mal.fed.replica, { fingerprint: fp(mal) });
    await settle(ada, bob, mal);
    let k = generateReplicaKeys();
    while (fingerprint(k.signPub, k.sealPub).localeCompare(fp(bob)) >= 0)
      k = generateReplicaKeys();
    const ground = fingerprint(k.signPub, k.sealPub);
    claim(
      remote,
      bob.fed.replica,
      ada.clock.now.getTime(),
      { handle: 'mal' },
      k
    );
    const forged = mal.fed.append({
      type: 'roster',
      body: {
        rv: 1,
        action: 'admit',
        replica: bob.fed.replica,
        handle: 'mal',
        role: 'member',
        fingerprint: ground,
      },
    });
    mal.roster.applyVerified(forged, opHash(forged));
    await mal.service.syncNow();
    await settle(ada, bob);
    bob.roster.revoke(mal.fed.replica, 'grinding keys');
    const cy = make('cy');
    await settle(bob, ada, cy);
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    await settle(ada, bob, cy);
    for (const r of [ada, cy]) {
      const view = r.roster.view();
      expect(view?.members.get(bob.fed.replica)).toMatchObject({
        handle: 'bob',
        role: 'admin',
      });
      expect(r.fed.pinned(bob.fed.replica)?.fingerprint).toBe(fp(bob));
      expect(view?.revoked.has(mal.fed.replica)).toBe(true);
    }
  });

  // FW-R26(2), R9: four bogus claims put before an id fill the per-id cap on
  // a later joiner; a claim an admit names is never dropped by the cap.
  it('R9: an admitted key is kept however many bogus claims precede it', async () => {
    const {
      remote,
      make,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    for (let n = 0; n < 4; n++)
      claim(remote, bob.fed.replica, ada.clock.now.getTime());
    const cy = make('cy');
    await settle(ada, bob, cy);
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    await settle(ada, bob, cy);
    const id = bob.store.create({ title: 'from bob' }).meta.id;
    await settle(bob, ada, cy);
    expect(cy.fed.pinned(bob.fed.replica)?.fingerprint).toBe(fp(bob));
    expect(title(cy, id)).toBe('from bob');
  });

  // R9b: the same on the revoker's id must not reopen a revocation.
  it("R9b: bogus claims on the revoker's id do not undo a revocation for a new joiner", async () => {
    const {
      remote,
      make,
      rs: [ada, bob, mal],
    } = team('ada', 'bob', 'mal');
    ada.roster.found('acme');
    await settle(ada, bob, mal);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    ada.roster.admit(mal.fed.replica, { fingerprint: fp(mal) });
    await settle(ada, bob, mal);
    ada.roster.revoke(mal.fed.replica, 'left');
    await settle(ada, bob, mal);
    for (let n = 0; n < 4; n++)
      claim(remote, ada.fed.replica, ada.clock.now.getTime());
    const late = mal.store.create({ title: 'after the revocation' }).meta.id;
    await mal.service.syncNow();
    const cy = make('cy');
    await settle(ada, cy);
    ada.roster.admit(cy.fed.replica, { fingerprint: fp(cy) });
    await settle(ada, bob, cy);
    expect(cy.roster.view()?.revoked.has(mal.fed.replica)).toBe(true);
    expect(title(cy, late)).toBeUndefined();
  });

  // FW-R26(3): undecided claims show as waiting.
  it('lists the claims on an undecided id as waiting', async () => {
    const {
      remote,
      make,
      rs: [ada],
    } = team('ada');
    ada.roster.found('acme');
    await ada.service.syncNow();
    const cy = make('cy');
    await settle(ada, cy);
    claim(remote, cy.fed.replica, ada.clock.now.getTime());
    await settle(ada);
    const waiting = ada.roster
      .waitingClaims()
      .filter((w) => w.replica === cy.fed.replica);
    expect(waiting.map((w) => w.fingerprint).sort()).toHaveLength(2);
  });

  // I1: rival claims cost no fold of their own.
  it('keeps a pass fast with 125 disputed ids', async () => {
    const {
      remote,
      rs: [ada],
    } = team('ada');
    ada.roster.found('acme');
    await ada.service.syncNow();
    for (let n = 0; n < 125; n++) {
      const id = `x${String(n).padStart(3, '0')}-${String(n).padStart(8, '0')}`;
      claim(remote, id, ada.clock.now.getTime(), { handle: 'x' });
      claim(remote, id, ada.clock.now.getTime(), { handle: 'x' });
    }
    await ada.service.syncNow();
    await ada.service.syncNow();
    const started = performance.now();
    await ada.service.syncNow();
    expect(performance.now() - started).toBeLessThan(200);
  });

  // FW-R28: a key an admitted member's admit names that no read found is
  // scanned for outside the caps, with a problem while it is missing.
  it('scans for a named key no read found, and names it while it is missing', async () => {
    const {
      remote,
      make,
      rs: [ada, bob],
    } = team('ada', 'bob');
    ada.roster.found('acme');
    await settle(ada, bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    await settle(ada, bob);
    const bobKey = (remote.logs.get(bob.fed.replica) ?? []).find(
      (e) => e.type === 'key'
    );
    if (bobKey === undefined) throw new Error('no key op for bob');
    remote.gone.add(bobKey);
    const cy = make('cy');
    await settle(ada, cy);
    expect(
      cy.fed
        .problems()
        .some((p) => p.subject === `key:missing:${bob.fed.replica}`)
    ).toBe(true);
    remote.gone.delete(bobKey);
    remote.hidden.add(bobKey);
    await settle(cy);
    expect(cy.fed.pinned(bob.fed.replica)?.fingerprint).toBe(fp(bob));
    expect(
      cy.fed.problems().some((p) => p.subject.startsWith('key:missing:'))
    ).toBe(false);
  });
});
