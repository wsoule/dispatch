import { MessagingError } from '@dispatch/protocol';
import type {
  Address,
  Delivery,
  DeliveryEngine,
  Message,
  MessageStore,
  StateEntry,
} from '@dispatch/protocol';
import { MAX_STATE_ENTRIES, sealPayload } from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  MailTarget,
  StatePayload,
} from '@dispatch/protocol/federation';

import type { Homes } from './homes.js';
import { UNVERIFIABLE } from './inbound.js';
import type { MailOut } from './mail.js';
import { wasSealedTo } from './mail.js';
import type { RosterService } from './roster.js';
import type { Collector } from './service.js';
import type { FedStore } from './store.js';

/** How long a human asker waits for an answer (packages/mcp toolKit.ts). */
const HUMAN_WAIT_MS = 30 * 60 * 1000;

type Entry = StatePayload['entries'][number];
type ReportedState = Extract<StateEntry, { t: 'delivery' }>['state'];
const REPORTED: readonly string[] = [
  'held',
  'pushed',
  'notified',
  'read',
  'answered',
];

// Read and delivery state, refusals and settlements out to the replicas
// that hold the message (spec "Read and delivery state", "Answers settle at
// the question's origin"). Entries wait in fed_state_out, so a crash between
// an event and the next pass loses none.
export class StateOut implements Collector {
  readonly order = 4;

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      homes: Homes;
      engine: DeliveryEngine;
      messages: MessageStore;
      now: () => Date;
      /** A wait across machines asks for fast passes until then. */
      fast?: (until: Date) => void;
    }
  ) {
    deps.engine.subscribe((e) => {
      if (e.type === 'delivery') this.delivery(e.delivery);
      else if (e.type === 'message') this.settled(e.message);
    });
  }

  /** A remote home refused a message for every recipient it holds. */
  refused(messageId: string, reason: string, origin: string): void {
    this.queue({ t: 'refused', message: messageId, reason, at: this.at() }, [
      origin,
    ]);
  }

  /** A received message's deliveries, as the engine left them. */
  received(message: Message, _origin: string, deliveries: Delivery[]): void {
    // As stored now: a push the receive made reads pushed, not sending, and
    // the forwarder written after the receive hears it (FW-R35).
    const stored = this.deps.messages.getMessage(message.id) ?? message;
    const now = this.deps.messages.deliveries({ messageId: message.id });
    for (const d of deliveries)
      this.delivery(now.find((n) => n.id === d.id) ?? d, stored);
  }

  collect(now: Date): void {
    const { fed, roster } = this.deps;
    if (!roster.mailReady()) return;
    const rows = fed.db
      .query<{ id: number; recipients: string; entry_json: string }, []>(
        'SELECT id, recipients, entry_json FROM fed_state_out ORDER BY id'
      )
      .all();
    const groups = new Map<string, { ids: number[]; entries: Entry[] }>();
    for (const row of rows) {
      const g = groups.get(row.recipients) ?? { ids: [], entries: [] };
      g.ids.push(row.id);
      g.entries.push(JSON.parse(row.entry_json) as Entry);
      groups.set(row.recipients, g);
    }
    for (const [recipients, g] of groups) {
      const keys = new Map<string, string>();
      for (const r of recipients.split(',')) {
        const pin = fed.pinned(r);
        if (pin !== null) keys.set(r, pin.sealPub);
      }
      fed.atomically(() => {
        for (let at = 0; at < g.entries.length; at += MAX_STATE_ENTRIES)
          if (keys.size > 0)
            this.publish(g.entries.slice(at, at + MAX_STATE_ENTRIES), keys);
        for (const id of g.ids)
          fed.db.query('DELETE FROM fed_state_out WHERE id = ?').run(id);
      });
    }
    const until = this.fastUntil(now, this.agentWaitSec);
    if (until !== null) this.deps.fast?.(until);
  }

  /** The agent wait the fast pass covers; the daemon sets it from config. */
  agentWaitSec = 600;

  /** The latest end of a wait across machines: an open blocking question
   *  that is federated, inside its asker's wait. Null when none is. */
  fastUntil(now: Date, agentWaitSec: number): Date | null {
    const { engine, messages } = this.deps;
    let latest: number | null = null;
    for (const q of engine.openBlocking()) {
      const federated =
        q.origin !== undefined ||
        messages.remoteDeliveries({ messageId: q.id }).length > 0;
      if (!federated) continue;
      const wait = q.from.startsWith('human:')
        ? HUMAN_WAIT_MS
        : agentWaitSec * 1000;
      const end = Date.parse(q.createdAt) + wait;
      if (end > now.getTime() && (latest === null || end > latest))
        latest = end;
    }
    return latest === null ? null : new Date(latest);
  }

  /**
   * A state op from `publisher`: a delivery report counts only from a home
   * of its recipient, a refusal only from a replica the message went to, a
   * settle only from the question's origin (the engine checks; a refusal
   * becomes a problem and a speaks-for audit row).
   */
  applyState(payload: StatePayload, publisher: string, op: FederatedOp): void {
    const { engine, messages, fed, roster } = this.deps;
    const entries: StateEntry[] = [];
    for (const e of payload.entries) {
      if (e.t === 'delivery') {
        // FW-R35(1): sealed the message AND a home of this recipient, or the
        // machine this one handed the recipient's held copy to.
        if (
          REPORTED.includes(e.state) &&
          wasSealedTo(fed, e.message, publisher) &&
          (this.homesOf(e.recipient).includes(publisher) ||
            handedTo(fed, e.message, publisher))
        )
          entries.push(e);
      } else if (e.t === 'refused') {
        const rows = messages.remoteDeliveries({ messageId: e.message });
        if (rows.some((r) => r.homes.includes(publisher))) entries.push(e);
        // FW-R35(2): a hand-off refused because its original is gone keeps
        // the copy here and says so; any other refusal is tried again.
        if (handedTo(fed, e.message, publisher) && e.reason === UNVERIFIABLE)
          fed.problem(
            `mail-out:${e.message}`,
            `${e.message} could not be handed to ${roster.label(publisher)}'s machine: its original is no longer on the branch; it stays here`
          );
        else if (handedTo(fed, e.message, publisher))
          fed.db
            .query(
              "DELETE FROM fed_published WHERE kind = 'held-out' AND ref = ?"
            )
            .run(`${e.message}\n${publisher}`);
      } else if (e.t === 'settle') {
        try {
          engine.applySettlement(e, publisher);
        } catch (err) {
          if (!(err instanceof MessagingError)) throw err;
          const subject = `message:${e.question}`;
          fed.problem(
            subject,
            `${roster.label(publisher)} sent a settle for ${e.question}; only the question's origin settles it`
          );
          fed.audit('speaks-for', `op:${op.replica}:${op.seq}`, {
            replica: publisher,
            question: e.question,
          });
        }
      }
    }
    if (entries.length > 0) engine.applyState(entries, publisher);
  }

  // A delivery changed: a federated message's state goes to its origin and
  // the other homes that hold it.
  private delivery(d: Delivery, known?: Message): void {
    if (!REPORTED.includes(d.state)) return;
    const message = known ?? this.deps.messages.getMessage(d.messageId);
    if (message === null) return;
    const rows = this.deps.messages.remoteDeliveries({ messageId: message.id });
    if (message.origin === undefined && rows.length === 0) return;
    // The holder that forwarded it here, too: its held copy waits on this.
    const forwarders = this.deps.fed.db
      .query<{ ref: string }, [string]>(
        "SELECT ref FROM fed_published WHERE kind = 'forwarder' AND ref LIKE ? ESCAPE '\\'"
      )
      .all(`${message.id.replace(/[\\%_]/g, '\\$&')}\n%`)
      .map((r) => r.ref.slice(message.id.length + 1));
    const to = new Set<string>([
      ...rows.flatMap((r) => r.homes),
      ...forwarders,
    ]);
    // Once delivered, the forwarder has what it waits for: its row goes.
    if (forwarders.length > 0 && d.state !== 'held')
      this.deps.fed.db
        .query(
          "DELETE FROM fed_published WHERE kind = 'forwarder' AND ref LIKE ? ESCAPE '\\'"
        )
        .run(`${message.id.replace(/[\\%_]/g, '\\$&')}\n%`);
    if (message.origin !== undefined) to.add(message.origin);
    this.queue(
      {
        t: 'delivery',
        message: message.id,
        recipient: d.recipient,
        state: d.state as ReportedState,
        at: d.updatedAt,
      },
      [...to]
    );
  }

  // An answer this replica settled, for a question asked here that went to
  // other replicas: its settlement goes to every home of every participant.
  private settled(message: Message): void {
    const { messages, fed } = this.deps;
    if (message.replyTo === null) return;
    const question = messages.getMessage(message.replyTo);
    if (question === null || question.origin !== undefined) return;
    const s = messages.settlement(question.id);
    if (s?.settler !== fed.replica || s.answerId !== message.id) return;
    const rows = [
      ...messages.remoteDeliveries({ messageId: question.id }),
      ...messages.remoteDeliveries({ messageId: message.id }),
    ];
    const to = new Set<string>(rows.flatMap((r) => r.homes));
    if (message.origin !== undefined) to.add(message.origin);
    for (const a of [question.from, message.from, ...question.to])
      for (const h of this.homesOf(a)) to.add(h);
    if (to.size === 0) return;
    this.queue(
      {
        t: 'settle',
        question: question.id,
        answer: message.id,
        ...(s.closedReason === null ? {} : { closed: s.closedReason }),
        at: s.at,
      },
      [...to]
    );
  }

  // A task's homes include the replica its live run's presence names.
  private homesOf(recipient: Address): string[] {
    const homes = this.deps.homes.of(recipient);
    if (!recipient.startsWith('task:')) return homes;
    const live = this.deps.homes.taskLiveRun(recipient.slice('task:'.length));
    return live === null ? homes : [...new Set([...homes, live.replica])];
  }

  private queue(entry: Entry, to: string[]): void {
    const { fed } = this.deps;
    const recipients = [...new Set(to)].filter((r) => r !== fed.replica).sort();
    if (recipients.length === 0) return;
    fed.db
      .query('INSERT INTO fed_state_out (recipients, entry_json) VALUES (?, ?)')
      .run(recipients.join(','), JSON.stringify(entry));
  }

  private publish(entries: Entry[], keys: Map<string, string>): void {
    const { fed } = this.deps;
    fed.append({
      type: 'state',
      seal: (stamp) => {
        const { to, sealed } = sealPayload({
          replica: fed.replica,
          seq: stamp.seq,
          type: 'state',
          payload: { entries } as never,
          recipients: keys,
        });
        return { to, sealed };
      },
    });
  }

  private at(): string {
    return this.deps.now().toISOString();
  }
}

// Held task mail follows the task's live run (spec "Held task mail follows
// the live run"): when another replica's execute run holds the task, the
// origin re-publishes its held copy there and any other holder forwards the
// original op. The local copy stays until that machine reports it delivered
// (FW-R33(1)); the engine then retires it to a remote row.
export class HeldMail implements Collector {
  readonly order = 5;

  constructor(
    private readonly deps: {
      fed: FedStore;
      engine: DeliveryEngine;
      messages: MessageStore;
      mailOut: MailOut;
      homes: Homes;
    }
  ) {}

  /** Each pass: held task mail whose task now has a live run elsewhere (an
   *  assignment can come after the run), and ops no copy needs any more. */
  collect(): void {
    const { fed, messages, homes } = this.deps;
    const tasks = new Set(
      messages
        .deliveries({ states: ['held'] })
        .filter((d) => d.recipient.startsWith('task:'))
        .map((d) => d.recipient.slice('task:'.length))
    );
    for (const task of tasks) {
      const live = homes.taskLiveRun(task);
      if (live !== null && live.replica !== fed.replica)
        this.onLiveRun(task, live.replica);
    }
    for (const row of fed.db
      .query<{ message_id: string }, []>('SELECT message_id FROM fed_held_ops')
      .all())
      if (
        !messages
          .deliveries({ messageId: row.message_id, states: ['held'] })
          .some((d) => d.recipient.startsWith('task:'))
      )
        fed.db
          .query('DELETE FROM fed_held_ops WHERE message_id = ?')
          .run(row.message_id);
  }

  onLiveRun(task: string, replica: string): void {
    const { fed, messages, mailOut, homes } = this.deps;
    if (replica === fed.replica) return;
    // Only the honoured live run takes the task's mail.
    if (homes.taskLiveRun(task)?.replica !== replica) return;
    const recipient = `task:${task}`;
    for (const d of messages.deliveries({ recipient, states: ['held'] })) {
      const message = messages.getMessage(d.messageId);
      if (message === null) continue;
      // Once per message and machine: a later pass waits for the report.
      const ref = `${message.id}\n${replica}`;
      const sent = fed.db
        .query<{ ref: string }, [string]>(
          "SELECT ref FROM fed_published WHERE kind = 'held-out' AND ref = ?"
        )
        .get(ref);
      if (sent !== null) continue;
      if (message.origin === undefined) {
        const target: MailTarget = { recipient, via: d.via, homes: [replica] };
        mailOut.publish(message, [target], [replica]);
      } else {
        const held = fed.db
          .query<{ op_json: string }, [string]>(
            'SELECT op_json FROM fed_held_ops WHERE message_id = ?'
          )
          .get(message.id);
        const original =
          held === null ? null : (JSON.parse(held.op_json) as FederatedOp);
        if (original === null) continue;
        if (!(original.to ?? []).includes(replica))
          mailOut.forward(original, recipient, replica);
      }
      fed.db
        .query(
          "INSERT OR IGNORE INTO fed_published (kind, ref, hash) VALUES ('held-out', ?, '')"
        )
        .run(ref);
    }
  }
}

// Whether this machine handed `messageId`'s held task copy to `replica`.
function handedTo(fed: FedStore, messageId: string, replica: string): boolean {
  return (
    fed.db
      .query<{ ref: string }, [string]>(
        "SELECT ref FROM fed_published WHERE kind = 'held-out' AND ref = ?"
      )
      .get(`${messageId}\n${replica}`) !== null
  );
}
