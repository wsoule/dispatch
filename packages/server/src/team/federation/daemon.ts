import { LICENSE_PUBLIC_KEY } from '@dispatch/federation';
import type { Address, DeliveryEngine, MessageStore } from '@dispatch/protocol';
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
import { AgentSync } from './agents.js';
import { ChannelSync } from './channels.js';
import { GitFederationTransport, signedEntry } from './git.js';
import { Homes } from './homes.js';
import type { HomeTasks } from './homes.js';
import { DaemonFederationHooks } from './hooks.js';
import { loadOrCreateKeys } from './keys.js';
import { LegacyWindow } from './legacy.js';
import { MailOut } from './mail.js';
import { Presence } from './presence.js';
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

/** What messaging federates through: homes, run presence, the hooks. */
export interface MessagingFederation {
  homes: Homes;
  presence: Presence;
  hooks: DaemonFederationHooks;
}

// The F2 pieces over a built federation: Presence registered as a collector
// and the `presence` handler, and the hooks the delivery engine calls.
export function wireMessagingFederation(
  federation: Federation,
  deps: {
    ledger: SyncLedger;
    tasks: HomeTasks;
    build: string;
    device: string;
    knowsRun: (runId: string) => boolean;
    isLive: (runId: string) => boolean;
    messages: () => MessageStore | null;
    now: () => Date;
  }
): MessagingFederation {
  const { fed, roster, service } = federation;
  const homes = new Homes({ fed, roster, tasks: deps.tasks });
  const presence = new Presence({
    fed,
    roster,
    build: deps.build,
    device: deps.device,
    knowsRun: deps.knowsRun,
    isLive: deps.isLive,
    now: deps.now,
    changed: () => service.notifyLocalChange(),
  });
  service.register(presence);
  service.addCollector(presence);
  const hooks = new DaemonFederationHooks({
    ledger: deps.ledger,
    fed,
    roster,
    homes,
    messages: deps.messages,
    knowsRun: deps.knowsRun,
  });
  return { homes, presence, hooks };
}

// The agent roster, channel memberships and outbound mail, once messaging
// is open: each publishes in the pass, and the syncs project after it.
export function wireAgentsAndChannels(
  federation: Federation,
  deps: {
    homes: Homes;
    messages: MessageStore;
    engine: DeliveryEngine;
    implicit: (channel: string) => Address[];
  }
): void {
  const { fed, roster, service } = federation;
  const agents = new AgentSync({ fed, roster, messages: deps.messages });
  const channels = new ChannelSync({
    fed,
    roster,
    messages: deps.messages,
    engine: deps.engine,
    implicit: deps.implicit,
  });
  for (const sync of [agents, channels]) {
    service.register(sync);
    service.addCollector(sync);
  }
  service.addCollector(
    new MailOut({ fed, roster, homes: deps.homes, messages: deps.messages })
  );
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
      readHints: () => readHints(fed, roster),
      onStarved: (replicas) => starvedProblems(fed, replicas, roster.founded()),
      onRewriteSelf: () => {
        rewroteSelf(fed, ledger.replica);
      },
      onRewritten: (replicas) => {
        for (const replica of replicas)
          transportProblem(
            fed,
            roster.founded(),
            'rewrite',
            replica,
            `${replica}'s files on the sync branch were rewritten, not appended to, as no Dispatch writes them: someone with push access is changing them. Its new ops are still read from the end of each file; check who can push.`
          );
      },
      onOversized: (files) => {
        for (const file of files) {
          const replica = file.slice(0, file.indexOf('/'));
          transportProblem(
            fed,
            roster.founded(),
            'bloat',
            replica,
            `fed/${file} on the sync branch is far larger than any segment Dispatch writes: someone with push access padded it. Its lines are still read, slowly; remove the padding from the branch.`
          );
        }
      },
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
function readHints(fed: FedStore, roster: RosterService): ReadHints {
  const heads = new Map<string, string>();
  for (const row of fed.db
    .query<{ replica: string; hash: string | null }, []>(
      'SELECT replica, hash FROM fed_cursors'
    )
    .all())
    if (row.hash !== null) heads.set(row.replica, row.hash);
  // FW-R26(4): admitted members first, then other ids with a cursor; an id
  // with only a claim is read to its key op and first roster op, a few a pass.
  const view = roster.view();
  const members = view?.members;
  // FW-R28: an id an accepted admit, recover or the founding names is read
  // as a member, as is one an admit names whose key no read has found yet.
  const named = new Set<string>([
    ...(view?.boundKeys.keys() ?? []),
    ...(view?.revoked.keys() ?? []),
    ...(view === null ? [] : [view.founder]),
    ...roster.missingNamedKeys().map((m) => m.replica),
  ]);
  // FW-R29(2): before founding, every id is streamed in full, in resumable steps,
  // for its key and found ops; the probe window is only a fast path.
  const tier = (r: string): number =>
    r === fed.replica || members?.has(r) === true
      ? 0
      : view === null || named.has(r) || heads.has(r)
        ? 1
        : 2;
  return {
    heads,
    tier,
    signedBy: (e) => {
      const pin = fed.pinned(e.replica);
      return pin !== null && signedEntry(e, pin.signPub);
    },
  };
}

// The owner wrote its own files afresh: say so, and drop the bloat note on
// them, as the padding went with the rewrite.
export function rewroteSelf(fed: FedStore, own: string): void {
  fed.problem(
    'transport:rewrite:self',
    "someone with push access changed this machine's own files on the sync branch; Dispatch wrote them afresh from this machine's log. Check who can push to the sync branch."
  );
  fed.clearProblem(`transport:bloat:${own}`);
}

// A problem per replica whose reads the budget keeps cutting short; cleared
// once its reads fit again.
export function starvedProblems(
  fed: FedStore,
  replicas: string[],
  founded = true
): void {
  const prefix = 'transport:read:';
  // Before founding, one note for every id (FW-R30(5)).
  if (!founded) {
    const subject = `${prefix}before-founding`;
    if (replicas.length === 0) fed.clearProblem(subject);
    else
      fed.problem(
        subject,
        `${replicas.length} ids on the sync branch have more files than one pass can read; someone with push access may be crowding them out. (${[...replicas].sort().join(', ')})`
      );
    return;
  }
  for (const p of fed.problems())
    if (
      p.subject.startsWith(prefix) &&
      !replicas.includes(p.subject.slice(prefix.length))
    )
      fed.clearProblem(p.subject);
  for (const replica of replicas)
    fed.problem(
      `${prefix}${replica}`,
      `${replica}'s files on the sync branch are more than one pass can read, so its changes arrive slowly; files that add nothing to its log may be crowding it out. Someone with push access should remove the files under fed/${replica}/ its owner did not write.`
    );
}

// The kinds of per-id transport note, in words, for the one note per kind
// raised before founding.
const TRANSPORT_KINDS: Record<string, string> = {
  rewrite: 'had their files rewritten, not appended to',
  bloat: 'have files far larger than any segment Dispatch writes',
};

/** A per-id transport note. Before founding, when anyone can make ids, they
 *  are gathered into one note per kind (FW-R30(5)). */
export function transportProblem(
  fed: FedStore,
  founded: boolean,
  kind: string,
  replica: string,
  message: string
): void {
  if (founded) {
    fed.problem(`transport:${kind}:${replica}`, message);
    return;
  }
  const subject = `transport:${kind}:before-founding`;
  const held = fed.problems().find((p) => p.subject === subject);
  const ids = new Set(
    held?.message
      .match(/\(([^)]*)\)$/)?.[1]
      ?.split(', ')
      .filter((r) => r !== '') ?? []
  );
  ids.add(replica);
  const listed = [...ids].sort();
  fed.problem(
    subject,
    `${listed.length} ids on the sync branch ${TRANSPORT_KINDS[kind] ?? kind}; someone with push access put them there. Check who can push to the sync branch. (${listed.join(', ')})`
  );
}
