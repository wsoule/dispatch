import type { Address, JsonValue } from '@dispatch/protocol';
import type { DocBody, FederatedOp } from '@dispatch/protocol/federation';

import type { RosterService } from './roster.js';
import type {
  Collector,
  Evidence,
  FederationService,
  OpHandler,
  StageContext,
} from './service.js';
import { speaksFor } from './speaksFor.js';
import type { FedStore } from './store.js';
import { dropNote } from './validate.js';

/**
 * The contract the docs plan's Task 20 binds to (P28, XF7, XD1): federation
 * verifies, chains, filters and orders `doc` ops; the docs module owns their
 * body and fold.
 */
export interface DocsPort {
  /** Each verified doc op, in clock order, inside the pass's transaction;
   *  'parked' keeps it in fed_parked and offers it again next pass. */
  applyDocOp(
    op: { replica: string; seq: number; hlc: string; body: DocBody },
    ctx: { speaksFor(replica: string, address: Address): boolean }
  ): 'applied' | 'parked' | 'dropped';
  /** XD1b: what DocSync publishes this pass. */
  pendingDocOps(): DocBody[];
  /** XD1b: after DocSync signed and queued them. */
  published(bodies: readonly DocBody[]): void;
  /** XD1c: retention dropped a parked doc op. */
  parkedDropped(
    meta: { replica: string; seq: number; reason: 'overflow' | 'revoked' },
    body: JsonValue
  ): void;
  /** XD1d: a complete federation pass ended. */
  passComplete(): void;
}

const NO_EVIDENCE: Evidence = { runs: new Map(), agents: new Map() };

const isObj = (v: unknown): v is DocBody =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Routes `doc` ops between the federation log and the docs module.
export class DocSync implements Collector, OpHandler {
  readonly order = 6;
  readonly type = 'doc';

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      service: FederationService;
      port: DocsPort;
    }
  ) {}

  /** XD1b: publishes what the docs port has pending, then tells it. */
  collect(): void {
    const { fed, roster, port } = this.deps;
    if (fed.head() === null || !roster.mailReady()) return;
    const bodies = port.pendingDocOps();
    if (bodies.length === 0) return;
    for (const body of bodies) this.publish(body);
    port.published(bodies);
  }

  /** A doc op on this replica's chain. */
  publish(body: DocBody): FederatedOp {
    return this.deps.fed.append({ type: 'doc', body });
  }

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const { fed, roster, port } = this.deps;
    if (!isObj(op.body)) {
      dropNote(
        fed,
        'malformed',
        op.replica,
        `${roster.label(op.replica)}'s doc op at seq ${op.seq} has no body; it was dropped`
      );
      return 'dropped';
    }
    return port.applyDocOp(
      { replica: op.replica, seq: op.seq, hlc: op.hlc, body: op.body },
      {
        speaksFor: (replica, address) =>
          this.speaksAt(replica, address, op.seq, ctx),
      }
    );
  }

  /** XD1c: retention dropped a parked doc op. */
  dropped(op: FederatedOp, reason: 'overflow' | 'revoked'): void {
    this.deps.port.parkedDropped(
      { replica: op.replica, seq: op.seq, reason },
      op.body ?? null
    );
  }

  /** XD1d. */
  passComplete(): void {
    this.deps.port.passComplete();
  }

  /** XD1e: offer those ops again next pass (a parent the fold was missing). */
  rereadOps(replica: string, seqs: readonly number[]): void {
    this.deps.service.reread(replica, seqs);
  }

  /** XD1e: whether `replica` speaks for `address` at its latest op read here. */
  speaksFor(replica: string, address: Address): boolean {
    const view = this.deps.roster.view();
    const seq = this.deps.fed.cursor(replica).head?.seq;
    if (view === null || seq === undefined) return false;
    return this.speaksAt(replica, address, seq, {
      view,
      now: new Date(),
      evidence: NO_EVIDENCE,
    });
  }

  // A run or agent whose claim has not arrived does not count.
  private speaksAt(
    replica: string,
    address: Address,
    seq: number,
    ctx: StageContext
  ): boolean {
    return (
      speaksFor({
        replica,
        message: { from: address, kind: 'message' },
        seq,
        view: ctx.view,
        fed: this.deps.fed,
        evidence: ctx.evidence,
      }) === true
    );
  }
}
