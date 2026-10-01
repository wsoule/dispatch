import { canonicalize, signText, TAG } from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';

import type { SignedAcks, SyncRepo } from '../boardSync/repo.js';
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
  now: () => Date;
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
    this.unpublished += ops.length;
    await this.deps.repo.writeV2(ops);
  }

  async pull(since: Watermarks): Promise<LogEntry[]> {
    const exchanged = await this.deps.repo.exchange();
    if (exchanged.offline !== undefined) {
      this.lastError = exchanged.offline;
      throw new TransportOffline(exchanged.offline);
    }
    this.lastError = null;
    this.unpublished = 0;
    this.lastExchangeAt = this.deps.now().toISOString();
    return this.deps.repo.readV2(since);
  }

  async ack(through: Watermarks): Promise<void> {
    const body = {
      v: 1 as const,
      replica: this.deps.replica,
      through: Object.fromEntries(through),
      at: this.deps.now().toISOString(),
    };
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
    await this.deps.repo.pruneOwn((op) => this.deps.acknowledgedBy(op, acks));
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
      acks: { ...this.lastAcks },
    };
  }
}
