import {
  buildOp,
  fingerprint,
  generateReplicaKeys,
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
  fields: { handle?: string; device?: string } = {}
): void {
  const k = generateReplicaKeys();
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
});
