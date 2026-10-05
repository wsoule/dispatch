import type { RosterView } from '@dispatch/federation';
import { speaksForHandle } from '@dispatch/federation';
import type { Address, JsonValue } from '@dispatch/protocol';
import type { DocBody, FederatedOp } from '@dispatch/protocol/federation';

import { revocationContested } from './inbound.js';
import type { RosterService } from './roster.js';
import type {
  Collector,
  FederationService,
  OpHandler,
  StageContext,
} from './service.js';
import { standsAt } from './service.js';
import type { FedStore } from './store.js';
import { OpTooLargeError } from './store.js';
import { docBody, dropNote } from './validate.js';

// Team docs ride signed `doc` ops (docs design "Team sync"). Federation
// routes, verifies, parks and re-reads them; the docs side folds them.
//
// Licensed under the Elastic License 2.0 (../LICENSE).

/** Doc op bodies published in one pass; the rest go next pass. */
const DOC_OPS_PER_PASS = 200;

/** What the docs module answers to federation (docs plan XD1, XF7). */
export interface DocsPort {
  /** A verified doc op, in clock order; 'parked' keeps it for a later pass. */
  applyDocOp(
    op: { replica: string; seq: number; hlc: string; body: DocBody },
    ctx: { speaksFor(replica: string, address: Address): boolean }
  ): 'applied' | 'parked' | 'dropped';
  /** What this pass publishes, parents before children. */
  pendingDocOps(): DocBody[];
  /** After those bodies were signed and queued, with each op's clock. */
  published(bodies: readonly DocBody[], clocks?: readonly string[]): void;
  /** Retention dropped a parked doc op. */
  parkedDropped(
    meta: { replica: string; seq: number; reason: 'overflow' | 'revoked' },
    body: JsonValue
  ): void;
  /** A complete federation pass ended. */
  passComplete(): void;
}

export class DocSync implements Collector, OpHandler {
  readonly order = 6;
  readonly type = 'doc';
  readonly countsApplied = true;

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      service: FederationService;
      port: DocsPort;
    }
  ) {}

  /** Whether `replica` speaks for a human `address` now. Only humans count. */
  speaksFor(replica: string, address: Address): boolean {
    const view = this.deps.roster.view();
    return view !== null && humanAt(view, replica, address, Infinity);
  }

  rereadOps(replica: string, seqs: readonly number[]): void {
    this.deps.service.reread(replica, seqs);
  }

  /** Signs and queues one doc op on this replica's chain. */
  publish(body: DocBody): FederatedOp {
    return this.deps.fed.append({
      type: 'doc',
      body: body as unknown as JsonValue,
    });
  }

  collect(): void {
    const { fed, roster, port } = this.deps;
    // Nothing goes out before this machine is firmly in, or from an observer.
    if (fed.head() === null || !roster.mailReady()) return;
    if (roster.isObserver(fed.replica)) return;
    const bodies = port.pendingDocOps().slice(0, DOC_OPS_PER_PASS);
    if (bodies.length === 0) return;
    const clocks: string[] = [];
    for (const body of bodies) {
      try {
        clocks.push(this.publish(body).hlc);
      } catch (err) {
        clocks.push('');
        // A body over the op cap can never go out; it must not stop the rest.
        if (!(err instanceof OpTooLargeError)) throw err;
        fed.problem(
          `doc:${body.doc}`,
          `a change to ${body.doc} is too large to publish and stays on this machine`
        );
      }
    }
    port.published(bodies, clocks);
  }

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const { fed, roster, port } = this.deps;
    const cut = ctx.view.revoked.get(op.replica);
    if (cut !== undefined && op.seq > cut.afterSeq) {
      // FW-R31(5): final once the revocation is settled.
      if (revocationContested(fed, op.replica, ctx.view)) return 'parked';
      this.dropped(op, 'revoked');
      return 'dropped';
    }
    // Observers publish no doc changes; a parked op re-checks its standing.
    if (!standsAt(ctx.view, op.replica, op.seq)) return 'dropped';
    const body = docBody(op.body);
    if (body === null) {
      dropNote(
        fed,
        'malformed',
        op.replica,
        `${roster.label(op.replica)}'s doc op at seq ${op.seq} is not a valid doc change; it was dropped`
      );
      return 'dropped';
    }
    const view = ctx.view;
    return port.applyDocOp(
      { replica: op.replica, seq: op.seq, hlc: op.hlc, body },
      {
        speaksFor: (replica, address) =>
          humanAt(view, replica, address, op.seq),
      }
    );
  }

  dropped(op: FederatedOp, reason: 'overflow' | 'revoked'): void {
    this.deps.port.parkedDropped(
      { replica: op.replica, seq: op.seq, reason },
      op.body ?? null
    );
  }

  passComplete(): void {
    this.deps.port.passComplete();
  }
}

// A human address whose handle `replica` speaks for at its op `seq`.
function humanAt(
  view: RosterView,
  replica: string,
  address: string,
  seq: number
): boolean {
  if (!address.startsWith('human:')) return false;
  const at = Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
  return speaksForHandle(view, replica, address.slice('human:'.length), at);
}
