import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';

// The seam every op type crosses (spec "The seam"): git first, the relay later.

/** Per replica, the highest seq this machine has read. */
export type Watermarks = ReadonlyMap<string, number>;

export interface TransportHealth {
  kind: 'git' | 'relay';
  lastExchangeAt: string | null;
  lastError: string | null;
  unpublished: number;
  sizeBytes: number | null;
  /** Replica → `at` of its last verified acks.json (git); {} on the relay (F-D39). */
  acks: Record<string, string>;
}

export interface FederationTransport {
  readonly kind: 'git' | 'relay';
  publish(ops: FederatedOp[]): Promise<void>;
  pull(since: Watermarks): Promise<LogEntry[]>;
  ack(through: Watermarks): Promise<void>;
  /** Who the transport sees connected, or null when it cannot tell (git). */
  presence(): { replica: string; since: string }[] | null;
  health(): TransportHealth;
}

/** The transport could not reach its remote; what it was given stays queued. */
export class TransportOffline extends Error {
  override name = 'TransportOffline';
}
