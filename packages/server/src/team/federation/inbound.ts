import type { RosterView } from '@dispatch/federation';
import { MessagingError } from '@dispatch/protocol';
import type { Delivery, DeliveryEngine, Message } from '@dispatch/protocol';
import {
  fromB64u,
  hlcWallMs,
  MAX_CLOCK_LEAD_MS,
  openWithKey,
  unwrapContentKey,
  verifyEntry,
} from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  ForwardPayload,
  MailPayload,
  MailTarget,
  StatePayload,
} from '@dispatch/protocol/federation';

import type { RosterService } from './roster.js';
import type { InboxDrainer, OpHandler, StageContext } from './service.js';
import { speaksFor } from './speaksFor.js';
import type { FedStore } from './store.js';

const INBOX_MAX_ATTEMPTS = 3;
const PARKED_MAX_PER_PUBLISHER = 10_000;

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
      perReplicaPerHour: number;
      now: () => Date;
      state?: StateHooks;
    }
  ) {}

  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped' {
    const { fed } = this.deps;
    const me = fed.replica;
    if (!(op.to ?? []).includes(me)) return 'dropped';
    // FW-R31(5): ops above a settled revocation's cut go; a contested one
    // keeps them parked until the fight is decided.
    const cut = ctx.view.revoked.get(op.replica);
    if (cut !== undefined && op.seq > cut.afterSeq)
      return this.contested(op.replica, ctx.view) ? 'parked' : 'dropped';
    const subject = `op:${op.replica}:${op.seq}`;
    const key = unwrapContentKey(op, me, fed.keys.sealPriv);
    const opened = key === null ? null : openWithKey(op, key);
    if (opened === null) {
      fed.problem(
        subject,
        `mail from ${op.replica} seq ${op.seq} could not be decrypted`
      );
      return 'dropped';
    }
    const carried = this.carried(op, opened, subject);
    if (carried === null) return 'dropped';
    const { inner, payload, forwardTarget } = carried;
    const { message } = payload;
    // FW-R31(1): the message's clock is bound to its op's.
    const msgMs = hlcWallMs(message.hlc ?? '');
    const opMs = hlcWallMs(inner.hlc) ?? 0;
    if (
      msgMs === null ||
      Math.abs(msgMs - opMs) > MAX_CLOCK_LEAD_MS ||
      msgMs - ctx.now.getTime() > MAX_CLOCK_LEAD_MS
    ) {
      fed.problem(
        subject,
        `${message.id} from ${this.deps.roster.label(inner.replica)} carries a clock far from its op's, so it waits like a change from the future`
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
      fed.problem(
        `message:${message.id}`,
        `${this.deps.roster.label(inner.replica)} cannot speak for ${message.from}`
      );
      fed.audit('speaks-for', subject, {
        replica: inner.replica,
        seq: inner.seq,
        from: message.from,
      });
      return 'dropped';
    }
    const row: InboxPayload = {
      message,
      targets: payload.targets,
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
    return 'applied';
  }

  /** Rows by (hlc, replica, seq); each publisher stops at the first row it
   *  cannot finish this pass. */
  async drain(now: Date): Promise<void> {
    const { fed, roster } = this.deps;
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
        const cut = ctx.view.revoked.get(op.replica);
        if (cut !== undefined && op.seq > cut.afterSeq)
          return this.contested(op.replica, ctx.view) ? 'parked' : 'dropped';
        const key = unwrapContentKey(op, fed.replica, fed.keys.sealPriv);
        const opened = (key === null ? null : openWithKey(op, key)) as {
          entries?: unknown;
        } | null;
        if (!Array.isArray(opened?.entries)) {
          fed.problem(
            `op:${op.replica}:${op.seq}`,
            `state from ${op.replica} seq ${op.seq} could not be read`
          );
          return 'dropped';
        }
        applier.applyState(opened as StatePayload, op.replica, op);
        return 'applied';
      },
    };
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
      state?.received(p.message, p.origin, result.deliveries);
      return true;
    } catch (err) {
      if (err instanceof MessagingError) {
        fed.problem(
          `message:${p.message.id}`,
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
        fed.problem(
          `op:${row.replica}:${row.seq}`,
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
  // op, checked against its publisher's key, and its target among the
  // original's targets. Null (with a problem) when either fails.
  private carried(
    op: FederatedOp,
    opened: unknown,
    subject: string
  ): {
    inner: FederatedOp;
    payload: MailPayload;
    forwardTarget?: string;
  } | null {
    const { fed, roster } = this.deps;
    const body = op.body as { forward?: FederatedOp } | undefined;
    if (body?.forward === undefined) {
      const payload = mailPayload(opened);
      if (payload === null) {
        fed.problem(
          subject,
          `mail from ${op.replica} seq ${op.seq} is not a message`
        );
        return null;
      }
      return { inner: op, payload };
    }
    const inner = body.forward;
    const pin = fed.pinned(inner.replica);
    const fwd = opened as Partial<ForwardPayload> | null;
    // Its signature and content hash, against its publisher's key; its
    // chain position is not this op's to vouch for.
    const signed =
      pin !== null &&
      verifyEntry(
        { seq: inner.seq - 1, hash: inner.prev, hlc: '0.0000.x' },
        inner,
        pin.signPub
      ).ok;
    const key = typeof fwd?.key === 'string' ? safeKey(fwd.key) : null;
    const payload =
      signed && key !== null ? mailPayload(openWithKey(inner, key)) : null;
    const target = typeof fwd?.target === 'string' ? fwd.target : '';
    if (payload === null) {
      fed.problem(
        subject,
        `${roster.label(op.replica)} forwarded an op that does not open`
      );
      return null;
    }
    if (!payload.targets.some((t) => t.recipient === target)) {
      fed.problem(
        subject,
        `${roster.label(op.replica)} forwarded ${payload.message.id} to ${target}, which is not one of its targets`
      );
      fed.audit('speaks-for', subject, {
        replica: op.replica,
        seq: op.seq,
        forwarded: payload.message.id,
        target,
      });
      return null;
    }
    return { inner, payload, forwardTarget: target };
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

  // Parks the op; past the cap, the publisher's oldest parked op goes.
  private park(op: FederatedOp): 'parked' {
    const { fed } = this.deps;
    const held =
      fed.db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM fed_parked WHERE replica = ?'
        )
        .get(op.replica)?.n ?? 0;
    if (held >= PARKED_MAX_PER_PUBLISHER) {
      fed.db
        .query(
          'DELETE FROM fed_parked WHERE replica = ? AND seq = (SELECT MIN(seq) FROM fed_parked WHERE replica = ?)'
        )
        .run(op.replica, op.replica);
      fed.problem(
        `op:${op.replica}:parked`,
        `${this.deps.roster.label(op.replica)} has more than ${PARKED_MAX_PER_PUBLISHER} waiting messages; the oldest was dropped`
      );
    }
    return 'parked';
  }
}

// A content key as a forward carries it, or null.
function safeKey(text: string): Buffer | null {
  try {
    return fromB64u(text);
  } catch {
    return null;
  }
}

// A MailPayload's shape, or null.
function mailPayload(value: unknown): MailPayload | null {
  const p = value as Partial<MailPayload> | null;
  const m = p?.message as Partial<Message> | undefined;
  if (
    m === undefined ||
    typeof m.id !== 'string' ||
    typeof m.from !== 'string' ||
    !Array.isArray(p?.targets)
  )
    return null;
  return p as MailPayload;
}
