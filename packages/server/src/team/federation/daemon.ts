import { LICENSE_PUBLIC_KEY } from '@dispatch/federation';
import { canonicalize, TAG, verifyText } from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../sync/worktree.js';
import type { SyncLedger } from '../boardSync/ledger.js';
import type { SignedAcks } from '../boardSync/repo.js';
import { SyncRepo } from '../boardSync/repo.js';
import type { SyncedTaskStore } from '../boardSync/syncedStore.js';
import type { Team } from '../index.js';
import { syncSeats } from '../index.js';
import { GitFederationTransport } from './git.js';
import { loadOrCreateKeys } from './keys.js';
import { LegacyWindow } from './legacy.js';
import { RosterService } from './roster.js';
import { FederationService } from './service.js';
import { FedStore } from './store.js';
import { TaskOpSigner } from './taskOps.js';

export interface FederationDeps {
  /** The board sync directory: state.db, keys/ and the repo clone. */
  syncDir: string;
  ledger: SyncLedger;
  store: SyncedTaskStore;
  team: Pick<Team, 'license'>;
  handle: string;
  build: string;
  remoteUrl: string;
  branch: string;
  intervalMs: number;
  git: AsyncGitRunner;
  onBoardChanged: () => void;
  now: () => Date;
  debounceMs?: number;
}

/** The pieces the daemon keeps: Task 11's routes read fed and roster. */
export interface Federation {
  service: FederationService;
  fed: FedStore;
  roster: RosterService;
  legacy: LegacyWindow;
}

// Board sync as one daemon runs it: the signed roster, signed task ops, the
// legacy window and the git transport, wired to each other (Task 10b).
export function buildFederation(deps: FederationDeps): Federation {
  const { ledger, now } = deps;
  const repo = new SyncRepo(
    join(deps.syncDir, 'repo'),
    deps.remoteUrl,
    deps.branch,
    ledger.replica,
    deps.git
  );
  const fed = new FedStore(
    ledger,
    loadOrCreateKeys(deps.syncDir, ledger.replica),
    now
  );
  const legacyRef: { current: LegacyWindow | null } = { current: null };
  const signerRef: { current: TaskOpSigner | null } = { current: null };
  const roster = new RosterService({
    fed,
    handle: deps.handle,
    device: hostname().split('.')[0] ?? 'machine',
    build: deps.build,
    now,
    installedLicense: () => deps.team.license.installedKey(),
    licensePublicKey: LICENSE_PUBLIC_KEY,
    legacy: () => legacyRef.current?.attestAll() ?? [],
    ownV1Attestation: () => legacyRef.current?.ownAttestation() ?? null,
    // The v1 outbox flush at founding and joining (spec staging row 9).
    flushV1: async () => {
      const out = ledger.outbox();
      const last = out.at(-1);
      if (last === undefined) return;
      await repo.write(out);
      ledger.sent(last.seq);
    },
  });
  const legacy = new LegacyWindow({
    ledger,
    fed,
    roster,
    log: repo,
    now,
    signer: () => {
      if (signerRef.current === null)
        throw new Error('the task op signer is not wired');
      return signerRef.current;
    },
  });
  legacyRef.current = legacy;
  signerRef.current = new TaskOpSigner({
    ledger,
    fed,
    roster,
    v1Copy: (op, piece) => legacy.v1Copy(op, piece),
  });
  deps.store.setSigner(signerRef.current);
  // An acks.json counts only when its replica's pinned key signed it.
  const verifyAcks = (a: SignedAcks): boolean => {
    const pin = fed.pinned(a.replica);
    if (pin === null) return false;
    const { sig, ...body } = a;
    return verifyText(pin.signPub, `${TAG.ack}\n${canonicalize(body)}`, sig);
  };
  // Every recipient still admitted has read past the op; a revoked or
  // never-admitted one counts as having acknowledged it.
  const acknowledgedBy = (
    op: FederatedOp,
    acks: Map<string, SignedAcks>
  ): boolean =>
    (op.to ?? []).every(
      (r) =>
        !roster.isAdmitted(r) ||
        (acks.get(r)?.through[ledger.replica] ?? 0) >= op.seq
    );
  const service = new FederationService({
    store: deps.store,
    ledger,
    v1: repo,
    fed,
    roster,
    legacy,
    transport: new GitFederationTransport({
      repo,
      replica: ledger.replica,
      signPriv: fed.keys.signPriv,
      verifyAcks,
      acknowledgedBy,
      ownLog: () => fed.ownLog(),
      now,
    }),
    remote: deps.remoteUrl,
    branch: deps.branch,
    intervalMs: deps.intervalMs,
    onBoardChanged: deps.onBoardChanged,
    ...syncSeats(deps.team, roster),
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    now,
  });
  return { service, fed, roster, legacy };
}
