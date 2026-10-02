import { LICENSE_PUBLIC_KEY } from '@dispatch/federation';
import { canonicalize, TAG, verifyText } from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../sync/worktree.js';
import type { SyncLedger } from '../boardSync/ledger.js';
import type { ReadHints, SignedAcks } from '../boardSync/repo.js';
import { SyncRepo } from '../boardSync/repo.js';
import type { SyncedTaskStore } from '../boardSync/syncedStore.js';
import type { Team } from '../index.js';
import { syncSeats } from '../index.js';
import { GitFederationTransport, signedEntry } from './git.js';
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
      onPruned: (seqs) => fed.stubLog(seqs),
      readHints: () => readHints(fed),
      onStarved: (replicas) => starvedProblems(fed, replicas),
      onCommit: (failed) => {
        if (failed === null) fed.clearProblem('transport:commit');
        else
          fed.problem(
            'transport:commit',
            `this machine could not commit to its sync clone, so its changes wait here: ${failed.slice(0, 300)}`
          );
      },
      onReset: (why) =>
        fed.problem(
          'transport:merge',
          `someone with push access changed this machine's files on the sync branch, so its changes could not merge; Dispatch took the branch as the remote holds it and wrote this machine's changes back. Check who can push to the sync branch. (${why.slice(0, 200)})`
        ),
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

// Each replica's cursor head, and a check against its pinned key, so a pull
// reads the segment that continues the log before any other (I2).
function readHints(fed: FedStore): ReadHints {
  const heads = new Map<string, string>();
  for (const row of fed.db
    .query<{ replica: string; hash: string | null }, []>(
      'SELECT replica, hash FROM fed_cursors'
    )
    .all())
    if (row.hash !== null) heads.set(row.replica, row.hash);
  // Read in full: every id with a key claim or a cursor, and this machine.
  const known = new Set<string>([fed.replica, ...heads.keys()]);
  for (const c of fed.claims()) known.add(c.replica);
  return {
    heads,
    known,
    signedBy: (e) => {
      const pin = fed.pinned(e.replica);
      return pin !== null && signedEntry(e, pin.signPub);
    },
  };
}

// A problem per replica whose reads the budget keeps cutting short; cleared
// once its reads fit again.
function starvedProblems(fed: FedStore, replicas: string[]): void {
  const prefix = 'transport:read:';
  for (const p of fed.problems())
    if (
      p.subject.startsWith(prefix) &&
      !replicas.includes(p.subject.slice(prefix.length))
    )
      fed.clearProblem(p.subject);
  for (const replica of replicas)
    fed.problem(
      `${prefix}${replica}`,
      `${replica}'s files on the sync branch are more than one pass can read; files that add nothing to its log may be crowding it out`
    );
}
