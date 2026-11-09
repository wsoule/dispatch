import type { DeliveryEngine, ReceiveResult } from './engine.js';
import type { Message } from './envelope.js';
import { MessagingError } from './errors.js';
import type { RemoteTarget, SettleEntry, StateEntry } from './host.js';
import type { Delivery, MessageStore } from './store.js';

// A loopback link: two replicas on one machine, owned by one OS user (the
// machine hub and a project's dispatchd), exchanging messages through the
// engine's federation path with no sealing or relay. Each side runs one
// LoopbackLink per peer; the peer answers its `send` calls by handing the
// payloads to applyLinkMail / applyLinkState.
//
// Mail needs no watermark: a remote row stays `forwarded` until the peer
// reports a state for it, so the link sends again exactly those rows until it
// does, and the peer's engine stores each message id once.

/** One message for the peer, with the targets it homes there. */
export interface LinkMail {
  message: Message;
  targets: RemoteTarget[];
}

/** State, refusals and settlements for messages the two sides exchanged. */
export interface LinkState {
  entries: (StateEntry | SettleEntry)[];
}

/**
 * One HTTP request a person signed in to the team service sends to a project
 * daemon on their own machine: the team service frames it over the machine
 * hub's link, the hub hands it to that project's daemon, and the daemon
 * replays it on its own API at the decide tier. `body` is base64.
 */
export interface LinkHttpRequest {
  /** Which linked project: the hub's key for its root (`LinkProject.key`). */
  project: string;
  method: string;
  /** Path and query, always under `/api/`. */
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** The daemon's answer to a LinkHttpRequest; `body` is base64. */
export interface LinkHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A project daemon linked to a machine's hub, as the team service lists it. */
export interface LinkProject {
  /** A stable key for the project's root on this machine. */
  key: string;
  /** The root's last path segment, for people to recognise. */
  name: string;
}

export type LinkSend = (
  kind: 'mail' | 'state',
  body: LinkMail | LinkState
) => Promise<boolean>;

const REPORTED = ['held', 'pushed', 'notified', 'read', 'answered'];
const FLUSH_MS = 1000;
const MAX_ENTRIES = 200;

// What a stored message carries that its origin never sent: where it came from.
function withoutOrigin(message: Message): Message {
  const { origin: _origin, ...rest } = message;
  return rest;
}

export class LoopbackLink {
  private readonly pending: (StateEntry | SettleEntry)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private flushing = false;

  constructor(
    private readonly deps: {
      engine: DeliveryEngine;
      store: MessageStore;
      /** This replica's id. */
      me: string;
      /** The peer's replica id. */
      peer: string;
      send: LinkSend;
    }
  ) {}

  /** Starts listening to the engine and flushing to the peer. */
  start(): void {
    this.unsubscribe = this.deps.engine.subscribe((e) => {
      if (e.type === 'delivery') this.delivery(e.delivery);
      else if (e.type === 'message') this.settled(e.message);
      else if (e.type === 'remote') void this.flush();
    });
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer !== null) clearInterval(this.timer);
    this.unsubscribe = null;
    this.timer = null;
  }

  /** A message the peer sent was received: report its deliveries back. */
  received(message: Message, result: ReceiveResult): void {
    const now = this.deps.store.deliveries({ messageId: message.id });
    // A duplicate means the peer is resending: its row is still forwarded,
    // so it never heard the earlier report. Report every delivery again.
    const which =
      result.status === 'duplicate'
        ? now
        : result.deliveries.map((d) => now.find((n) => n.id === d.id) ?? d);
    for (const d of which) this.delivery(d, true);
  }

  /** A message the peer sent that this side refused: the peer hears why. */
  refused(messageId: string, reason: string): void {
    this.pending.push({
      t: 'refused',
      message: messageId,
      reason,
      at: new Date().toISOString(),
    });
  }

  /** Sends what is due: unacknowledged mail homed at the peer, then state. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.flushMail();
      await this.flushState();
    } finally {
      this.flushing = false;
    }
  }

  private async flushMail(): Promise<void> {
    const { store, me, peer, send } = this.deps;
    const due = new Set(
      store
        .remoteDeliveries({ states: ['forwarded'] })
        .filter((r) => r.homes.includes(peer))
        .map((r) => r.messageId)
    );
    for (const id of due) {
      const message = store.getMessage(id);
      // Only what was created here; the peer's own messages it already has.
      if (message === null || message.origin !== undefined) continue;
      const targets: RemoteTarget[] = store
        .remoteDeliveries({ messageId: id })
        .map((row) => ({
          recipient: row.recipient,
          via: row.via,
          homes: [...new Set(row.homes)].filter((h) => h !== me).sort(),
          ...(row.wakeAt === null ? {} : { wakeAt: row.wakeAt }),
        }))
        .filter((t) => t.homes.includes(peer));
      if (targets.length === 0) continue;
      if (!(await send('mail', { message: withoutOrigin(message), targets })))
        return;
    }
  }

  private async flushState(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, MAX_ENTRIES);
      if (!(await this.deps.send('state', { entries: batch }))) return;
      this.pending.splice(0, batch.length);
    }
  }

  // A delivery changed: when its message crossed this link, the peer hears.
  private delivery(d: Delivery, fromPeer = false): void {
    if (!REPORTED.includes(d.state)) return;
    const { store, peer } = this.deps;
    if (!fromPeer) {
      const message = store.getMessage(d.messageId);
      if (message === null) return;
      const viaPeer =
        message.origin === peer ||
        store
          .remoteDeliveries({ messageId: message.id })
          .some((r) => r.homes.includes(peer));
      if (!viaPeer) return;
    }
    this.pending.push({
      t: 'delivery',
      message: d.messageId,
      recipient: d.recipient,
      state: d.state as 'held' | 'pushed' | 'notified' | 'read' | 'answered',
      at: d.updatedAt,
    });
  }

  // An answer settled here for a question asked here that the peer holds.
  private settled(message: Message): void {
    const { store, me, peer } = this.deps;
    if (message.replyTo === null) return;
    const question = store.getMessage(message.replyTo);
    if (question === null || question.origin !== undefined) return;
    const s = store.settlement(question.id);
    if (s?.settler !== me || s.answerId !== message.id) return;
    const crossed =
      message.origin === peer ||
      [
        ...store.remoteDeliveries({ messageId: question.id }),
        ...store.remoteDeliveries({ messageId: message.id }),
      ].some((r) => r.homes.includes(peer));
    if (!crossed) return;
    this.pending.push({
      t: 'settle',
      question: question.id,
      answer: message.id,
      ...(s.closedReason === null ? {} : { closed: s.closedReason }),
      at: s.at,
    });
  }
}

/** Receives one message the peer sent over the link, reporting back. A
 *  message the engine refuses is reported refused, so the peer marks it and
 *  tells its sender instead of sending it again. */
export async function applyLinkMail(
  engine: DeliveryEngine,
  link: LoopbackLink,
  peer: string,
  body: LinkMail
): Promise<ReceiveResult | { status: 'refused'; reason: string }> {
  try {
    const result = await engine.receive(body.message, {
      replica: peer,
      targets: body.targets,
    });
    link.received(body.message, result);
    return result;
  } catch (err) {
    if (!(err instanceof MessagingError)) throw err;
    const id = (body.message as { id?: unknown }).id;
    if (typeof id === 'string') link.refused(id, err.message);
    return { status: 'refused', reason: err.message };
  }
}

/** Applies the peer's state entries the engine accepts from it: delivery
 *  reports and refusals for rows homed at it, settlements it made. */
export function applyLinkState(
  engine: DeliveryEngine,
  store: MessageStore,
  peer: string,
  body: LinkState
): void {
  const entries: StateEntry[] = [];
  for (const e of body.entries) {
    if (e.t === 'settle') {
      try {
        engine.applySettlement(e, peer);
      } catch (err) {
        if (!(err instanceof MessagingError)) throw err;
      }
      continue;
    }
    const rows = store.remoteDeliveries({ messageId: e.message });
    if (rows.some((r) => r.homes.includes(peer))) entries.push(e);
  }
  if (entries.length > 0) engine.applyState(entries, peer);
}
