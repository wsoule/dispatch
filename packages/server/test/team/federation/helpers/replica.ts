import { verifyLog } from '@dispatch/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncLedger } from '../../../../src/team/boardSync/ledger.js';
import { loadOrCreateKeys } from '../../../../src/team/federation/keys.js';
import { RosterService } from '../../../../src/team/federation/roster.js';
import { FedStore } from '../../../../src/team/federation/store.js';

export interface TestReplica {
  dir: string;
  ledger: SyncLedger;
  fed: FedStore;
  roster: RosterService;
  clock: { now: Date };
  close(): void;
}

// A replica with its own state.db and keys in a realpathSync temp directory.
export function testReplica(
  handle: string,
  opts: { licenseKey?: string; licensePublicKey?: string | null } = {}
): TestReplica {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fed-${handle}-`)));
  const clock = { now: new Date('2026-09-26T10:00:00.000Z') };
  const ledger = new SyncLedger(join(dir, 'state.db'), handle, () =>
    clock.now.getTime()
  );
  const fed = new FedStore(
    ledger,
    loadOrCreateKeys(dir, ledger.replica),
    () => clock.now
  );
  const roster = new RosterService({
    fed,
    handle,
    device: `${handle}-laptop`,
    build: '0.40.0',
    now: () => clock.now,
    installedLicense: () => opts.licenseKey ?? null,
    licensePublicKey: opts.licensePublicKey ?? null,
    legacy: () => [],
    ownV1Attestation: () => null,
  });
  return {
    dir,
    ledger,
    fed,
    roster,
    clock,
    close: () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Hands `from`'s published key and roster ops to `to`, verified and applied
// as the pass would; applying a key op pins it.
export function feed(from: TestReplica, to: TestReplica): void {
  const entries: FederatedOp[] = from.fed.outbox();
  const replica = from.fed.replica;
  const r = verifyLog(
    replica,
    entries,
    to.fed.cursor(replica),
    to.fed.pinned(replica)
  );
  // A held op (FW-R21) stops the read there: its cursor and pin wait for it.
  let cursor = to.fed.cursor(replica);
  for (const { entry, hash } of r.accepted) {
    if (entry.type === 'key' || entry.type === 'roster') {
      const applied = to.roster.applyVerified(entry as FederatedOp, hash);
      if (applied === 'held') break;
    }
    cursor = { head: { seq: entry.seq, hash, hlc: entry.hlc }, halted: null };
  }
  if (cursor.head?.seq === r.cursor.head?.seq) cursor = r.cursor;
  to.fed.setCursor(replica, cursor);
}

// Everyone sees everyone's ops, twice, so admissions that follow pins land.
export function exchange(...replicas: TestReplica[]): void {
  for (let round = 0; round < 2; round++)
    for (const from of replicas)
      for (const to of replicas) if (from !== to) feed(from, to);
}
