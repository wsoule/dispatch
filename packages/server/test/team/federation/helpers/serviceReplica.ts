import { openDispatchDb, SqliteTaskStore } from '@dispatch/core';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BoardOp } from '../../../../src/team/boardSync/engine.js';
import { SyncLedger } from '../../../../src/team/boardSync/ledger.js';
import type { RepoSyncResult } from '../../../../src/team/boardSync/repo.js';
import { personOf } from '../../../../src/team/boardSync/repo.js';
import { SyncedTaskStore } from '../../../../src/team/boardSync/syncedStore.js';
import { loadOrCreateKeys } from '../../../../src/team/federation/keys.js';
import { LegacyWindow } from '../../../../src/team/federation/legacy.js';
import { RosterService } from '../../../../src/team/federation/roster.js';
import { FederationService } from '../../../../src/team/federation/service.js';
import type { V1Branch } from '../../../../src/team/federation/service.js';
import { FedStore } from '../../../../src/team/federation/store.js';
import { TaskOpSigner } from '../../../../src/team/federation/taskOps.js';
import { syncSeats } from '../../../../src/team/index.js';
import { LicenseManager } from '../../../../src/team/license.js';
import type { MemoryRemote } from './memoryTransport.js';
import { MemoryTransport } from './memoryTransport.js';

// A v1 branch in memory, shared by every replica of a test: replica -> its
// lines, in file order.
export class MemoryV1 {
  files = new Map<string, BoardOp[]>();

  readV1(replica: string): BoardOp[] {
    return [...(this.files.get(replica) ?? [])];
  }

  v1Replicas(): string[] {
    return [...this.files.keys()];
  }

  /** The branch as one replica's clone sees it, which SyncRepo stands in for. */
  branch(replica: string): V1Branch {
    return {
      readV1: (r) => this.readV1(r),
      v1Replicas: () => this.v1Replicas(),
      ensure: () => Promise.resolve(),
      exchange: (): Promise<RepoSyncResult> =>
        Promise.resolve({ pushed: true }),
      write: (ops) => {
        const file = this.files.get(replica) ?? [];
        this.files.set(replica, [...file, ...ops]);
        return Promise.resolve();
      },
      readOthers: (cursor) =>
        this.v1Replicas()
          .filter((r) => r !== replica)
          .flatMap((r) => this.readV1(r).filter((o) => o.seq > cursor(r))),
      people: () => {
        const people = new Map<string, string>();
        for (const [r, ops] of this.files) {
          const first = ops[0];
          if (first === undefined) continue;
          const seen = people.get(personOf(r));
          if (seen === undefined || first.hlc < seen)
            people.set(personOf(r), first.hlc);
        }
        return people;
      },
    };
  }
}

export interface ServiceReplica {
  dir: string;
  ledger: SyncLedger;
  fed: FedStore;
  roster: RosterService;
  legacy: LegacyWindow;
  store: SyncedTaskStore;
  service: FederationService;
  clock: { now: Date };
  close(): void;
}

// One daemon's board sync, wired as index.ts wires it, over a shared
// in-memory remote and v1 branch, its clock in the test's hands.
export function serviceReplica(
  handle: string,
  remote: MemoryRemote,
  v1: MemoryV1,
  opts: {
    licenseKey?: string;
    licensePublicKey?: string | null;
    seenOpsKept?: number;
    maxParkedPerPublisher?: number;
  } = {}
): ServiceReplica {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fed-svc-${handle}-`)));
  const clock = { now: new Date('2026-09-26T10:00:00.000Z') };
  const now = () => clock.now;
  const ledger = new SyncLedger(join(dir, 'state.db'), handle, () =>
    clock.now.getTime()
  );
  const fed = new FedStore(ledger, loadOrCreateKeys(dir, ledger.replica), now);
  const branch = v1.branch(ledger.replica);
  const legacyRef: { current: LegacyWindow | null } = { current: null };
  const signerRef: { current: TaskOpSigner | null } = { current: null };
  const roster = new RosterService({
    fed,
    handle,
    device: `${handle}-laptop`,
    build: '0.40.0',
    now,
    installedLicense: () => opts.licenseKey ?? null,
    licensePublicKey: opts.licensePublicKey ?? null,
    legacy: () => legacyRef.current?.attestAll() ?? [],
    ownV1Attestation: () => legacyRef.current?.ownAttestation() ?? null,
  });
  const legacy = new LegacyWindow({
    ledger,
    fed,
    roster,
    log: branch,
    now,
    signer: () => {
      if (signerRef.current === null)
        throw new Error('the signer is not wired');
      return signerRef.current;
    },
  });
  legacyRef.current = legacy;
  const signer = new TaskOpSigner({
    ledger,
    fed,
    roster,
    v1Copy: (op, piece) => legacy.v1Copy(op, piece),
  });
  signerRef.current = signer;
  const store = new SyncedTaskStore(
    new SqliteTaskStore(dir, openDispatchDb(':memory:')),
    ledger
  );
  store.setSigner(signer);
  const license = new LicenseManager({
    path: join(dir, 'license.key'),
    publicKey: opts.licensePublicKey ?? null,
    clock: now,
  });
  const service = new FederationService({
    store,
    ledger,
    v1: branch,
    fed,
    roster,
    legacy,
    transport: new MemoryTransport(remote, ledger.replica),
    remote: 'memory',
    branch: 'dispatch-sync',
    intervalMs: 60 * 60 * 1000,
    onBoardChanged: () => {},
    ...syncSeats({ license }, roster),
    // Every pass in these tests is asked for; a debounced one never fires.
    debounceMs: 60 * 60 * 1000,
    now,
    ...(opts.seenOpsKept === undefined
      ? {}
      : { seenOpsKept: opts.seenOpsKept }),
    ...(opts.maxParkedPerPublisher === undefined
      ? {}
      : { maxParkedPerPublisher: opts.maxParkedPerPublisher }),
  });
  return {
    dir,
    ledger,
    fed,
    roster,
    legacy,
    store,
    service,
    clock,
    close: () => {
      void service.stop();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs a pass on each replica in turn, three times. */
export async function settle(...replicas: ServiceReplica[]): Promise<void> {
  for (let round = 0; round < 3; round++)
    for (const r of replicas) await r.service.syncNow();
}

/** The fed_audit kinds, in order. */
export const auditKinds = (r: { fed: FedStore }): string[] =>
  r.fed.db
    .query<{ kind: string }, []>('SELECT kind FROM fed_audit ORDER BY id')
    .all()
    .map((row) => row.kind);
