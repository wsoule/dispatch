import { fingerprint, stubOf } from '@dispatch-foo/protocol/federation';
import type { FederatedOp } from '@dispatch-foo/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendAuditToReceipts,
  AUDIT_KINDS,
  auditSince,
} from '../../../src/team/federation/audit.js';
import { licenseFor, testKeys } from '../licenseKeys.js';
import { MemoryRemote } from './helpers/memoryTransport.js';
import { testReplica } from './helpers/replica.js';
import type { TestReplica } from './helpers/replica.js';
import {
  auditKinds,
  MemoryV1,
  serviceReplica,
  settle,
} from './helpers/serviceReplica.js';
import type { ServiceReplica } from './helpers/serviceReplica.js';

const open: (TestReplica | ServiceReplica)[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fp = (r: ServiceReplica) =>
  fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);

// Driven below from real roster and pass paths.
const DRIVEN = [
  'founding',
  'license',
  'invite',
  'admission',
  'observer',
  'role',
  'hosts',
  'revocation',
  'recovery',
  'legacy-close',
  'halt',
];
// Produced and pinned by another task's own test; listed so no kind is orphaned.
const ELSEWHERE: Record<string, string> = {
  trust: 'Task 8b, roster.test.ts (two foundings)',
  dismiss: 'Task 8b, roster.test.ts (a dismiss lifts the pause)',
  reissue: 'Task 9b, legacy.test.ts and store.test.ts',
  fork: 'Task 10b, service.test.ts',
  'bad-signature': 'Task 10b, service.test.ts',
  'clock-hold': 'Task 10b, service.test.ts',
  'speaks-for':
    "Task 10b, service.test.ts (an observer's op); Task 15b, inbound.test.ts",
  'run-conflict': 'Task 14a, presence.test.ts',
  'refused-message': 'Task 15b, inbound.test.ts',
  transport: 'Task 22, relay.test.ts',
  'link-op': 'A2A P5, service.test.ts (an a2a op on the team log)',
};

describe('the federation audit log', () => {
  it('gives every audit kind a producer', () => {
    expect([...DRIVEN, ...Object.keys(ELSEWHERE)].sort()).toEqual(
      [...AUDIT_KINDS].sort()
    );
  });

  it('produces the roster kinds and a halt from real paths', async () => {
    const lk = testKeys();
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const make = (h: string, key?: string) => {
      const r = serviceReplica(h, remote, v1, {
        ...(key === undefined ? {} : { licenseKey: key }),
        licensePublicKey: lk.publicKey,
      });
      open.push(r);
      return r;
    };
    const ada = make('ada', licenseFor(lk.privateKey, { seats: 5 }));
    const bob = make('bob');
    const ops = make('ops');
    const { recoveryCode } = ada.roster.found('acme');
    await settle(ada, bob, ops);
    ada.roster.admit(bob.fed.replica, { fingerprint: fp(bob) });
    ada.roster.admit(ops.fed.replica, { fingerprint: fp(ops), observer: true });
    ada.roster.setRole(bob.fed.replica, 'admin');
    ada.roster.setHosts(bob.fed.replica, ['eve']);
    ada.roster.invite('cy');
    ada.roster.closeLegacy();
    await settle(ada, bob, ops);
    const ada2 = make('ada');
    await settle(ada2);
    ada2.roster.recover(recoveryCode);
    await settle(ada2, bob);
    bob.roster.revoke(ops.fed.replica, 'decommissioned');
    bob.store.create({ title: 'to be stubbed' });
    await bob.service.syncNow();
    const last = (remote.logs.get(bob.fed.replica) ?? []).at(-1) as FederatedOp;
    // A stub in place of a task op halts bob's log on ada.
    remote.tamper(bob.fed.replica, last.seq, (e) => stubOf(e as FederatedOp));
    await settle(ada);
    const kinds = new Set([...auditKinds(ada), ...auditKinds(bob)]);
    for (const k of DRIVEN) expect([k, kinds.has(k)]).toEqual([k, true]);
    for (const r of auditSince(ada.fed, 0))
      expect(AUDIT_KINDS).toContain(r.kind);
  });

  it('appends only new rows to federation/audit.jsonl and never reads it back', () => {
    const ada = testReplica('ada');
    open.push(ada);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-receipts-')));
    dirs.push(dir);
    ada.roster.found('acme');
    const first = appendAuditToReceipts(ada.fed, dir);
    expect(first).toBeGreaterThan(0);
    expect(appendAuditToReceipts(ada.fed, dir)).toBe(0);
    ada.fed.audit('trust', 'bob-0000000b', { fingerprint: 'F' });
    expect(appendAuditToReceipts(ada.fed, dir)).toBe(1);
    const lines = readFileSync(join(dir, 'federation', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(first + 1);
    rmSync(join(dir, 'federation'), { recursive: true });
    expect(appendAuditToReceipts(ada.fed, dir)).toBe(0);
    expect(existsSync(join(dir, 'federation', 'audit.jsonl'))).toBe(false);
  });

  it('pages rows past an id in order', () => {
    const ada = testReplica('ada');
    open.push(ada);
    ada.roster.found('acme');
    for (const n of [1, 2, 3]) ada.fed.audit('trust', `bob-0000000${n}`, { n });
    const all = auditSince(ada.fed, 0);
    const page = auditSince(ada.fed, all[0]?.id ?? 0, 2);
    expect(page.map((r) => r.id)).toEqual(all.slice(1, 3).map((r) => r.id));
  });
});
