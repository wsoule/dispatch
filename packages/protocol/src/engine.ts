import { parseAddress, SYSTEM_ADDRESS } from './address.js';
import type { Address } from './address.js';
import { validateSendInput } from './envelope.js';
import type { Message, SendInput } from './envelope.js';
import { MessagingError } from './errors.js';
import type { MessagingHost } from './host.js';
import { renderDigestLine, renderForAgent } from './render.js';
import type { Delivery, DeliveryVia, MessageStore } from './store.js';
import { createUlidFactory } from './ulid.js';

export interface EngineLimits {
  urgentPerHour: number;
  agentTurnsPerThreadPerHour: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  urgentPerHour: 10,
  agentTurnsPerThreadPerHour: 20,
};

/** Who is sending, as the host authenticated them. */
export interface Sender {
  address: Address;
  canDecide: boolean;
}

export interface SendResult {
  message: Message;
  deliveries: Delivery[];
  /** True when `urgent` was dropped because the sender hit its quota. */
  downgraded: boolean;
}

export type EngineEvent =
  | { type: 'message'; message: Message }
  | { type: 'delivery'; delivery: Delivery };

interface Target {
  recipient: Address;
  via: DeliveryVia;
}

const HOUR_MS = 60 * 60 * 1000;

export class DeliveryEngine {
  private readonly store: MessageStore;
  private readonly host: MessagingHost;
  private readonly limits: EngineLimits;
  private readonly ulid: (nowMs: number) => string;
  private readonly listeners = new Set<(e: EngineEvent) => void>();

  constructor(opts: {
    store: MessageStore;
    host: MessagingHost;
    limits?: Partial<EngineLimits>;
    newUlid?: (nowMs: number) => string;
  }) {
    this.store = opts.store;
    this.host = opts.host;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.ulid = opts.newUlid ?? createUlidFactory();
  }

  subscribe(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Runs every subscriber for one event, in isolation: a throwing listener
  // must never fail (or half-run) the send that produced the event.
  private emit(e: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('messaging listener failed', err);
      }
    }
  }

  private id(prefix: 'm' | 'd'): string {
    return `${prefix}-${this.ulid(this.host.now().getTime()).toLowerCase()}`;
  }

  private nowIso(): string {
    return this.host.now().toISOString();
  }

  private hourAgoIso(): string {
    return new Date(this.host.now().getTime() - HOUR_MS).toISOString();
  }

  // Approved agents, humans, runs and the system may send; pending or revoked
  // agents may not. Humans and runs were authenticated by the host already.
  private authorize(sender: Sender): { muted: boolean } {
    const parsed = parseAddress(sender.address, 'from');
    if (parsed.kind !== 'agent' || sender.address === SYSTEM_ADDRESS)
      return { muted: false };
    const agent = this.store.getAgent(sender.address);
    if (agent === null || agent.status !== 'approved') {
      throw new MessagingError(
        'forbidden',
        `${sender.address} is not an approved agent`,
        'from'
      );
    }
    return { muted: agent.muted };
  }

  // Expands channels, de-duplicates (direct beats channel) and drops the
  // sender itself, including a run's own task.
  private resolveTargets(to: Address[], sender: Address): Target[] {
    const senderTask = sender.startsWith('run:')
      ? this.host.taskOfRun(sender.slice(4))
      : null;
    const isSelf = (addr: Address) =>
      addr === sender || (senderTask !== null && addr === `task:${senderTask}`);
    const byRecipient = new Map<Address, Target>();
    const add = (recipient: Address, via: DeliveryVia) => {
      if (isSelf(recipient)) return;
      const existing = byRecipient.get(recipient);
      if (
        existing === undefined ||
        (existing.via === 'channel' && via === 'direct')
      )
        byRecipient.set(recipient, { recipient, via });
    };
    to.forEach((addr, i) => {
      const parsed = parseAddress(addr, `to[${i}]`);
      if (parsed.kind !== 'channel') return add(addr, 'direct');
      const explicit = this.store.members(parsed.name);
      const implicit = this.host.implicitMembers(parsed.name);
      const known = this.store.channels().some((c) => c.name === parsed.name);
      if (!known && implicit.length === 0)
        throw new MessagingError(
          'not-found',
          `no channel ${parsed.name}`,
          `to[${i}]`
        );
      for (const member of [...explicit, ...implicit]) add(member, 'channel');
    });
    return [...byRecipient.values()];
  }

  // Picks each delivery's initial state and run, before anything is stored.
  // Push vs notify is decided later, in dispatch(). Returns null to mean "no
  // delivery for this target" — a not-live run reached only via a channel is
  // dropped silently, since the channel send as a whole must still succeed.
  private plan(target: Target, muted: boolean, field: string): Delivery | null {
    const base = {
      id: this.id('d'),
      messageId: '',
      recipient: target.recipient,
      via: target.via,
      updatedAt: this.nowIso(),
    };
    if (muted) return { ...base, runId: null, state: 'read' };
    const parsed = parseAddress(target.recipient, field);
    switch (parsed.kind) {
      case 'human':
        return { ...base, runId: null, state: 'notified' };
      case 'agent':
      case 'channel':
        return { ...base, runId: null, state: 'held' };
      case 'task': {
        const run = this.host.liveRunFor(parsed.id);
        return run === null
          ? { ...base, runId: null, state: 'held' }
          : { ...base, runId: run, state: 'sending' };
      }
      case 'run':
        if (!this.host.isLiveRun(parsed.id)) {
          if (target.via === 'channel') return null;
          throw new MessagingError(
            'invalid',
            `run ${parsed.id} is not live`,
            field
          );
        }
        return { ...base, runId: parsed.id, state: 'sending' };
    }
  }

  async send(input: SendInput, sender: Sender): Promise<SendResult> {
    const { muted } = this.authorize(sender);
    const replyTarget = input.replyTo
      ? this.store.getMessage(input.replyTo)
      : null;
    validateSendInput(input, sender.address, sender.canDecide, replyTarget);

    let urgent = input.urgent === true;
    let downgraded = false;
    if (
      urgent &&
      !sender.address.startsWith('human:') &&
      sender.address !== SYSTEM_ADDRESS
    ) {
      if (
        this.store.countFrom(sender.address, this.hourAgoIso(), true) >=
        this.limits.urgentPerHour
      ) {
        urgent = false;
        downgraded = true;
      }
    }

    const id = this.id('m');
    const message: Message = {
      id,
      thread: replyTarget?.thread ?? id,
      replyTo: input.replyTo ?? null,
      from: sender.address,
      to: [...input.to],
      kind: input.kind,
      body: input.body,
      refs: input.refs ?? [],
      urgent,
      blocking: input.blocking === true,
      wake: input.wake ?? 'none',
      createdAt: this.nowIso(),
    };
    if (input.session !== undefined) message.session = input.session;
    if (input.data !== undefined) message.data = input.data;
    if (input.choices !== undefined) message.choices = input.choices;
    else if (input.kind === 'handoff') message.choices = ['accept', 'decline'];
    if (input.choice !== undefined) message.choice = input.choice;

    const targets = this.resolveTargets(message.to, sender.address);
    const deliveries: Delivery[] = [];
    for (const t of targets) {
      const index = message.to.indexOf(t.recipient);
      const planned = this.plan(t, muted, index >= 0 ? `to[${index}]` : 'to');
      if (planned !== null) deliveries.push({ ...planned, messageId: id });
    }

    this.store.transaction(() => {
      this.store.insertMessage(message);
      for (const d of deliveries) this.store.insertDelivery(d);
    });
    this.emit({ type: 'message', message });

    const settled: Delivery[] = [];
    for (const d of deliveries) settled.push(await this.dispatch(d, message));
    return { message, deliveries: settled, downgraded };
  }

  // Runs the host hook for one freshly stored delivery and records the outcome.
  // `sending` becomes pushed/notified, or held again if the run went away.
  private async dispatch(d: Delivery, message: Message): Promise<Delivery> {
    let next = d;
    if (d.state === 'sending' && d.runId !== null) {
      const push = d.via === 'direct' || message.urgent;
      try {
        if (push)
          await this.host.push(d.runId, renderForAgent(message), message);
        else
          await this.host.notify(d.runId, renderDigestLine(message), message);
        next = {
          ...d,
          state: push ? 'pushed' : 'notified',
          updatedAt: this.nowIso(),
        };
      } catch {
        next = { ...d, state: 'held', runId: null, updatedAt: this.nowIso() };
      }
      this.store.setDelivery(next.id, next.state, next.runId, next.updatedAt);
    } else if (d.state === 'notified') {
      try {
        this.host.notifyHuman(d.recipient, message);
      } catch {
        // A failed desktop notification must not fail the send; the message is stored.
      }
    }
    this.emit({ type: 'delivery', delivery: next });
    return next;
  }
}
