import {
  canonicalize,
  opHash,
  signText,
  TAG,
  verifyEntry,
} from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';

import type { ReadHints, SignedAcks, SyncRepo } from '../boardSync/repo.js';
import { TransportOffline } from './transport.js';
import type {
  FederationTransport,
  TransportHealth,
  Watermarks,
} from './transport.js';

export interface GitTransportDeps {
  repo: SyncRepo;
  replica: string;
  signPriv: string;
  verifyAcks: (acks: SignedAcks) => boolean;
  /** Whether every recipient of a sealed op has acknowledged it. */
  acknowledgedBy: (op: FederatedOp, acks: Map<string, SignedAcks>) => boolean;
  /** This replica's own ops, oldest first, as its local log keeps them. */
  ownLog: () => LogEntry[];
  /** The seqs pruned to stubs on the branch, so the local log stubs them too. */
  onPruned?: (seqs: number[]) => void;
  /** What orders a pull's segment reads: cursor heads and signature checks. */
  readHints?: () => ReadHints;
  /** Each publish's commit: null when it landed, else why it failed. */
  onCommit?: (failed: string | null) => void;
  /** A merge reset the clone to the remote tree; own files were written back. */
  onReset?: (why: string) => void;
  /** Replicas whose reads the budget cut short on consecutive pulls. */
  onStarved?: (replicas: string[]) => void;
  now: () => Date;
}

/** Whether `e` is a well-formed op signed with `signPub`, linked to the prev
 *  it names; for ordering reads only, the pass still verifies the chain. */
export function signedEntry(e: LogEntry, signPub: string): boolean {
  const before =
    e.type === 'key'
      ? null
      : {
          seq: e.seq - 1,
          hash: e.prev,
          hlc: `0000000000000.0000.${e.replica}`,
        };
  return verifyEntry(before, e, signPub).ok;
}

// The git half of the seam: publish commits into the clone, pull runs the
// exchange (fetch, merge, push once more on a race), ack rewrites acks.json
// and prunes this replica's fully acknowledged sealed ops (spec "Git").
export class GitFederationTransport implements FederationTransport {
  readonly kind = 'git' as const;
  private lastExchangeAt: string | null = null;
  private lastError: string | null = null;
  private unpublished = 0;
  private lastAcks: Record<string, string> = {};

  constructor(private readonly deps: GitTransportDeps) {}

  async publish(ops: FederatedOp[]): Promise<void> {
    try {
      await this.republish(ops);
    } catch (err) {
      this.deps.onCommit?.((err as Error).message);
      throw err;
    }
    this.unpublished += ops.length;
    this.deps.onCommit?.(null);
  }

  // Writes `fresh`, and first any of this replica's own ops the branch lacks
  // or holds otherwise (FW-R22 M6): its local log is the record, and only
  // its own segments are read, compared by op hash.
  private async republish(fresh: readonly FederatedOp[] = []): Promise<void> {
    const { repo } = this.deps;
    const onBranch = new Map(repo.readOwn().map((e) => [e.seq, opHash(e)]));
    const seqs = new Set(fresh.map((o) => o.seq));
    const missing = this.deps
      .ownLog()
      .filter((e) => !seqs.has(e.seq) && onBranch.get(e.seq) !== opHash(e));
    await repo.writeV2([...missing, ...fresh]);
  }

  async pull(since: Watermarks): Promise<LogEntry[]> {
    let exchanged = await this.deps.repo.exchange();
    const resets = this.deps.repo.takeResets();
    if (resets.length > 0 && exchanged.offline === undefined) {
      // Own ops the reset dropped go back out before this pull reads.
      await this.republish();
      exchanged = await this.deps.repo.exchange();
      for (const why of resets) this.deps.onReset?.(why);
    }
    if (exchanged.offline !== undefined) {
      this.lastError = exchanged.offline;
      throw new TransportOffline(exchanged.offline);
    }
    this.lastError = null;
    this.unpublished = 0;
    this.lastExchangeAt = this.deps.now().toISOString();
    const entries = this.deps.repo.readV2(since, this.deps.readHints?.());
    this.deps.onStarved?.(this.deps.repo.starvedReplicas());
    return entries;
  }

  scan(replicas: readonly string[] | null): Promise<LogEntry[]> {
    return Promise.resolve(this.deps.repo.scanFull(replicas));
  }

  async ack(through: Watermarks): Promise<void> {
    const body = {
      v: 1 as const,
      replica: this.deps.replica,
      through: Object.fromEntries(through),
      at: this.deps.now().toISOString(),
    };
    // Own files a branch writer turned into symlinks come back as ours (N2).
    if ((await this.deps.repo.repairOwn()) > 0) await this.republish();
    const sig = signText(
      this.deps.signPriv,
      `${TAG.ack}\n${canonicalize(body)}`
    );
    await this.deps.repo.writeAcks({ ...body, sig });
    const acks = new Map(
      [...this.deps.repo.readAcks()].filter(([, a]) => this.deps.verifyAcks(a))
    );
    // When each replica last acknowledged, for the pruning-blocker list (F-D39).
    this.lastAcks = Object.fromEntries(
      [...acks].map(([replica, a]) => [replica, a.at])
    );
    const pruned = await this.deps.repo.pruneOwn((op) =>
      this.deps.acknowledgedBy(op, acks)
    );
    if (pruned.length > 0) this.deps.onPruned?.(pruned);
  }

  presence(): null {
    return null;
  }

  health(): TransportHealth {
    return {
      kind: 'git',
      lastExchangeAt: this.lastExchangeAt,
      lastError: this.lastError,
      unpublished: this.unpublished,
      sizeBytes: this.deps.repo.sizeBytes(),
      readBytes: this.deps.repo.lastPassBytes(),
      acks: { ...this.lastAcks },
    };
  }
}
