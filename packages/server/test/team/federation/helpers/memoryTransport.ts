import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';

import { TransportOffline } from '../../../../src/team/federation/transport.js';
import type {
  FederationTransport,
  TransportHealth,
  Watermarks,
} from '../../../../src/team/federation/transport.js';

// The sync branch as shared memory: one log per replica, in publish order.
export class MemoryRemote {
  readonly logs = new Map<string, LogEntry[]>();
  offline = false;
  /** Publishes land in the clone but every push is refused (a git merge
   *  that keeps failing): they wait as unpublished. */
  rejectPush = false;
  tamper(
    replica: string,
    seq: number,
    change: (e: LogEntry) => LogEntry
  ): void {
    const log = this.logs.get(replica) ?? [];
    this.logs.set(
      replica,
      log.map((e) => (e.seq === seq ? change(e) : e))
    );
  }
}

export class MemoryTransport implements FederationTransport {
  readonly kind = 'git' as const;
  private lastError: string | null = null;
  private held: FederatedOp[] = [];
  constructor(
    private readonly remote: MemoryRemote,
    private readonly replica: string
  ) {}
  publish(ops: FederatedOp[]): Promise<void> {
    if (this.remote.offline)
      return Promise.reject(new TransportOffline('the remote is unreachable'));
    this.held.push(...ops);
    if (!this.remote.rejectPush) this.push();
    return Promise.resolve();
  }
  private push(): void {
    if (this.held.length === 0) return;
    const log = this.remote.logs.get(this.replica) ?? [];
    for (const op of this.held.splice(0))
      if (!log.some((e) => e.seq === op.seq)) log.push(op);
    this.remote.logs.set(this.replica, log);
  }
  pull(since: Watermarks): Promise<LogEntry[]> {
    if (this.remote.offline || this.remote.rejectPush) {
      this.lastError = this.remote.offline
        ? 'the remote is unreachable'
        : 'could not merge the sync branch';
      return Promise.reject(new TransportOffline(this.lastError));
    }
    this.push();
    this.lastError = null;
    return Promise.resolve(
      [...this.remote.logs].flatMap(([r, log]) =>
        log.filter((e) => e.seq > (since.get(r) ?? 0))
      )
    );
  }
  ack(): Promise<void> {
    return Promise.resolve();
  }
  presence(): null {
    return null;
  }
  health(): TransportHealth {
    return {
      kind: 'git',
      lastExchangeAt: null,
      lastError: this.lastError,
      unpublished: this.held.length,
      sizeBytes: null,
      acks: {},
    };
  }
}
