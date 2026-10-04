import type { RosterView } from '@dispatch/federation';
import {
  canonicalize,
  compareHlc,
  parseOpHlc,
  sha256Hex,
} from '@dispatch/protocol/federation';
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
    // This build's own copy of a signed op: never one to re-issue.
    this.deps.fed.db
      .query('DELETE FROM fed_v1_minted WHERE seq = ?')
      .run(op.seq);
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
      (a) => !view.members.has(a.replica)
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
  // since this replica's key op. Read only from this root's own record of what
  // it minted (fed_v1_minted, less this build's own v1 copies), never the
  // branch (FW-R22(3)): anyone can write lines into this replica's v1 file.
  reissue(): FederatedOp[] {
    const { fed } = this.deps;
    if (fed.head() === null) return [];
    const minted = fed.db
      .query<{ seq: number; op_json: string }, []>(
        'SELECT seq, op_json FROM fed_v1_minted ORDER BY seq'
      )
      .all();
    if (minted.length === 0) return [];
    const out: FederatedOp[] = [];
    for (const row of minted) {
      const op = JSON.parse(row.op_json) as BoardOp;
      if (op.replica !== this.me) continue;
      const change = this.stillCurrent(op);
      if (change !== null) out.push(...this.deps.signer().commit(change));
    }
    const last = minted.at(-1)?.seq ?? 0;
    fed.db.query('DELETE FROM fed_v1_minted WHERE seq <= ?').run(last);
    return out;
  }

  // An older op re-signed now carries a later clock, so it keeps only the
  // fields no newer change has touched since (FW-R22 M-d); null when nothing
  // is left, with an audit row naming what was dropped.
  private stillCurrent(op: BoardOp): TaskChange | null {
    const { ledger, fed } = this.deps;
    const newer = (field: string): boolean => {
      const held = ledger.state.field(op.task, field);
      return held !== undefined && laterHlc(held.hlc, op.hlc);
    };
    const change = changeOf(op);
    const fields = Object.keys(op.fields ?? {});
    const dropped =
      op.kind === 'remove'
        ? Object.keys(ledger.state.fields(op.task)).filter(newer)
        : fields.filter(newer);
    if (dropped.length === 0) return change;
    const kept =
      op.kind === 'remove'
        ? null
        : Object.fromEntries(
            Object.entries(op.fields ?? {}).filter(([f]) => !newer(f))
          );
    const empty =
      kept === null ||
      (Object.keys(kept).length === 0 && (op.activity ?? []).length === 0);
    fed.audit('reissue', `task:${op.task}`, {
      task: op.task,
      seq: op.seq,
      dropped,
      whole: empty,
    });
    if (empty) return null;
    const { fields: _all, ...rest } = change;
    return Object.keys(kept).length === 0 ? rest : { ...rest, fields: kept };
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
        `legacy:${replica}`,
        `${replica}'s v1 log was rewritten; nothing past the founding is read`
      );
      const bound =
        found !== undefined && matches(found) ? found.throughSeq : 0;
      out.apply.push(...lines.filter((o) => o.seq <= bound));
      return;
    }
    // FW-R24(3): upgraded only once its key is admitted; a key op on its id
    // that no admit names leaves its v1 lines to the window.
    if (pinned !== null && view.members.has(replica)) {
      const bound = pinned.legacy?.throughSeq ?? 0;
      out.apply.push(...lines.filter((o) => o.seq <= bound));
      return;
    }
    if (found === undefined) {
      out.waiting.add(replica);
      fed.problem(`legacy:${replica}`, `${replica} ${OLDER}`);
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
      `legacy:${replica}`,
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

// Whether hlc reading `a` sorts after `b`, by wall time and counter.
function laterHlc(a: string, b: string): boolean {
  const pa = parseOpHlc(a);
  const pb = parseOpHlc(b);
  if (pa === null || pb === null) return a > b;
  return compareHlc(pa, pb) > 0;
}
