import type { RosterView } from '@dispatch/federation';
import { MessagingError } from '@dispatch/protocol';
import type { Delivery, DeliveryEngine, Message } from '@dispatch/protocol';
import {
  contentHash,
  fromB64u,
  hlcWallMs,
  MAX_CLOCK_LEAD_MS,
  openWithKey,
  opHash,
  unwrapContentKey,
} from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  MailPayload,
  MailTarget,
  StatePayload,
} from '@dispatch/protocol/federation';

import type { Homes } from './homes.js';
import { recordSealed } from './mail.js';
import type { RosterService } from './roster.js';
import type { InboxDrainer, OpHandler, StageContext } from './service.js';
import { speaksFor } from './speaksFor.js';
import type { FedStore } from './store.js';
import {
  dropNote,
  forwardPayload,
  isReplica,
  mailPayload,
  statePayload,
} from './validate.js';

const INBOX_MAX_ATTEMPTS = 3;
/** Verified mail ops remembered per publisher, newest first (FW-R33(1)). */
const MAIL_SEEN_PER_PUBLISHER = 100_000;
/** Queued messages one publisher may have before its mail waits parked. */
const MAX_WAITING = 1000;
/** State ops applied per clock hour from one teammate's machine. */
const STATE_OPS_PER_HOUR = 600;

/** What the inbox tells the state module (Task 16); no-ops until then. */
export interface StateHooks {
  refused(messageId: string, reason: string, origin: string): void;
  received(message: Message, origin: string, deliveries: Delivery[]): void;
}

/** Where a `state` op's opened payload goes (Task 16's StateOut). */
export interface StateApplier {
  applyState(payload: StatePayload, publisher: string, op: FederatedOp): void;
}

// One fed_inbox row's payload: a verified, decrypted message waiting for the
// engine, with the op that carried it (a forward's inner op for a forward).
interface InboxPayload {
  message: Message;
  targets: MailTarget[];
  forwardTarget?: string;
  origin: string;
  sealedTo: string[];
  op: FederatedOp;
}

interface InboxRow {
  replica: string;
  seq: number;
  hlc: string;
  payload_json: string;
  attempts: number;
}

// Mail in: each op sealed to this replica is opened, its forward checked,
// its sender checked against the replica that may speak for it, and queued in
// fed_inbox; the drain hands the queue to the engine by publisher, within an
// hourly quota, so a slow or failing message never holds the board.
export class Inbound implements OpHandler, InboxDrainer {
  readonly type = 'mail';

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      engine: DeliveryEngine;
      homes: Homes;
      perReplicaPerHour: number;
      now: () => Date;
      state?: StateHooks;
      /** Queued messages per publisher before its mail waits (tests lower it). */
      maxWaiting?: number;
      /** State ops per publisher per hour (tests lower it). */
      stateOpsPerHour?: number;
      /** Seen mail ops kept per publisher (tests lower it). */
      mailSeenKept?: number;
    }
  ) {}

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const { fed } = this.deps;
    const me = fed.replica;
    // FW-R32(2): every mail op this machine verifies is remembered, so a
    // forward can carry only an op of a publisher's real chain.
    fed.db
      .query(
        'INSERT OR IGNORE INTO fed_mail_seen (replica, seq, hash, at) VALUES (?, ?, ?, ?)'
      )
      .run(op.replica, op.seq, opHash(op), ctx.now.toISOString());
    if (!(op.to ?? []).includes(me)) return 'dropped';
    // FW-R31(5): ops above a settled revocation's cut go; a contested one
    // keeps them parked until the fight is decided.
    const cut = this.cutFor(op.replica, op.seq, ctx.view);
    if (cut !== 'stands') return cut;
    // A publisher with this much queued waits; its other ops never do.
    if (this.waiting(op.replica) >= (this.deps.maxWaiting ?? MAX_WAITING))
      return 'parked';
    const subject = `op:${op.replica}:${op.seq}`;
    const label = this.deps.roster.label(op.replica);
    const key = unwrapContentKey(op, me, fed.keys.sealPriv);
    const opened = key === null ? null : openWithKey(op, key);
    if (opened === null) {
      dropNote(
        fed,
        'mail-drop',
        op.replica,
        `mail from ${label} seq ${op.seq} could not be decrypted and was dropped`
      );
      return 'dropped';
    }
    const carried = this.carried(op, opened, ctx);
    if (carried === 'parked' || carried === 'dropped') return carried;
    const { inner, payload, forwardTarget } = carried;
    const { message } = payload;
    // FW-R32(1): held only when the message is stamped well ahead of its op
    // or of now; behind its op is a sender that published late.
    const msgMs = hlcWallMs(message.hlc ?? '') ?? 0;
    const opMs = hlcWallMs(inner.hlc) ?? 0;
    if (
      msgMs - opMs > MAX_CLOCK_LEAD_MS ||
      msgMs - ctx.now.getTime() > MAX_CLOCK_LEAD_MS
    ) {
      fed.problem(
        subject,
        `${message.id} from ${this.deps.roster.label(inner.replica)} is stamped ahead of its op or of this machine's clock, so it waits like a change from the future`
      );
      return this.park(op);
    }
    const speaks = speaksFor({
      replica: inner.replica,
      message,
      seq: inner.seq,
      view: ctx.view,
      fed,
      evidence: ctx.evidence,
    });
    if (speaks === null) return this.park(op);
    if (!speaks) {
      dropNote(
        fed,
        'mail-drop',
        op.replica,
        `${message.id} was dropped: ${this.deps.roster.label(inner.replica)} cannot speak for ${message.from}`
      );
      fed.audit('speaks-for', subject, {
        replica: inner.replica,
        seq: inner.seq,
        from: message.from,
      });
      return 'dropped';
    }
    const targets = this.checkedTargets(payload.targets, forwardTarget);
    if (targets === null) {
      dropNote(
        fed,
        'mail-drop',
        op.replica,
        `${message.id} was forwarded here for ${forwardTarget ?? ''}, which this machine does not hold`
      );
      return 'dropped';
    }
    const row: InboxPayload = {
      message,
      targets,
      ...(forwardTarget === undefined ? {} : { forwardTarget }),
      origin: inner.replica,
      sealedTo: op.to ?? [],
      op: inner,
    };
    fed.db
      .query(
        'INSERT OR IGNORE INTO fed_inbox (replica, seq, hlc, payload_json, attempts, first_at) VALUES (?, ?, ?, ?, 0, ?)'
      )
      .run(
        op.replica,
        op.seq,
        op.hlc,
        JSON.stringify(row),
        this.deps.now().toISOString()
      );
    // A held op that applies now: its note is over.
    fed.clearProblem(subject);
    return 'applied';
  }

  // Where a revocation leaves an op: 'stands', or above a cut: dropped once
  // the revocation is settled, parked while it is contested.
  private cutFor(
    replica: string,
    seq: number,
    view: RosterView
  ): 'stands' | 'parked' | 'dropped' {
    const cut = view.revoked.get(replica);
    if (cut === undefined || seq <= cut.afterSeq) return 'stands';
    return this.contested(replica, view) ? 'parked' : 'dropped';
  }

  // The origin's targets, held to this machine's roster: homes that are no
  // usable member go, this machine stays a home only where it is one here,
  // and a wakeAt off the homes goes. Null for a forward to a target this
  // machine is no home of.
  private checkedTargets(
    targets: MailTarget[],
    forwardTarget: string | undefined
  ): MailTarget[] | null {
    const { roster, fed, homes } = this.deps;
    const me = fed.replica;
    const usable = (r: string) =>
      roster.isAdmitted(r) && roster.isCovered(r) && !roster.isObserver(r);
    const out = targets.map((t) => {
      const kept = t.homes.filter(
        (h) => usable(h) && (h !== me || this.homeHere(t.recipient))
      );
      const wakeAt =
        t.wakeAt !== undefined && kept.includes(t.wakeAt)
          ? t.wakeAt
          : undefined;
      return {
        recipient: t.recipient,
        via: t.via,
        homes: kept,
        ...(wakeAt === undefined ? {} : { wakeAt }),
      };
    });
    if (forwardTarget !== undefined && !this.homeHere(forwardTarget))
      return null;
    void homes;
    return out;
  }

  // Whether this machine is a home of `recipient` by its own roster: a
  // human or agent homed here, a task whose honoured live run or assignee is
  // here, a run that runs here.
  private homeHere(recipient: string): boolean {
    const { fed, homes } = this.deps;
    const me = fed.replica;
    if (recipient.startsWith('run:')) {
      const row = fed.db
        .query<{ replica: string }, [string]>(
          'SELECT replica FROM fed_runs WHERE run = ?'
        )
        .get(recipient.slice('run:'.length));
      return row === null || row.replica === me;
    }
    if (recipient.startsWith('task:')) {
      const task = recipient.slice('task:'.length);
      const live = homes.taskLiveRun(task);
      if (live?.replica === me) return true;
      // A run here that ended as the mail came: still a holder if the task
      // is one this machine may hold.
      if (live === null && homes.mayHold(task, me)) return true;
    }
    return homes.of(recipient).includes(me);
  }

  /** Rows by (hlc, replica, seq); each publisher stops at the first row it
   *  cannot finish this pass. */
  async drain(now: Date): Promise<void> {
    const { fed, roster } = this.deps;
    // FW-R32(8): nothing is delivered while the roster is paused.
    if ((roster.view()?.unknown ?? null) !== null) return;
    this.pruneSeen();
    const hour = now.toISOString().slice(0, 13);
    const stopped = new Set<string>();
    const rows = fed.db
      .query<InboxRow, []>(
        'SELECT replica, seq, hlc, payload_json, attempts FROM fed_inbox ORDER BY hlc, replica, seq'
      )
      .all();
    for (const row of rows) {
      if (stopped.has(row.replica)) continue;
      const count =
        fed.db
          .query<{ count: number }, [string, string]>(
            'SELECT count FROM fed_quota WHERE replica = ? AND hour = ?'
          )
          .get(row.replica, hour)?.count ?? 0;
      if (count >= this.deps.perReplicaPerHour) {
        fed.problem(
          `quota:${row.replica}`,
          `${roster.label(row.replica)} sent more than ${this.deps.perReplicaPerHour} messages this hour; the rest wait`
        );
        stopped.add(row.replica);
        continue;
      }
      if (!(await this.deliver(row, hour))) stopped.add(row.replica);
    }
    for (const p of fed.problems())
      if (
        p.subject.startsWith('quota:') &&
        !stopped.has(p.subject.slice('quota:'.length))
      )
        fed.clearProblem(p.subject);
  }

  /** The `state` handler: an op sealed here is opened and applied at once,
   *  under the same cut rule as mail. */
  stateHandler(applier: StateApplier): OpHandler {
    return {
      type: 'state',
      stage: (op, ctx) => {
        const { fed } = this.deps;
        if (!(op.to ?? []).includes(fed.replica)) return 'dropped';
        const cut = this.cutFor(op.replica, op.seq, ctx.view);
        if (cut !== 'stands') return cut;
        const key = unwrapContentKey(op, fed.replica, fed.keys.sealPriv);
        const payload = statePayload(
          key === null ? null : openWithKey(op, key)
        );
        if (payload === null) {
          dropNote(
            fed,
            'malformed',
            op.replica,
            `${this.deps.roster.label(op.replica)}'s state at seq ${op.seq} could not be read; it was dropped`
          );
          return 'dropped';
        }
        // FW-R32 (T16): state ops count against their own hourly quota.
        const hour = `state:${ctx.now.toISOString().slice(0, 13)}`;
        const count =
          fed.db
            .query<{ count: number }, [string, string]>(
              'SELECT count FROM fed_quota WHERE replica = ? AND hour = ?'
            )
            .get(op.replica, hour)?.count ?? 0;
        if (count >= (this.deps.stateOpsPerHour ?? STATE_OPS_PER_HOUR))
          return 'parked';
        fed.db
          .query(
            'INSERT INTO fed_quota (replica, hour, count) VALUES (?, ?, 1) ON CONFLICT(replica, hour) DO UPDATE SET count = count + 1'
          )
          .run(op.replica, hour);
        applier.applyState(payload, op.replica, op);
        return 'applied';
      },
    };
  }

  // FW-R33(1): seen mail is pruned by count per publisher, never by age,
  // and never an op a held copy here may still forward.
  private pruneSeen(): void {
    const { db } = this.deps.fed;
    const held = new Set(
      db
        .query<{ op_json: string }, []>('SELECT op_json FROM fed_held_ops')
        .all()
        .map((r) => {
          const op = JSON.parse(r.op_json) as { replica: string; seq: number };
          return `${op.replica}:${op.seq}`;
        })
    );
    for (const { replica, n } of db
      .query<{ replica: string; n: number }, [number]>(
        'SELECT replica, COUNT(*) AS n FROM fed_mail_seen GROUP BY replica HAVING n > ?'
      )
      .all(this.deps.mailSeenKept ?? MAIL_SEEN_PER_PUBLISHER))
      for (const row of db
        .query<{ seq: number }, [string, number]>(
          'SELECT seq FROM fed_mail_seen WHERE replica = ? ORDER BY seq LIMIT ?'
        )
        .all(replica, n - (this.deps.mailSeenKept ?? MAIL_SEEN_PER_PUBLISHER)))
        if (!held.has(`${replica}:${row.seq}`))
          db.query(
            'DELETE FROM fed_mail_seen WHERE replica = ? AND seq = ?'
          ).run(replica, row.seq);
  }

  waiting(replica: string): number {
    return (
      this.deps.fed.db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM fed_inbox WHERE replica = ?'
        )
        .get(replica)?.n ?? 0
    );
  }

  // Hands one row to the engine; false leaves the publisher's later rows.
  private async deliver(row: InboxRow, hour: string): Promise<boolean> {
    const { fed, engine, state } = this.deps;
    const p = JSON.parse(row.payload_json) as InboxPayload;
    const done = () => {
      fed.db
        .query('DELETE FROM fed_inbox WHERE replica = ? AND seq = ?')
        .run(row.replica, row.seq);
    };
    try {
      const result = await engine.receive(p.message, {
        replica: p.origin,
        targets: p.targets,
        ...(p.forwardTarget === undefined
          ? {}
          : { forwardTarget: p.forwardTarget }),
      });
      fed.atomically(() => {
        done();
        fed.db
          .query(
            'INSERT INTO fed_quota (replica, hour, count) VALUES (?, ?, 1) ON CONFLICT(replica, hour) DO UPDATE SET count = count + 1'
          )
          .run(row.replica, hour);
        // Held task mail keeps its op, to follow the task's live run (Task 16).
        if (
          result.deliveries.some(
            (d) => d.state === 'held' && d.recipient.startsWith('task:')
          )
        )
          fed.db
            .query(
              'INSERT OR REPLACE INTO fed_held_ops (message_id, op_json) VALUES (?, ?)'
            )
            .run(p.message.id, JSON.stringify(p.op));
      });
      recordSealed(fed, p.message.id, [...p.sealedTo, p.origin]);
      // A holder that forwarded it here hears its delivery, as the origin
      // does; written once the receive went through (FW-R35).
      if (p.forwardTarget !== undefined)
        fed.db
          .query(
            "INSERT OR IGNORE INTO fed_published (kind, ref, hash) VALUES ('forwarder', ?, '')"
          )
          .run(`${p.message.id}\n${row.replica}`);
      state?.received(p.message, p.origin, result.deliveries);
      return true;
    } catch (err) {
      if (err instanceof MessagingError) {
        dropNote(
          fed,
          'mail-drop',
          row.replica,
          `${p.message.id} from ${this.deps.roster.label(p.origin)} was refused: ${err.message}`
        );
        fed.audit('refused-message', `message:${p.message.id}`, {
          origin: p.origin,
          code: err.code,
          reason: err.message,
        });
        done();
        state?.refused(p.message.id, `${err.code}: ${err.message}`, p.origin);
        return true;
      }
      const attempts = row.attempts + 1;
      if (attempts >= INBOX_MAX_ATTEMPTS) {
        dropNote(
          fed,
          'mail-drop',
          row.replica,
          `${p.message.id} from ${this.deps.roster.label(p.origin)} was dropped after ${INBOX_MAX_ATTEMPTS} attempts: ${err instanceof Error ? err.message : String(err)}`
        );
        done();
      } else
        fed.db
          .query(
            'UPDATE fed_inbox SET attempts = ? WHERE replica = ? AND seq = ?'
          )
          .run(attempts, row.replica, row.seq);
      return false;
    }
  }

  // The mail an op carries: its own payload, or for a forward the original
  // op, which must be one this machine verified on its publisher's chain
  // (FW-R32(2)), under its publisher's cut, with the target among its own.
  private carried(
    op: FederatedOp,
    opened: unknown,
    ctx: StageContext
  ):
    | { inner: FederatedOp; payload: MailPayload; forwardTarget?: string }
    | 'parked'
    | 'dropped' {
    const { fed, roster } = this.deps;
    const label = roster.label(op.replica);
    const malformed = (what: string) => {
      dropNote(
        fed,
        'malformed',
        op.replica,
        `${label}'s mail at seq ${op.seq} ${what}; it was dropped`
      );
      return 'dropped' as const;
    };
    const body = op.body as { forward?: unknown } | undefined;
    if (body?.forward === undefined) {
      const payload = mailPayload(opened);
      return payload === null
        ? malformed('is not a message')
        : { inner: op, payload };
    }
    const fwd = forwardPayload(opened);
    const inner = body.forward as FederatedOp;
    if (
      fwd === null ||
      typeof inner !== 'object' ||
      inner === null ||
      !isReplica(inner.replica) ||
      !Number.isSafeInteger(inner.seq) ||
      inner.type !== 'mail'
    )
      return malformed('is not a forward');
    const cut = this.cutFor(inner.replica, inner.seq, ctx.view);
    if (cut !== 'stands') return cut;
    let hash: string;
    try {
      hash = opHash(inner);
      // Its content must be what its signed header names.
      if (
        inner.sealed === undefined ||
        contentHash({ sealed: inner.sealed }) !== inner.bodyHash
      )
        return malformed('forwards an op whose content is not its own');
    } catch {
      return malformed('forwards an op that does not read');
    }
    const seen = fed.db
      .query<{ hash: string }, [string, number]>(
        'SELECT hash FROM fed_mail_seen WHERE replica = ? AND seq = ?'
      )
      .get(inner.replica, inner.seq);
    if (seen === null) {
      const head = fed.cursor(inner.replica).head?.seq ?? 0;
      if (head < inner.seq) return 'parked';
      // FW-R35(2): one this machine no longer remembers waits; a refusal
      // would lose the holder's copy, so nothing is refused here.
      if (
        fed.db
          .query<{ n: number }, [string]>(
            'SELECT COUNT(*) AS n FROM fed_mail_seen WHERE replica = ?'
          )
          .get(inner.replica)?.n ===
        (this.deps.mailSeenKept ?? MAIL_SEEN_PER_PUBLISHER)
      ) {
        dropNote(
          fed,
          'mail-drop',
          op.replica,
          `${label} forwarded an op of ${roster.label(inner.replica)}'s this machine no longer remembers; it waits`
        );
        return 'parked';
      }
      dropNote(
        fed,
        'mail-drop',
        op.replica,
        `${label} forwarded an op that is not on ${roster.label(inner.replica)}'s log; it was dropped`
      );
      fed.audit('speaks-for', `op:${op.replica}:${op.seq}`, {
        replica: op.replica,
        seq: op.seq,
        forwarded: `${inner.replica}:${inner.seq}`,
      });
      return 'dropped';
    }
    if (seen.hash !== hash) {
      dropNote(
        fed,
        'mail-drop',
        op.replica,
        `${label} forwarded an op that differs from ${roster.label(inner.replica)}'s at seq ${inner.seq}; it was dropped`
      );
      fed.audit('speaks-for', `op:${op.replica}:${op.seq}`, {
        replica: op.replica,
        seq: op.seq,
        forwarded: `${inner.replica}:${inner.seq}`,
      });
      return 'dropped';
    }
    let key: Buffer;
    try {
      key = fromB64u(fwd.key);
    } catch {
      return malformed('carries a key that does not read');
    }
    const payload = mailPayload(openWithKey(inner, key));
    if (payload === null) return malformed('forwards an op that does not open');
    if (!payload.targets.some((t) => t.recipient === fwd.target)) {
      dropNote(
        fed,
        'mail-drop',
        op.replica,
        `${label} forwarded ${payload.message.id} to ${fwd.target}, which is not one of its targets`
      );
      fed.audit('speaks-for', `op:${op.replica}:${op.seq}`, {
        replica: op.replica,
        seq: op.seq,
        forwarded: payload.message.id,
        target: fwd.target,
      });
      return 'dropped';
    }
    return { inner, payload, forwardTarget: fwd.target };
  }

  // A revocation is contested while its target published a removal the fold
  // judged: that fight can still flip it.
  private contested(replica: string, view: RosterView): boolean {
    return this.deps.fed.db
      .query<{ hash: string }, [string]>(
        'SELECT hash FROM fed_roster WHERE replica = ?'
      )
      .all(replica)
      .some((r) => view.resolution.has(r.hash));
  }

  // Parks the op; the service caps what one publisher may have waiting.
  private park(_op: FederatedOp): 'parked' {
    return 'parked';
  }
}
