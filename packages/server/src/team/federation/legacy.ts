import type { RosterView } from '@dispatch/federation';
import { canonicalize, sha256Hex } from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  LegacyAttestation,
} from '@dispatch/protocol/federation';

import type { BoardOp } from '../boardSync/engine.js';
import type { SyncLedger } from '../boardSync/ledger.js';
import type { RosterService } from './roster.js';
import type { FedStore } from './store.js';
import type { TaskChange, TaskOpSigner } from './taskOps.js';

/** sha256 over JCS(op) + "\n" for each op, in seq order. */
export function digestV1(ops: readonly BoardOp[]): string {
  const sorted = [...ops].sort((a, b) => a.seq - b.seq);
  return sha256Hex(sorted.map((o) => `${canonicalize(o)}\n`).join(''));
}

/** The unsigned v1 logs on the sync branch. */
export interface V1Log {
  /** One replica's complete lines, in file order. */
  readV1(replica: string): BoardOp[];
  /** Every ops/*.jsonl on the branch. */
  v1Replicas(): string[];
}

export interface LegacyDeps {
  ledger: SyncLedger;
  fed: FedStore;
  roster: RosterService;
  log: V1Log;
  now: () => Date;
  /** Read lazily: the signer's v1Copy is this window's, so each needs the other. */
  signer: () => TaskOpSigner;
}

const OLDER = 'is on an older Dispatch; upgrade it to join';

// The 30-day window in which machines on an older build keep syncing the board
// unsigned (spec "The legacy window"), and what happens to their lines after.
export class LegacyWindow {
  constructor(private readonly deps: LegacyDeps) {}

  private get me(): string {
    return this.deps.ledger.replica;
  }

  /** A replica's v1 log through its last complete line, or null when empty. */
  attest(replica: string): LegacyAttestation | null {
    const lines = this.deps.log.readV1(replica);
    if (lines.length === 0) return null;
    const throughSeq = Math.max(...lines.map((o) => o.seq));
    return { replica, throughSeq, digest: digestV1(lines) };
  }

  /** Every v1 log on the branch, this replica's own included. */
  attestAll(): LegacyAttestation[] {
    return this.deps.log
      .v1Replicas()
      .map((r) => this.attest(r))
      .filter((a): a is LegacyAttestation => a !== null);
  }

  /** This replica's own v1 history: its file plus its unsent outbox. */
  ownAttestation(): { throughSeq: number; digest: string } | null {
    const bySeq = new Map<number, BoardOp>();
    for (const op of this.deps.log.readV1(this.me)) bySeq.set(op.seq, op);
    for (const op of this.deps.ledger.outbox()) bySeq.set(op.seq, op);
    const ops = [...bySeq.values()];
    if (ops.length === 0) return null;
    return {
      throughSeq: Math.max(...ops.map((o) => o.seq)),
      digest: digestV1(ops),
    };
  }

  /** Founded, and no close-legacy folded. */
  open(): boolean {
    const view = this.deps.roster.view();
    return view !== null && view.legacy.closed === null;
  }

  /** TaskOpSigner's v1Copy: an older build reads the change while open. */
  v1Copy(op: FederatedOp, piece: TaskChange): void {
    if (!this.open()) return;
    this.deps.ledger.enqueueV1({
      v: 1,
      replica: this.me,
      seq: op.seq,
      hlc: op.hlc,
      ...piece,
    });
  }

  // Which v1 lines from other replicas to apply, refuse, or leave waiting
  // (cursor unmoved), by what the roster attests of each replica.
  filterV1(ops: readonly BoardOp[]): {
    apply: BoardOp[];
    refused: BoardOp[];
    waiting: Set<string>;
  } {
    const out = {
      apply: [] as BoardOp[],
      refused: [] as BoardOp[],
      waiting: new Set<string>(),
    };
    const view = this.deps.roster.view();
    if (view === null) {
      out.apply.push(...ops);
      return out;
    }
    const byReplica = new Map<string, BoardOp[]>();
    for (const op of ops) {
      const list = byReplica.get(op.replica);
      if (list === undefined) byReplica.set(op.replica, [op]);
      else list.push(op);
    }
    for (const [replica, lines] of byReplica)
      this.judge(view, replica, lines, out);
    return out;
  }

  /** After the deadline, closes the window if no close-legacy is folded. */
  maybeClose(): boolean {
    const view = this.deps.roster.view();
    if (view === null || !this.open()) return false;
    if (!view.members.has(this.me)) return false;
    if (this.deps.now().getTime() < view.legacy.deadlineMs) return false;
    const entries = this.attestAll().filter(
      (a) => this.deps.fed.pinned(a.replica) === null
    );
    this.deps.roster.closeLegacy(entries);
    return true;
  }

  // The closing race (F-D34): lines this replica applied above the bound the
  // close attested stay, and the tasks they touched are named.
  onClosed(): void {
    const closed = this.deps.roster.view()?.legacy.closed ?? null;
    if (closed === null) return;
    for (const { replica, throughSeq } of closed.entries) {
      const cursor = this.deps.ledger.cursor(replica);
      if (cursor <= throughSeq) continue;
      const tasks = [
        ...new Set(
          this.deps.log
            .readV1(replica)
            .filter((o) => o.seq > throughSeq && o.seq <= cursor)
            .map((o) => o.task)
        ),
      ];
      if (tasks.length === 0) continue;
      this.deps.fed.problem(
        `team:race:${replica}`,
        `${replica}'s changes to ${tasks.join(', ')} arrived after the legacy window closed; they stay until someone edits them`
      );
      this.deps.fed.audit('legacy-close', `replica:${replica}`, {
        replica,
        throughSeq,
        cursor,
        tasks,
      });
    }
  }

  // Re-issues, as signed task ops, what an older build on this root recorded
  // after this build's last op: seqs past seq_seen that no v2 op took.
  reissue(): FederatedOp[] {
    const { ledger, fed } = this.deps;
    const seen = fed.meta('seq_seen');
    if (seen === null) return [];
    const from = Number(seen);
    const top = ledger.lastSeq();
    if (top <= from) return [];
    const bySeq = new Map<number, BoardOp>();
    for (const op of this.deps.log.readV1(this.me)) bySeq.set(op.seq, op);
    for (const op of ledger.outbox()) bySeq.set(op.seq, op);
    const out: FederatedOp[] = [];
    for (let seq = from + 1; seq <= top; seq++) {
      const op = bySeq.get(seq);
      if (op === undefined) continue;
      out.push(...this.deps.signer().commit(changeOf(op)));
    }
    if (Number(fed.meta('seq_seen') ?? '0') < top)
      fed.setMeta('seq_seen', String(top));
    return out;
  }

  // One replica's lines, judged against the bounds the roster attests.
  private judge(
    view: RosterView,
    replica: string,
    lines: BoardOp[],
    out: { apply: BoardOp[]; refused: BoardOp[]; waiting: Set<string> }
  ): void {
    const { fed, log } = this.deps;
    const file = log.readV1(replica);
    const matches = (a: { throughSeq: number; digest: string }): boolean =>
      digestV1(file.filter((o) => o.seq <= a.throughSeq)) === a.digest;
    const found = view.legacy.attested.find((a) => a.replica === replica);
    const closing = view.legacy.closed?.entries.find(
      (a) => a.replica === replica
    );
    const pinned = fed.pinned(replica);
    const claims = [found, closing, pinned?.legacy ?? undefined].filter(
      (a): a is { throughSeq: number; digest: string } => a !== undefined
    );
    if (claims.some((a) => !matches(a))) {
      fed.problem(
        `replica:${replica}`,
        `${replica}'s v1 log was rewritten; nothing past the founding is read`
      );
      const bound =
        found !== undefined && matches(found) ? found.throughSeq : 0;
      out.apply.push(...lines.filter((o) => o.seq <= bound));
      return;
    }
    if (pinned !== null) {
      if (!view.members.has(replica)) {
        out.waiting.add(replica);
        return;
      }
      const bound = pinned.legacy?.throughSeq ?? 0;
      out.apply.push(...lines.filter((o) => o.seq <= bound));
      return;
    }
    if (found === undefined) {
      out.waiting.add(replica);
      fed.problem(`replica:${replica}`, `${replica} ${OLDER}`);
      return;
    }
    if (view.legacy.closed === null) {
      out.apply.push(...lines);
      return;
    }
    const bound = Math.max(found.throughSeq, closing?.throughSeq ?? 0);
    out.apply.push(...lines.filter((o) => o.seq <= bound));
    const refused = lines.filter((o) => o.seq > bound);
    if (refused.length === 0) return;
    out.refused.push(...refused);
    fed.problem(
      `replica:${replica}`,
      `${replica} runs a Dispatch from before team federation; its changes are refused. Upgrade it.`
    );
  }
}

// A v1 op as the change it carried, for re-issuing through the signer.
function changeOf(op: BoardOp): TaskChange {
  return {
    task: op.task,
    kind: op.kind,
    ...(op.origin === undefined ? {} : { origin: op.origin }),
    ...(op.fields === undefined ? {} : { fields: op.fields }),
    ...(op.activity === undefined ? {} : { activity: op.activity }),
  };
}
