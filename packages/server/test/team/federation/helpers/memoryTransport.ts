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
  constructor(
    private readonly remote: MemoryRemote,
    private readonly replica: string
  ) {}
  publish(ops: FederatedOp[]): Promise<void> {
    if (this.remote.offline)
      return Promise.reject(new TransportOffline('the remote is unreachable'));
    const log = this.remote.logs.get(this.replica) ?? [];
    for (const op of ops) if (!log.some((e) => e.seq === op.seq)) log.push(op);
    this.remote.logs.set(this.replica, log);
    return Promise.resolve();
  }
  pull(since: Watermarks): Promise<LogEntry[]> {
    if (this.remote.offline) {
      this.lastError = 'the remote is unreachable';
      return Promise.reject(new TransportOffline(this.lastError));
    }
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
      unpublished: 0,
      sizeBytes: null,
      acks: {},
    };
  }
}
