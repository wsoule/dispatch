import { speaksForHandle } from '@dispatch/federation';
import type { RosterView } from '@dispatch/federation';
import type { Address, JsonValue } from '@dispatch/protocol';
import type { DocBody, FederatedOp } from '@dispatch/protocol/federation';

import type { RosterService } from './roster.js';
import type {
  Collector,
  FederationService,
  OpHandler,
  StageContext,
} from './service.js';
import { revocationContested, standsAt } from './service.js';
import type { FedStore } from './store.js';
import { OpTooLargeError } from './store.js';
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
    // Humans only: a run or agent address is always false.
    ctx: { speaksFor(replica: string, address: Address): boolean }
  ): 'applied' | 'parked' | 'dropped';
  /** XD1b: what DocSync publishes this pass, parents before children. */
  pendingDocOps(): DocBody[];
  /** XD1b: after DocSync signed and queued them, with each op's hlc in
   *  order ('' for a body too large to publish, which stays here). */
  published(bodies: readonly DocBody[], clocks?: readonly string[]): void;
  /** XD1c: retention dropped a parked doc op. */
  parkedDropped(
    meta: { replica: string; seq: number; reason: 'overflow' | 'revoked' },
    body: JsonValue
  ): void;
  /** XD1d: a complete federation pass ended. */
  passComplete(): void;
}

// Doc ops published in one pass; the rest go next pass.
const DOC_OPS_PER_PASS = 200;

const isObj = (v: unknown): v is DocBody =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Routes `doc` ops between the federation log and the docs module.
export class DocSync implements Collector, OpHandler {
  readonly order = 6;
  readonly type = 'doc';
  // Applied doc ops count in `applied`, as task ops do, so quiescence sees them.
  readonly countsApplied = true;

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
        // One body over the op cap must not stop the rest, or the pass.
        if (!(err instanceof OpTooLargeError)) throw err;
        clocks.push('');
        const doc =
          typeof body['doc'] === 'string' ? body['doc'].slice(0, 64) : '?';
        fed.problem(
          `doc:${doc}`,
          `a change to doc ${doc} is too large to publish and stays on this machine`
        );
      }
    }
    port.published(bodies, clocks);
  }

  /** A doc op on this replica's chain. */
  publish(body: DocBody): FederatedOp {
    return this.deps.fed.append({ type: 'doc', body });
  }

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const { fed, roster, port } = this.deps;
    // Checked here too, so a parked or reread op meets the cut it waited on.
    const cut = ctx.view.revoked.get(op.replica);
    if (cut !== undefined && op.seq > cut.afterSeq) {
      if (revocationContested(fed, op.replica, ctx.view)) return 'parked';
      this.dropped(op, 'revoked');
      return 'dropped';
    }
    // An observer, or a replica that no longer stands there, changes no doc.
    if (!standsAt(ctx.view, op.replica, op.seq)) return 'dropped';
    if (!isObj(op.body)) {
      dropNote(
        fed,
        'malformed',
        op.replica,
        `${roster.label(op.replica)}'s doc op at seq ${op.seq} has no body; it was dropped`
      );
      return 'dropped';
    }
    const { view } = ctx;
    return port.applyDocOp(
      { replica: op.replica, seq: op.seq, hlc: op.hlc, body: op.body },
      {
        speaksFor: (replica, address) =>
          humanAt(view, replica, address, op.seq),
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

  /** XD1e: whether `replica` speaks for the human `address` now. Only
   *  humans count: a run or agent address is always false. */
  speaksFor(replica: string, address: Address): boolean {
    const view = this.deps.roster.view();
    return view !== null && humanAt(view, replica, address, Infinity);
  }
}

// A human address whose handle `replica` speaks for at its op `seq`
// (Infinity: now), where that replica stands.
function humanAt(
  view: RosterView,
  replica: string,
  address: string,
  seq: number
): boolean {
  if (!address.startsWith('human:')) return false;
  const at = Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
  return (
    standsAt(view, replica, at) &&
    speaksForHandle(view, replica, address.slice('human:'.length), at)
  );
}
