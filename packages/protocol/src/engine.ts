import { isAgentAuthored, parseAddress, SYSTEM_ADDRESS } from './address.js';
import type { Address } from './address.js';
import { gateTypeOf, hasGateData } from './constants.js';
import {
  checkIdempotencyKey,
  isIdentifier,
  isSystemMarker,
  validateSendInput,
} from './envelope.js';
import type {
  JsonValue,
  Message,
  MessageKind,
  Ref,
  SendInput,
} from './envelope.js';
import { MessagingError } from './errors.js';
import type {
  DeliveryEntry,
  FederationHooks,
  MessagingHost,
  Placement,
  PolicyRequest,
  RefusedEntry,
  RemoteOrigin,
  RemoteTarget,
  SettleEntry,
  StateEntry,
  WakeResult,
} from './host.js';
import { isFederationLocalAddress, localOnlyReason } from './localOnly.js';
import type { LocalOnlyReason } from './localOnly.js';
import { firstLine, renderDigestLine, renderForAgent } from './render.js';
import type {
  Delivery,
  DeliveryState,
  DeliveryVia,
  MessageStore,
  RemoteDelivery,
  RemoteState,
  SettledAs,
  Settlement,
} from './store.js';
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

/** How a send reached the engine: `received` when a binding delivered it. */
export interface SendOptions {
  origin?: 'local' | 'received';
}

export interface SendResult {
  message: Message;
  deliveries: Delivery[];
  /** True when `urgent` was dropped because the sender hit its quota. */
  downgraded: boolean;
  /** Set when `idempotencyKey` matched an earlier send from the same sender. */
  replayed?: true;
}

export type EngineEvent =
  | { type: 'message'; message: Message }
  | { type: 'delivery'; delivery: Delivery }
  | { type: 'membership'; channel: string; member: Address; joined: boolean }
  | { type: 'remote'; messageId: string; recipient: Address };

/** What receive did: stored it (`applied`) or already held it (`duplicate`). */
export interface ReceiveResult {
  status: 'applied' | 'duplicate';
  /** The local deliveries this call made, after their push or notify. */
  deliveries: Delivery[];
}

interface Target {
  recipient: Address;
  via: DeliveryVia;
}

// How an arriving answer is stored against its question's settlement.
interface ArrivalSettle {
  kind: MessageKind;
  settledAs?: SettledAs;
  /** The question whose local deliveries become answered, or null. */
  markAnswered: string | null;
  /** This replica settles the question and records this answer as accepted. */
  recordSettlement: boolean;
  /** Demote the question's other answers before storing this one. */
  swapFirst: boolean;
  /** The accepted answer's sender, when this answer lost at the settler. */
  supersededBy: Address | null;
}

const HOUR_MS = 60 * 60 * 1000;

const SYSTEM_SENDER: Sender = { address: SYSTEM_ADDRESS, canDecide: true };

const LOCAL: Placement = { kind: 'local' };

const LOCAL_ONLY_TEXT: Record<LocalOnlyReason, string> = {
  gate: 'gates never leave the machine whose runs they guard',
  marker: 'system markers never travel between machines',
  participant: 'overseer and A2A conversations stay on their machine',
  root: 'this thread stays on the machine it started on',
};

// A remote row's order: pushed and notified tie, and refused sits below every report.
const REMOTE_RANK: Record<RemoteState, number> = {
  refused: -1,
  forwarded: 0,
  held: 1,
  pushed: 2,
  notified: 2,
  read: 3,
  answered: 4,
};

// A local delivery's order, for catching a human's device up to another's report.
const LOCAL_RANK: Record<DeliveryState, number> = {
  held: 0,
  sending: 1,
  pushed: 2,
  notified: 2,
  read: 3,
  answered: 4,
};

export class DeliveryEngine {
  private readonly store: MessageStore;
  private readonly host: MessagingHost;
  private readonly limits: EngineLimits;
  private readonly ulid: (nowMs: number) => string;
  private readonly gateTypes: ReadonlySet<string>;
  private readonly listeners = new Set<(e: EngineEvent) => void>();

  // `gateTypes` are the gate types the host implements; any other is refused.
  constructor(opts: {
    store: MessageStore;
    host: MessagingHost;
    limits?: Partial<EngineLimits>;
    newUlid?: (nowMs: number) => string;
    gateTypes?: readonly string[];
  }) {
    this.store = opts.store;
    this.host = opts.host;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.ulid = opts.newUlid ?? createUlidFactory();
    this.gateTypes = new Set(opts.gateTypes ?? ['wake']);
  }

  subscribe(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many listeners are subscribed right now, so a test can check that a
   *  subscriber's cleanup unsubscribed it. */
  get listenerCount(): number {
    return this.listeners.size;
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
    // Only humans the host authorized and the system decide.
    if (
      sender.canDecide &&
      sender.address !== SYSTEM_ADDRESS &&
      !sender.address.startsWith('human:')
    ) {
      throw new MessagingError(
        'forbidden',
        `${sender.address} cannot decide; only humans and the system do`,
        'from'
      );
    }
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

  // Expands channels, de-duplicates (direct beats channel) and drops the sender
  // itself, including a run's own task; errors name the caller's `to` entry.
  private resolveTargets(
    to: Address[],
    sender: Address,
    fields: Map<Address, string>
  ): Target[] {
    const senderTask = sender.startsWith('run:')
      ? this.host.taskOfRun(sender.slice(4))
      : null;
    const isSelf = (addr: Address) =>
      addr === sender || (senderTask !== null && addr === `task:${senderTask}`);
    const byRecipient = new Map<Address, Target>();
    // The system address (agent:dispatch) is a valid `to` — e.g. an answer
    // replying to one of its gates — but it has no run/inbox to deliver to.
    const add = (recipient: Address, via: DeliveryVia) => {
      if (isSelf(recipient) || recipient === SYSTEM_ADDRESS) return;
      const existing = byRecipient.get(recipient);
      if (
        existing === undefined ||
        (existing.via === 'channel' && via === 'direct')
      )
        byRecipient.set(recipient, { recipient, via });
    };
    for (const addr of to) {
      const field = fields.get(addr) ?? 'to';
      const parsed = parseAddress(addr, field);
      if (parsed.kind !== 'channel') {
        add(addr, 'direct');
        continue;
      }
      const explicit = this.store.members(parsed.name);
      const implicit = this.host.implicitMembers(parsed.name);
      const known = this.store.channels().some((c) => c.name === parsed.name);
      if (!known && implicit.length === 0)
        throw new MessagingError(
          'not-found',
          `no channel ${parsed.name}`,
          field
        );
      // A channel is never a member, so a stored or implicit one is skipped.
      for (const member of [...explicit, ...implicit])
        if (!member.startsWith('channel:')) add(member, 'channel');
    }
    return [...byRecipient.values()];
  }

  // A target's initial delivery; null drops an ended run only a channel reached.
  // `heldIfEnded` holds mail to an ended run instead of refusing it.
  private plan(
    target: Target,
    muted: boolean,
    field: string,
    heldIfEnded: boolean
  ): Delivery | null {
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
          if (heldIfEnded) return { ...base, runId: null, state: 'held' };
          throw new MessagingError(
            'invalid',
            `run ${parsed.id} is not live`,
            field
          );
        }
        return { ...base, runId: parsed.id, state: 'sending' };
    }
  }

  async send(
    input: SendInput,
    sender: Sender,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const { muted } = this.authorize(sender);
    // A repeated key replays before any other check, so a retried answer or a
    // retry after the breaker trips gets the first result.
    const key = input.idempotencyKey;
    if (key !== undefined) {
      checkIdempotencyKey(key);
      const prior = this.replay(sender.address, key);
      if (prior !== null) return prior;
    }
    const replyTo = input.replyTo ?? null;
    const replyTarget =
      replyTo === null ? null : this.store.getMessage(replyTo);
    // A non-participant cannot tell an existing message from an absent one;
    // an empty replyTo names no message and fails the same way.
    if (
      replyTo !== null &&
      (replyTarget === null || !this.participates(replyTarget, sender))
    ) {
      throw new MessagingError('not-found', `no message ${replyTo}`, 'replyTo');
    }
    validateSendInput(input, sender.address, sender.canDecide, replyTarget, {
      gateTypes: this.gateTypes,
      origin: options.origin ?? 'local',
    });
    await this.checkBreaker(replyTarget, sender);
    // The breaker await lets a duplicate commit first, so look again before the
    // answered check: a raced retry replays rather than meeting conflict.
    const raced = key === undefined ? null : this.replay(sender.address, key);
    if (raced !== null) return raced;
    if (
      input.kind === 'answer' &&
      replyTarget !== null &&
      this.store.answersTo(replyTarget.id).length > 0
    ) {
      throw alreadyAnswered(replyTarget.id);
    }

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
      to: this.replyRecipients(input.to, replyTarget),
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

    const fields = this.recipientFields(input.to, replyTarget);
    const { targets: placedTargets, placed } = this.place(
      this.resolveTargets(message.to, sender.address, fields),
      fields,
      replyTarget,
      message
    );
    const targets = this.admitExternal(
      placedTargets,
      fields,
      sender,
      replyTarget,
      message
    );
    const fed = this.host.federation;
    if (fed !== undefined) message.hlc = fed.hlc();
    const wakesRuns = wakesEndedRuns(message);
    const deliveries: Delivery[] = [];
    const remotes: RemoteDelivery[] = [];
    const skipWake = new Set<Address>();
    for (const t of targets) {
      const p = placed.get(t.recipient) ?? LOCAL;
      if (p.kind === 'remote') {
        remotes.push({
          messageId: id,
          recipient: t.recipient,
          via: t.via,
          state: 'forwarded',
          homes: p.homes,
          wakeAt: p.wakeAt ?? null,
          refusedBy: [],
          updatedAt: this.nowIso(),
        });
        // Exactly one replica wakes a task: the one placement named.
        if (
          p.wakeAt !== undefined &&
          fed !== undefined &&
          p.wakeAt !== fed.replica
        )
          skipWake.add(t.recipient);
        if (!p.alsoLocal) continue;
      }
      const planned = this.plan(
        t,
        muted,
        fields.get(t.recipient) ?? 'to',
        t.recipient === replyTarget?.from ||
          (wakesRuns && this.hasTask(t.recipient))
      );
      if (planned !== null) deliveries.push({ ...planned, messageId: id });
    }

    const question = message.kind === 'answer' ? replyTarget : null;
    const settledAs =
      question === null || fed === undefined
        ? null
        : this.localAnswerSettledAs(question);
    const written = this.store.transaction((): Delivery[] | SendResult => {
      // Re-checked inside the write for a writer on another connection; the
      // unique index is the last backstop.
      const prior = key === undefined ? null : this.replay(sender.address, key);
      if (prior !== null) return prior;
      if (question !== null && this.store.answersTo(question.id).length > 0)
        throw alreadyAnswered(question.id);
      this.store.insertMessage(
        message,
        key,
        settledAs === null ? undefined : { settledAs }
      );
      for (const d of deliveries) this.store.insertDelivery(d);
      for (const r of remotes) this.store.insertRemote(r);
      if (question !== null && settledAs === 'accepted' && fed !== undefined)
        this.store.putSettlement({
          questionId: question.id,
          answerId: id,
          closedReason: null,
          settler: fed.replica,
          at: this.nowIso(),
        });
      return question === null ? [] : this.markAnswered(question.id);
    });
    if (!Array.isArray(written)) return written;
    const answered = written;
    // A gate's effect lands before anyone hears of the answer; a system close
    // has none. Effects need a type this host implements and a deciding author.
    const gateType =
      question === null ? null : gateTypeOf(question, this.gateTypes);
    if (
      question !== null &&
      gateType !== null &&
      this.gateTypes.has(gateType) &&
      !isSystemMarker(message, 'x-closed') &&
      decidingAuthor(message.from)
    )
      await this.applyGate(question, message);
    this.emit({ type: 'message', message });
    for (const d of answered) this.emit({ type: 'delivery', delivery: d });
    for (const r of remotes)
      this.emit({ type: 'remote', messageId: id, recipient: r.recipient });

    const settled: Delivery[] = [];
    for (const d of deliveries)
      settled.push((await this.dispatch(d, message)).delivery);

    if (message.wake === 'request') {
      try {
        await this.runWake(message, settled, skipWake);
      } catch (err) {
        // The message is committed; a failing wake path must not fail the send.
        console.error('messaging wake failed', err);
      }
    }

    return { message, deliveries: settled, downgraded };
  }

  // A local answer in a federated thread: pending until another replica's
  // settle, or accepted and settled here when this replica asked; else unset.
  private localAnswerSettledAs(question: Message): SettledAs | null {
    if (question.origin !== undefined) return 'pending';
    return this.store.remoteDeliveries({ messageId: question.id }).length > 0
      ? 'accepted'
      : null;
  }

  // Whether `address` is a run the host places under a task: held mail to a run
  // is delivered only through its task, so a wake may hold nothing for any other.
  private hasTask(address: Address): boolean {
    return (
      address.startsWith('run:') &&
      this.host.taskOfRun(address.slice('run:'.length)) !== null
    );
  }

  // Places each non-external target and runs the one local-only check before
  // any hook admits anything; refused channel members are dropped, not errors.
  private place(
    targets: Target[],
    fields: Map<Address, string>,
    replyTarget: Message | null,
    message: Message
  ): { targets: Target[]; placed: Map<Address, Placement> } {
    const fed = this.host.federation;
    const gateData =
      hasGateData(message) ||
      (replyTarget !== null && hasGateData(replyTarget));
    const placed = new Map<Address, Placement>();
    let external = false;
    for (const t of targets) {
      if (this.isExternal(t.recipient)) {
        external = true;
        continue;
      }
      let p: Placement =
        fed === undefined ? LOCAL : fed.placement(t, message, replyTarget);
      // Gate data never goes remote, whatever the hook says: it stays local
      // where this replica is a home and is refused where it is not.
      if (gateData && p.kind === 'remote')
        p = p.alsoLocal ? LOCAL : { kind: 'refuse', reason: 'local-only' };
      placed.set(t.recipient, p);
    }
    const refused = targets.filter(
      (t) => placed.get(t.recipient)?.kind === 'refuse'
    );
    if (gateData && (external || refused.length > 0))
      throw new MessagingError(
        'forbidden',
        'gates never leave this machine',
        'data'
      );
    for (const t of refused) {
      if (t.via === 'direct')
        throw new MessagingError(
          'forbidden',
          'overseer and A2A conversations stay on this machine',
          fields.get(t.recipient) ?? 'to'
        );
    }
    return {
      targets: targets.filter(
        (t) => placed.get(t.recipient)?.kind !== 'refuse'
      ),
      placed,
    };
  }

  // Admits or drops A2A clients and peers before storing (place() has already
  // refused gate data); a refused channel member is skipped.
  private admitExternal(
    targets: Target[],
    fields: Map<Address, string>,
    sender: Sender,
    replyTarget: Message | null,
    message: Message
  ): Target[] {
    const external = (t: Target) => this.isExternal(t.recipient);
    if (!targets.some(external)) return targets;
    const out: Target[] = [];
    for (const t of targets) {
      if (!external(t)) {
        out.push(t);
        continue;
      }
      const target = {
        recipient: t.recipient,
        via: t.via,
        field: fields.get(t.recipient) ?? 'to',
      };
      try {
        const admission =
          this.host.admitExternal?.(target, sender, replyTarget, message) ??
          'deliver';
        if (admission === 'deliver') out.push(t);
      } catch (err) {
        if (t.via === 'channel' && err instanceof MessagingError) continue;
        throw err;
      }
    }
    return out;
  }

  private isExternal(address: Address): boolean {
    return (this.host.external?.(address) ?? null) !== null;
  }

  // The first send under (from, key) as send() would return it now, or null.
  private replay(from: Address, key: string): SendResult | null {
    const message = this.store.byIdemKey(from, key);
    if (message === null) return null;
    return {
      message,
      deliveries: this.store.deliveries({ messageId: message.id }),
      downgraded: false,
      replayed: true,
    };
  }

  // The address a reply actually goes to: a party to the target that is an
  // ended run is reached through its task (see deliverableAddress).
  private rewriteForReply(address: Address, target: Message | null): Address {
    return target !== null &&
      (address === target.from || target.to.includes(address))
      ? this.deliverableAddress(address)
      : address;
  }

  // A reply's recipients, with the target's sender and recipients rewritten by
  // deliverableAddress so an ended run's task (and live successor) hears it.
  private replyRecipients(to: Address[], target: Message | null): Address[] {
    if (target === null) return [...to];
    return [...new Set(to.map((a) => this.rewriteForReply(a, target)))];
  }

  // Each resolved recipient's first `to[i]` as the caller wrote it, for errors.
  private recipientFields(
    to: Address[],
    target: Message | null
  ): Map<Address, string> {
    const fields = new Map<Address, string>();
    to.forEach((address, i) => {
      const resolved = this.rewriteForReply(address, target);
      if (!fields.has(resolved)) fields.set(resolved, `to[${i}]`);
    });
    return fields;
  }

  // Participants may reply and read: the target's sender or recipients, where a
  // run also stands for its task, that task's other runs and deliveries bound to it.
  private participates(target: Message, sender: Sender): boolean {
    if (decides(sender)) return true;
    const senderRunId = sender.address.startsWith('run:')
      ? sender.address.slice(4)
      : null;
    const senderTask =
      senderRunId !== null ? this.host.taskOfRun(senderRunId) : null;
    const actsFor = (address: Address) =>
      address === sender.address ||
      (senderTask !== null &&
        (address === `task:${senderTask}` ||
          (address.startsWith('run:') &&
            this.host.taskOfRun(address.slice(4)) === senderTask)));
    if (actsFor(target.from)) return true;
    return this.store
      .deliveries({ messageId: target.id })
      .some(
        (d) =>
          actsFor(d.recipient) ||
          (senderRunId !== null && d.runId === senderRunId)
      );
  }

  // The read rule: the system, a deciding human, or a participant; an absent
  // id reads as unreadable, never as forbidden.
  canRead(messageId: string, sender: Sender): boolean {
    const message = this.store.getMessage(messageId);
    return message !== null && this.participates(message, sender);
  }

  // A thread is readable when any of its messages is, and then all of it is;
  // an absent thread has no messages, so no one reads it.
  canReadThread(threadId: string, sender: Sender): boolean {
    return this.store
      .thread(threadId)
      .some((m) => this.participates(m, sender));
  }

  // Runs the gate hook and marks it applied; a failure at either step is left
  // for recover() to replay, which is safe because onAnswered is idempotent.
  private async applyGate(
    question: Message,
    answer: Message
  ): Promise<boolean> {
    if (!decidingAuthor(answer.from)) return false;
    try {
      await this.host.onAnswered(question, answer);
    } catch (err) {
      console.error('messaging hook failed', err);
      return false;
    }
    try {
      this.store.markGateApplied(question.id, this.nowIso());
    } catch (err) {
      console.error('messaging markGateApplied failed', err);
      return false;
    }
    return true;
  }

  // Pushes or notifies one stored delivery (held again if its run went away); `won`
  // is false when another writer moved it first. `urgent` overrides a demoted flag.
  private async dispatch(
    d: Delivery,
    message: Message,
    opts: { remote?: string; urgent?: boolean } = {}
  ): Promise<{ delivery: Delivery; won: boolean }> {
    let next = d;
    if (d.state === 'sending' && d.runId !== null) {
      const push = d.via === 'direct' || (opts.urgent ?? message.urgent);
      const external = this.isExternal(message.from);
      const remote = opts.remote ?? this.remoteLabel(message);
      try {
        if (push)
          await this.host.push(
            d.runId,
            renderForAgent(message, external, remote),
            message
          );
        else
          await this.host.notify(
            d.runId,
            renderDigestLine(message, external, remote),
            message
          );
        next = {
          ...d,
          state: push ? 'pushed' : 'notified',
          updatedAt: this.nowIso(),
        };
      } catch {
        next = { ...d, state: 'held', runId: null, updatedAt: this.nowIso() };
      }
      const moved = this.store.setDelivery(
        next.id,
        next.state,
        next.runId,
        next.updatedAt,
        'sending'
      );
      if (!moved)
        return { delivery: this.store.getDelivery(d.id) ?? d, won: false };
    } else if (d.state === 'notified') {
      try {
        this.host.notifyHuman(d.recipient, message);
      } catch {
        // A failed desktop notification must not fail the send; the message is stored.
      }
    }
    this.emit({ type: 'delivery', delivery: next });
    return { delivery: next, won: true };
  }

  // The handle a remote message's origin renders as, or undefined for local mail;
  // held mail delivered later still names its replica.
  private remoteLabel(message: Message): string | undefined {
    if (message.origin === undefined) return undefined;
    return this.host.federation?.label(message.origin) ?? message.origin;
  }

  // Finishes work a crash left: re-sends or holds `sending` deliveries, replays
  // unapplied gate effects, and voids gate answers no deciding principal gave.
  async recover(): Promise<{
    retried: number;
    reverted: number;
    replayed: number;
    voided: number;
  }> {
    let retried = 0;
    let reverted = 0;
    let replayed = 0;
    let voided = 0;
    for (const d of this.store.deliveries({ states: ['sending'] })) {
      const message = this.store.getMessage(d.messageId);
      if (
        d.runId !== null &&
        message !== null &&
        this.host.isLiveRun(d.runId)
      ) {
        const { won } = await this.dispatch(d, message);
        if (won) retried++;
      } else {
        if (
          this.store.setDelivery(d.id, 'held', null, this.nowIso(), 'sending')
        )
          reverted++;
      }
    }
    for (const { question, answer } of this.store.unappliedAnsweredGates()) {
      const type = gateTypeOf(question, this.gateTypes);
      // Unknown to this build: leave it unapplied, so a build that knows it replays it.
      if (type === null || !this.gateTypes.has(type)) continue;
      if (!decidingAuthor(answer.from)) {
        if (await this.voidAndReopen(question, answer)) voided++;
        continue;
      }
      if (await this.applyGate(question, answer)) replayed++;
    }
    return { retried, reverted, replayed, voided };
  }

  // Sets an answer from anyone but a deciding human or the system aside and
  // reopens its gate; handlers key on the question id, so the question stays.
  private async voidAndReopen(
    question: Message,
    answer: Message
  ): Promise<boolean> {
    const muted = this.store.getAgent(question.from)?.muted === true;
    const reopened = this.store.transaction((): Delivery[] | null => {
      if (!this.store.voidAnswer(answer.id, question.id, this.nowIso()))
        return null;
      const out: Delivery[] = [];
      for (const d of this.store.deliveries({ messageId: question.id })) {
        if (d.state !== 'answered') continue;
        const { state, runId } = this.reopenState(d, muted);
        const next: Delivery = { ...d, state, runId, updatedAt: this.nowIso() };
        if (
          this.store.setDelivery(d.id, state, runId, next.updatedAt, 'answered')
        )
          out.push(next);
      }
      return out;
    });
    if (reopened === null) return false;
    const voidedRow = this.store.getMessage(answer.id);
    if (voidedRow !== null) this.emit({ type: 'message', message: voidedRow });
    for (const d of reopened) await this.dispatch(d, question);
    try {
      await this.send(
        {
          to: [this.host.owner(answer.from)],
          kind: 'notice',
          replyTo: question.id,
          refs: [{ type: 'message', id: answer.id }],
          body: `An answer from ${answer.from} to gate ${question.id} was set aside; only deciding humans answer gates. The gate is open again.`,
        },
        SYSTEM_SENDER
      );
    } catch (err) {
      console.error('messaging void notice failed', err);
    }
    return true;
  }

  // The state plan() would give a reopened delivery now; never throws.
  private reopenState(
    d: Delivery,
    muted: boolean
  ): { state: DeliveryState; runId: string | null } {
    try {
      const planned = this.plan(
        { recipient: d.recipient, via: d.via },
        muted,
        'to',
        true
      );
      return planned === null
        ? { state: 'held', runId: null }
        : { state: planned.state, runId: planned.runId };
    } catch {
      return { state: 'held', runId: null };
    }
  }

  getMessage(id: string): Message | null {
    return this.store.getMessage(id);
  }

  answerOf(questionId: string): Message | null {
    return this.store.answersTo(questionId)[0] ?? null;
  }

  openBlocking(): Message[] {
    return this.store.openBlocking();
  }

  /** One message's local deliveries; recipients homed elsewhere are not among them. */
  deliveriesOf(messageId: string): Delivery[] {
    return this.store.deliveries({ messageId });
  }

  thread(threadId: string): { messages: Message[]; deliveries: Delivery[] } {
    const messages = this.store.thread(threadId);
    return {
      messages,
      deliveries: messages.flatMap((m) =>
        this.store.deliveries({ messageId: m.id })
      ),
    };
  }

  inbox(
    recipient: Address,
    states?: DeliveryState[]
  ): { delivery: Delivery; message: Message }[] {
    return this.store.deliveries({ recipient, states }).flatMap((delivery) => {
      const message = this.store.getMessage(delivery.messageId);
      return message === null ? [] : [{ delivery, message }];
    });
  }

  markRead(deliveryId: string): Delivery {
    const d = this.store.getDelivery(deliveryId);
    if (d === null)
      throw new MessagingError(
        'not-found',
        `no delivery ${deliveryId}`,
        'deliveryId'
      );
    if (d.state === 'answered' || d.state === 'read') return d;
    const next: Delivery = { ...d, state: 'read', updatedAt: this.nowIso() };
    if (
      !this.store.setDelivery(
        next.id,
        next.state,
        next.runId,
        next.updatedAt,
        d.state
      )
    )
      return this.store.getDelivery(d.id) ?? d;
    this.emit({ type: 'delivery', delivery: next });
    return next;
  }

  // Channels hold tasks and actors, not runs or channels: membership must
  // outlive a run, and no channel is ever a recipient.
  join(channel: string, member: Address): void {
    parseAddress(`channel:${channel}`, 'channel');
    const parsed = parseAddress(member, 'member');
    if (parsed.kind === 'run') {
      throw new MessagingError(
        'invalid',
        'channels hold tasks and actors, not runs — join as task:<id>',
        'member'
      );
    }
    if (parsed.kind === 'channel') {
      throw new MessagingError(
        'invalid',
        'channels hold tasks and actors, not channels',
        'member'
      );
    }
    const added = this.store.transaction(() => {
      this.store.ensureChannel(channel, this.nowIso(), false);
      return this.store.addMember(channel, member, this.nowIso());
    });
    if (added) this.emit({ type: 'membership', channel, member, joined: true });
  }

  leave(channel: string, member: Address): boolean {
    const removed = this.store.removeMember(channel, member);
    if (removed)
      this.emit({ type: 'membership', channel, member, joined: false });
    return removed;
  }

  // Where a reply or notice for `address` goes: a run not live here is reached
  // through its task, whichever replica runs it; other addresses are as given.
  deliverableAddress(address: Address): Address {
    if (!address.startsWith('run:')) return address;
    const runId = address.slice('run:'.length);
    if (this.host.isLiveRun(runId)) return address;
    const task = this.host.taskOfRun(runId);
    if (task !== null) return `task:${task}`;
    const remote = this.host.federation?.remoteRunTask(runId) ?? null;
    return remote === null ? address : `task:${remote}`;
  }

  async reply(
    messageId: string,
    input: {
      body: string;
      choice?: string;
      refs?: Ref[];
      data?: JsonValue;
      session?: string;
    },
    sender: Sender
  ): Promise<SendResult> {
    // Authorize before the lookup, so a refused sender cannot probe for ids.
    this.authorize(sender);
    const target = this.store.getMessage(messageId);
    if (target === null)
      throw new MessagingError(
        'not-found',
        `no message ${messageId}`,
        'replyTo'
      );
    const asking = target.kind === 'question' || target.kind === 'handoff';
    return this.send(
      {
        ...input,
        to: [target.from],
        kind: asking ? 'answer' : 'message',
        replyTo: messageId,
      },
      sender
    );
  }

  // A system answer that skips validation and placement — used when the host
  // itself is closing out a question (e.g. the asking run ended).
  close(questionId: string, reason: string): Message {
    const target = this.store.getMessage(questionId);
    if (target === null)
      throw new MessagingError(
        'not-found',
        `no message ${questionId}`,
        'replyTo'
      );
    if (target.kind !== 'question' && target.kind !== 'handoff')
      throw new MessagingError(
        'invalid',
        `${questionId} is a ${target.kind}, not a question or handoff`,
        'replyTo'
      );
    if (this.answerOf(questionId) !== null) throw alreadyAnswered(questionId);
    const id = this.id('m');
    const answer: Message = {
      id,
      thread: target.thread,
      replyTo: questionId,
      from: SYSTEM_ADDRESS,
      to: [target.from],
      kind: 'answer',
      body: `Closed: ${reason}`,
      refs: [],
      data: { type: 'x-closed', reason },
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: this.nowIso(),
    };
    // Clocked like a send, so the close sorts after its question in the thread.
    const fed = this.host.federation;
    if (fed !== undefined) answer.hlc = fed.hlc();
    const answered = this.store.transaction(() => {
      this.store.insertMessage(answer);
      return this.markAnswered(questionId);
    });
    this.emit({ type: 'message', message: answer });
    for (const d of answered) this.emit({ type: 'delivery', delivery: d });
    return answer;
  }

  // Moves a question's deliveries to answered and returns the moved rows, so
  // the caller can emit them once its transaction has committed.
  private markAnswered(questionId: string): Delivery[] {
    const moved: Delivery[] = [];
    for (const d of this.store.deliveries({ messageId: questionId })) {
      if (d.state === 'answered') continue;
      const next: Delivery = {
        ...d,
        state: 'answered',
        updatedAt: this.nowIso(),
      };
      if (
        this.store.setDelivery(
          next.id,
          next.state,
          next.runId,
          next.updatedAt,
          d.state
        )
      )
        moved.push(next);
    }
    return moved;
  }

  // Re-binds held deliveries for a task — addressed to the task or stranded on
  // one of its earlier runs — to its new run, and pushes or notifies them.
  async deliverHeld(runId: string, taskId: string): Promise<Delivery[]> {
    const claimed = this.store.transaction(() => {
      const held = [
        ...this.store.deliveries({
          recipient: `task:${taskId}`,
          states: ['held'],
        }),
        ...this.store
          .deliveries({ recipientPrefix: 'run:', states: ['held'] })
          .filter((d) => this.host.taskOfRun(d.recipient.slice(4)) === taskId),
      ];
      const out: { bound: Delivery; message: Message }[] = [];
      for (const d of held) {
        const message = this.store.getMessage(d.messageId);
        if (message === null) continue;
        const bound: Delivery = {
          ...d,
          state: 'sending',
          runId,
          updatedAt: this.nowIso(),
        };
        const won = this.store.setDelivery(
          bound.id,
          bound.state,
          bound.runId,
          bound.updatedAt,
          'held'
        );
        if (won) out.push({ bound, message });
      }
      return out;
    });
    const out: Delivery[] = [];
    for (const { bound, message } of claimed)
      out.push((await this.dispatch(bound, message)).delivery);
    return out;
  }

  private requireFederation(): FederationHooks {
    const fed = this.host.federation;
    if (fed === undefined) throw new Error('this host does not federate');
    return fed;
  }

  // send()'s counterpart for a message another replica created (the router has
  // verified it): applies the engine's rules and delivers what is homed here.
  async receive(
    message: Message,
    origin: RemoteOrigin
  ): Promise<ReceiveResult> {
    const fed = this.requireFederation();
    checkReceivedEnvelope(message);
    // Before the duplicate path too, so a forward never reaches such a target.
    checkReceivedTargets(origin);
    const stored = this.store.getMessage(message.id);
    if (stored !== null) {
      if (!sameSignedContent(stored, this.store.settledAs(stored.id), message))
        throw new MessagingError(
          'conflict',
          `message id ${message.id} was reused with other content`,
          'id'
        );
      return {
        status: 'duplicate',
        deliveries: await this.applyForward(stored, origin),
      };
    }
    const replyTarget =
      message.replyTo === null ? null : this.store.getMessage(message.replyTo);
    checkReceivedThread(message, replyTarget);
    const root =
      message.thread === message.id
        ? null
        : this.store.getMessage(message.thread);
    const local = localOnlyReason(message, replyTarget, root);
    if (local !== null)
      throw new MessagingError(
        'forbidden',
        LOCAL_ONLY_TEXT[local],
        local === 'gate' ? 'data' : 'to'
      );
    const { muted } = this.authorizeRemote(message, origin.replica);
    if (replyTarget !== null)
      this.authorizeRemoteReply(replyTarget, message.from, origin, fed);
    // Received mode keeps a peer's newer ref types; a missing parent skips
    // only the checks that need it.
    validateSendInput(toSendInput(message), message.from, false, replyTarget, {
      gateTypes: this.gateTypes,
      origin: 'received',
      parentOptional: true,
    });
    const sender: Sender = { address: message.from, canDecide: false };
    await this.checkBreaker(replyTarget, sender, true);
    // Per origin, so a remote agent:dispatch never shares the local system's count.
    const demote =
      message.urgent &&
      !message.from.startsWith('human:') &&
      this.store.countFrom(
        message.from,
        this.hourAgoIso(),
        true,
        origin.replica
      ) >= this.limits.urgentPerHour;
    const answer = this.settleOnArrival(message, replyTarget);
    // Settles that arrived before this question: only its origin's counts.
    const asking = message.kind === 'question' || message.kind === 'handoff';
    const early = this.store.earlySettlements(message.id);
    const valid = asking
      ? (early.find((s) => s.settler === origin.replica) ?? null)
      : null;
    const refused = early.filter((s) => s !== valid);
    const closeHlc =
      valid !== null && valid.closedReason !== null ? fed.hlc() : undefined;

    const deliveries: Delivery[] = [];
    const remotes: RemoteDelivery[] = [];
    const seen = new Set<Address>();
    for (const t of origin.targets) {
      if (t.recipient === SYSTEM_ADDRESS || seen.has(t.recipient)) continue;
      seen.add(t.recipient);
      const mine =
        t.homes.includes(fed.replica) || origin.forwardTarget === t.recipient;
      if (!mine) {
        remotes.push(remoteRow(message.id, t, this.nowIso()));
        continue;
      }
      const planned = this.planRemote(t, muted);
      if (deliveries.some((d) => d.recipient === planned.recipient)) continue;
      deliveries.push({ ...planned, messageId: message.id });
    }
    const storedMessage: Message = {
      ...message,
      kind: answer.kind,
      origin: origin.replica,
    };
    const changed: string[] = [];
    const answered = this.store.transaction((): Delivery[] | null => {
      if (this.store.getMessage(message.id) !== null) return null; // a concurrent receive won
      if (answer.swapFirst && message.replyTo !== null)
        changed.push(...this.swapSettled(message.replyTo, message.id));
      this.store.insertMessage(storedMessage, undefined, {
        receivedAt: this.nowIso(),
        ...(answer.settledAs === undefined
          ? {}
          : { settledAs: answer.settledAs }),
      });
      for (const d of deliveries) this.store.insertDelivery(d);
      for (const r of remotes) this.store.insertRemote(r);
      if (answer.recordSettlement && message.replyTo !== null)
        this.store.putSettlement({
          questionId: message.replyTo,
          answerId: message.id,
          closedReason: null,
          settler: fed.replica,
          at: this.nowIso(),
        });
      if (early.length > 0) this.store.clearEarlySettlements(message.id);
      const honoured =
        valid === null
          ? []
          : this.honourSettlement(storedMessage, valid, changed, closeHlc);
      // An answer that arrived first already answers this question here.
      const answeredFirst =
        asking && this.store.answersTo(message.id).length > 0
          ? this.markAnswered(message.id)
          : [];
      return [
        ...honoured,
        ...answeredFirst,
        ...(answer.markAnswered === null
          ? []
          : this.markAnswered(answer.markAnswered)),
      ];
    });
    if (answered === null) return { status: 'duplicate', deliveries: [] };
    this.emit({ type: 'message', message: storedMessage });
    this.emitChanged(changed, message.id);
    for (const d of answered) this.emit({ type: 'delivery', delivery: d });
    for (const r of remotes)
      this.emit({
        type: 'remote',
        messageId: r.messageId,
        recipient: r.recipient,
      });

    // A delivery the transaction already moved to answered is not dispatched.
    const moved = new Map(answered.map((d) => [d.id, d]));
    const label = fed.label(origin.replica);
    const settled: Delivery[] = [];
    for (const d of deliveries) {
      const done = moved.get(d.id);
      settled.push(
        done ??
          (
            await this.dispatch(d, storedMessage, {
              remote: label,
              urgent: !demote && message.urgent,
            })
          ).delivery
      );
    }
    try {
      for (const s of refused)
        fed.problem(
          `message:${message.id}`,
          `${s.settler} sent a settle for ${message.id}; only the question's origin settles it`
        );
      if (answer.supersededBy !== null)
        await this.noticeTo(
          message.from,
          message,
          `${message.id} was already answered by ${answer.supersededBy}; yours was kept as a reply.`
        );
      if (storedMessage.wake === 'request') {
        // Exactly one replica wakes a task: the one the origin named in wakeAt.
        const wakeHere = new Set(
          origin.targets
            .filter((t) => t.wakeAt === fed.replica)
            .map((t) => t.recipient)
        );
        const skip = new Set(
          settled.map((d) => d.recipient).filter((r) => !wakeHere.has(r))
        );
        await this.runWake(storedMessage, settled, skip);
      }
    } catch (err) {
      // The message is committed; a failing notice or wake must not fail receive.
      console.error('messaging receive follow-up failed', err);
    }
    return { status: 'applied', deliveries: settled };
  }

  // A forward of a message already stored here: delivers its one target here,
  // once, and only in place of its remote row, which the same write retires.
  private async applyForward(
    stored: Message,
    origin: RemoteOrigin
  ): Promise<Delivery[]> {
    if (origin.forwardTarget === undefined) return [];
    const target = origin.targets.find(
      (t) => t.recipient === origin.forwardTarget
    );
    if (target === undefined) return [];
    const muted = this.store.getAgent(stored.from)?.muted === true;
    const planned: Delivery = {
      ...this.planRemote(target, muted),
      messageId: stored.id,
    };
    const inserted = this.store.transaction(() => {
      const existing = this.store.deliveries({
        messageId: stored.id,
        recipient: planned.recipient,
      });
      if (existing.length > 0) return false;
      if (!this.store.deleteRemote(stored.id, target.recipient)) return false;
      this.store.insertDelivery(planned);
      return true;
    });
    if (!inserted) return [];
    return [(await this.dispatch(planned, stored)).delivery];
  }

  // A remote agent must be approved here; another replica's system may send
  // only notices about mail it exchanged with this one.
  private authorizeRemote(
    message: Message,
    replica: string
  ): { muted: boolean } {
    const parsed = parseAddress(message.from, 'from');
    if (message.from === SYSTEM_ADDRESS) {
      const about =
        message.kind === 'notice' &&
        message.data === undefined &&
        message.refs.length > 0 &&
        message.refs.every(
          (r) => r.type === 'message' && this.exchangedWith(r.id, replica)
        );
      if (!about)
        throw new MessagingError(
          'forbidden',
          `${SYSTEM_ADDRESS} from another machine may only send notices about messages exchanged with it`,
          'from'
        );
      return { muted: false };
    }
    if (parsed.kind === 'task' || parsed.kind === 'channel')
      throw new MessagingError(
        'forbidden',
        `${message.from} cannot send`,
        'from'
      );
    if (parsed.kind !== 'agent') return { muted: false };
    const agent = this.store.getAgent(message.from);
    if (agent === null || agent.status !== 'approved')
      throw new MessagingError(
        'forbidden',
        `${message.from} is not an approved agent`,
        'from'
      );
    return { muted: agent.muted };
  }

  // Whether `replica` created the message, or homes one of its recipients.
  private exchangedWith(messageId: string, replica: string): boolean {
    const m = this.store.getMessage(messageId);
    if (m === null) return false;
    return (
      m.origin === replica ||
      this.store
        .remoteDeliveries({ messageId })
        .some((r) => r.homes.includes(replica))
    );
  }

  // A remote reply's sender must act for the target's sender or a recipient (here
  // or remote), or be a human whose replica homes one; never for this system.
  private authorizeRemoteReply(
    target: Message,
    from: Address,
    origin: RemoteOrigin,
    fed: FederationHooks
  ): void {
    const taskOf = (runId: string) =>
      this.host.taskOfRun(runId) ?? fed.remoteRunTask(runId);
    const fromTask = from.startsWith('run:')
      ? taskOf(from.slice('run:'.length))
      : null;
    const actsFor = (address: Address): boolean => {
      if (address === SYSTEM_ADDRESS)
        return from === SYSTEM_ADDRESS && target.origin === origin.replica;
      if (address === from) return true;
      if (fromTask === null) return false;
      return (
        address === `task:${fromTask}` ||
        (address.startsWith('run:') &&
          taskOf(address.slice('run:'.length)) === fromTask)
      );
    };
    const remoteRows = this.store.remoteDeliveries({ messageId: target.id });
    const participant =
      actsFor(target.from) ||
      target.to.some(actsFor) ||
      this.store
        .deliveries({ messageId: target.id })
        .some((d) => actsFor(d.recipient)) ||
      remoteRows.some((r) => actsFor(r.recipient)) ||
      (from.startsWith('human:') &&
        remoteRows.some((r) => r.homes.includes(origin.replica)));
    if (!participant)
      throw new MessagingError(
        'forbidden',
        `${from} is not a participant of ${target.id}`,
        'replyTo'
      );
  }

  // A received target's first delivery, as plan() gives it, except that a run
  // not live here is reached through its task or else held; never throws.
  private planRemote(t: RemoteTarget, muted: boolean): Delivery {
    const recipient = this.deliverableAddress(t.recipient);
    const held: Delivery = {
      id: this.id('d'),
      messageId: '',
      recipient,
      runId: null,
      via: t.via,
      state: 'held',
      updatedAt: this.nowIso(),
    };
    if (muted) return { ...held, state: 'read' };
    if (recipient.startsWith('run:')) {
      const runId = recipient.slice('run:'.length);
      return this.host.isLiveRun(runId)
        ? { ...held, runId, state: 'sending' }
        : held;
    }
    try {
      return this.plan({ recipient, via: t.via }, false, 'to', true) ?? held;
    } catch {
      return held;
    }
  }

  // At the settler the first answer is accepted and later ones superseded;
  // elsewhere the first is pending and the rest candidates, unless already settled.
  private settleOnArrival(
    message: Message,
    question: Message | null
  ): ArrivalSettle {
    const plain: ArrivalSettle = {
      kind: message.kind,
      markAnswered: null,
      recordSettlement: false,
      swapFirst: false,
      supersededBy: null,
    };
    if (message.kind !== 'answer' || message.replyTo === null) return plain;
    const first = this.store.answersTo(message.replyTo)[0] ?? null;
    if (question !== null && question.origin === undefined) {
      if (first === null)
        return {
          ...plain,
          settledAs: 'accepted',
          markAnswered: question.id,
          recordSettlement: true,
        };
      return {
        ...plain,
        kind: 'message',
        settledAs: 'superseded',
        supersededBy: first.from,
      };
    }
    const settlement =
      question === null ? null : this.store.settlement(question.id);
    if (question !== null && settlement !== null) {
      if (settlement.answerId === message.id)
        return {
          ...plain,
          settledAs: 'accepted',
          markAnswered: question.id,
          swapFirst: true,
        };
      return { ...plain, kind: 'message', settledAs: 'superseded' };
    }
    if (first === null)
      return {
        ...plain,
        settledAs: 'pending',
        markAnswered: question?.id ?? null,
      };
    return { ...plain, kind: 'message', settledAs: 'candidate' };
  }

  // Merges reports from other homes: remote rows take the maximum, a human's
  // other devices catch up to read or answered, and a task's other homes retire.
  applyState(entries: StateEntry[], publisher: string): void {
    const fed = this.requireFederation();
    const events: EngineEvent[] = [];
    const notices: { to: Address; about: Message; body: string }[] = [];
    this.store.transaction(() => {
      for (const e of entries) {
        if (e.t === 'delivery') this.mergeDelivery(e, publisher, events);
        else this.mergeRefused(e, publisher, fed, events, notices);
      }
    });
    for (const e of events) this.emit(e);
    for (const n of notices)
      void this.noticeTo(n.to, n.about, n.body).catch((err: unknown) =>
        console.error('messaging refusal notice failed', err)
      );
  }

  // One home's delivery report: its remote row moves up, a local human
  // delivery catches up, and a local held task copy retires to a remote row.
  private mergeDelivery(
    e: DeliveryEntry,
    publisher: string,
    events: EngineEvent[]
  ): void {
    const now = this.nowIso();
    const where = { messageId: e.message, recipient: e.recipient };
    for (const row of this.store.remoteDeliveries(where)) {
      if (!row.homes.includes(publisher)) continue;
      const state = maxRemote(row.state, e.state);
      if (state === row.state) continue;
      const patch =
        row.state === 'refused' ? { state, refusedBy: [] } : { state };
      if (
        this.store.setRemote(
          row.messageId,
          row.recipient,
          patch,
          now,
          row.state
        )
      )
        events.push({ type: 'remote', ...where });
    }
    for (const d of this.store.deliveries(where)) {
      if (d.recipient.startsWith('human:')) {
        if (e.state !== 'read' && e.state !== 'answered') continue;
        if (LOCAL_RANK[e.state] <= LOCAL_RANK[d.state]) continue;
        if (this.store.setDelivery(d.id, e.state, d.runId, now, d.state))
          events.push({
            type: 'delivery',
            delivery: { ...d, state: e.state, updatedAt: now },
          });
      } else if (
        d.recipient.startsWith('task:') &&
        d.state === 'held' &&
        REMOTE_RANK[e.state] >= REMOTE_RANK.pushed
      ) {
        this.store.deleteDelivery(d.id);
        this.putRemote(d, [publisher], e.state, now);
        events.push({ type: 'remote', ...where });
      }
    }
  }

  // One home refused a message sent here: once every home of a recipient has,
  // its row is refused and the sender told; a pending local answer reopens.
  private mergeRefused(
    e: RefusedEntry,
    publisher: string,
    fed: FederationHooks,
    events: EngineEvent[],
    notices: { to: Address; about: Message; body: string }[]
  ): void {
    const message = this.store.getMessage(e.message);
    if (message === null || message.origin !== undefined) return;
    const now = this.nowIso();
    let newlyRefused = false;
    for (const row of this.store.remoteDeliveries({ messageId: message.id })) {
      if (!row.homes.includes(publisher) || row.refusedBy.includes(publisher))
        continue;
      const refusedBy = [...row.refusedBy, publisher];
      const all = row.homes.every((h) => refusedBy.includes(h));
      const state: RemoteState = all ? 'refused' : row.state;
      if (
        !this.store.setRemote(
          row.messageId,
          row.recipient,
          { state, refusedBy },
          now,
          row.state
        )
      )
        continue;
      events.push({
        type: 'remote',
        messageId: row.messageId,
        recipient: row.recipient,
      });
      if (all && row.state !== 'refused') newlyRefused = true;
    }
    if (newlyRefused && message.from !== SYSTEM_ADDRESS)
      notices.push({
        to: message.from,
        about: message,
        body: `${message.id} was refused by ${fed.label(publisher)}'s machine: ${e.reason}.`,
      });
    // Only the question's settler can refuse an answer as already answered.
    const question =
      message.replyTo === null ? null : this.store.getMessage(message.replyTo);
    if (
      question === null ||
      question.origin !== publisher ||
      this.store.settledAs(message.id) !== 'pending'
    )
      return;
    this.store.setSettled(message.id, 'message', null);
    events.push({ type: 'message', message: { ...message, kind: 'message' } });
    for (const d of this.store.deliveries({
      messageId: question.id,
      states: ['answered'],
    })) {
      const state: DeliveryState = d.recipient.startsWith('human:')
        ? 'notified'
        : 'held';
      if (this.store.setDelivery(d.id, state, null, now, 'answered'))
        events.push({
          type: 'delivery',
          delivery: { ...d, state, runId: null, updatedAt: now },
        });
    }
  }

  // Only the settler is believed; a settle for a question not stored yet waits,
  // per publisher, until the question arrives and names its origin.
  applySettlement(entry: SettleEntry, publisher: string): void {
    const fed = this.requireFederation();
    const record: Settlement = {
      questionId: entry.question,
      answerId: entry.answer,
      closedReason: entry.closed ?? null,
      settler: publisher,
      at: entry.at,
    };
    const q = this.store.getMessage(entry.question);
    if (q === null) {
      this.store.putEarlySettlement(record);
      return;
    }
    if ((q.origin ?? fed.replica) !== publisher)
      throw new MessagingError(
        'forbidden',
        `${publisher} did not ask ${entry.question}`,
        'question'
      );
    const closeHlc = entry.closed === undefined ? undefined : fed.hlc();
    const changed: string[] = [];
    const moved = this.store.transaction(() =>
      this.honourSettlement(q, record, changed, closeHlc)
    );
    this.emitChanged(changed);
    for (const d of moved) this.emit({ type: 'delivery', delivery: d });
  }

  // Records a settler's outcome for a stored question and applies it: swaps in
  // its answer, or writes its close; an answer not here yet waits to land.
  private honourSettlement(
    q: Message,
    s: Settlement,
    changed: string[],
    closeHlc: string | undefined
  ): Delivery[] {
    const answer =
      s.answerId === null ? null : this.store.getMessage(s.answerId);
    // A stored message that was never an answer to q cannot settle it.
    if (
      answer !== null &&
      !this.store.answerCandidates(q.id).some((c) => c.message.id === answer.id)
    )
      return [];
    this.store.putSettlement(s);
    if (s.answerId === null) return [];
    if (answer !== null) {
      changed.push(...this.swapSettled(q.id, s.answerId));
      return this.markAnswered(q.id);
    }
    if (s.closedReason === null) return [];
    changed.push(...this.demoteOtherAnswers(q.id, s.answerId));
    this.store.insertMessage(
      closeCopy(
        q,
        s.answerId,
        s.closedReason,
        s.settler,
        this.nowIso(),
        closeHlc
      ),
      undefined,
      { receivedAt: this.nowIso(), settledAs: 'accepted' }
    );
    changed.push(s.answerId);
    return this.markAnswered(q.id);
  }

  // 1. every other answer row → message/superseded; 2. the accepted row →
  // answer/accepted, in the order the one-answer index needs. Returns the ids changed.
  private swapSettled(questionId: string, answerId: string): string[] {
    const changed = this.demoteOtherAnswers(questionId, answerId);
    this.store.setSettled(answerId, 'answer', 'accepted');
    return [...changed, answerId];
  }

  // Every answer or answer candidate of a question but `keep` becomes a superseded reply.
  private demoteOtherAnswers(questionId: string, keep: string): string[] {
    const changed: string[] = [];
    for (const c of this.store.answerCandidates(questionId)) {
      if (c.message.id === keep) continue;
      if (c.message.kind !== 'answer' && c.settledAs === 'superseded') continue;
      this.store.setSettled(c.message.id, 'message', 'superseded');
      changed.push(c.message.id);
    }
    return changed;
  }

  // Emits each rewritten message once, as it is stored now.
  private emitChanged(ids: string[], skip?: string): void {
    for (const id of new Set(ids)) {
      if (id === skip) continue;
      const m = this.store.getMessage(id);
      if (m !== null) this.emit({ type: 'message', message: m });
    }
  }

  // Turns this replica's forwarded or held remote rows for a task into local
  // held deliveries, so a run starting here receives what waited elsewhere.
  claimRemote(taskId: string): Delivery[] {
    const recipient = `task:${taskId}`;
    const now = this.nowIso();
    const claimed = this.store.transaction(() => {
      const out: Delivery[] = [];
      for (const row of this.store.remoteDeliveries({
        recipient,
        states: ['forwarded', 'held'],
      })) {
        if (this.store.getMessage(row.messageId) === null) continue;
        this.store.deleteRemote(row.messageId, recipient);
        const existing = this.store.deliveries({
          messageId: row.messageId,
          recipient,
        });
        if (existing.length > 0) continue;
        const d: Delivery = {
          id: this.id('d'),
          messageId: row.messageId,
          recipient,
          runId: null,
          via: row.via,
          state: 'held',
          updatedAt: now,
        };
        this.store.insertDelivery(d);
        out.push(d);
      }
      return out;
    });
    for (const d of claimed) this.emit({ type: 'delivery', delivery: d });
    return claimed;
  }

  // Moves this replica's own delivery of a message to a remote row once other
  // homes hold it, so it is never delivered twice; the row starts at `state`.
  moveToRemote(
    messageId: string,
    recipient: Address,
    homes: string[],
    state: RemoteState = 'forwarded'
  ): void {
    const now = this.nowIso();
    const moved = this.store.transaction(() => {
      const local = this.store.deliveries({ messageId, recipient });
      const [first] = local;
      if (first === undefined) return false;
      for (const d of local) this.store.deleteDelivery(d.id);
      this.putRemote(first, homes, state, now);
      return true;
    });
    if (moved) this.emit({ type: 'remote', messageId, recipient });
  }

  // Adds a remote row for a delivery leaving this replica, or merges its
  // homes and state into the row already there.
  private putRemote(
    d: Delivery,
    homes: string[],
    state: RemoteState,
    now: string
  ): void {
    const row: RemoteDelivery = {
      messageId: d.messageId,
      recipient: d.recipient,
      via: d.via,
      state,
      homes,
      wakeAt: null,
      refusedBy: [],
      updatedAt: now,
    };
    if (this.store.insertRemote(row)) return;
    const [existing] = this.store.remoteDeliveries({
      messageId: d.messageId,
      recipient: d.recipient,
    });
    if (existing === undefined) return;
    this.store.setRemote(
      d.messageId,
      d.recipient,
      {
        state: maxRemote(existing.state, state),
        homes: [...new Set([...existing.homes, ...homes])],
      },
      now
    );
  }

  // Tells a sender something went sideways, as a system notice in its thread;
  // a sender run that has ended hears it through its task.
  private async noticeTo(
    recipient: Address,
    about: Message,
    body: string
  ): Promise<void> {
    await this.send(
      {
        to: [this.deliverableAddress(recipient)],
        kind: 'notice',
        body,
        refs: [{ type: 'message', id: about.id }],
      },
      SYSTEM_SENDER
    );
  }

  // After a wake-requesting send, asks the host to wake (or gate or deny) each
  // held task recipient, except those in `skip`, which another replica wakes.
  private async runWake(
    message: Message,
    settled: Delivery[],
    skip: ReadonlySet<Address>
  ): Promise<void> {
    const wakesRuns = wakesEndedRuns(message);
    for (const d of settled) {
      if (d.state !== 'held' || skip.has(d.recipient)) continue;
      if (
        !d.recipient.startsWith('task:') &&
        !(wakesRuns && d.recipient.startsWith('run:'))
      )
        continue;
      const request: PolicyRequest = {
        type: 'wake',
        target: d.recipient,
        message,
      };
      if (message.origin !== undefined) request.origin = message.origin;
      const ruling = this.host.decide(request);
      if (ruling === 'allow') {
        let result: WakeResult;
        try {
          result = await this.host.wake(d.recipient, message);
        } catch (err) {
          console.error('messaging hook failed', err);
          result = {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        if (!result.ok)
          await this.noticeTo(
            message.from,
            message,
            `Could not wake ${d.recipient}: ${result.reason}. Your message is waiting for it.`
          );
      } else if (ruling === 'deny') {
        await this.noticeTo(
          message.from,
          message,
          `Waking ${d.recipient} was not allowed. Your message is waiting for it.`
        );
      } else {
        const label = this.remoteLabel(message);
        const who =
          label === undefined
            ? message.from
            : `${message.from} (remote: ${label})`;
        await this.send(
          {
            to: [this.host.owner(d.recipient)],
            kind: 'question',
            blocking: true,
            choices: ['approve', 'deny'],
            body: `${who} wants to wake ${d.recipient}:\n\n> ${firstLine(message.body)}`,
            data: { type: 'wake', target: d.recipient, message: message.id },
            refs: [{ type: 'message', id: message.id }],
          },
          SYSTEM_SENDER
        );
      }
    }
  }

  // Rejects an agent reply past the thread's hourly agent turns, flagging the owner
  // once; a `remote` agent:dispatch counts as an ordinary agent.
  private async checkBreaker(
    replyTarget: Message | null,
    sender: Sender,
    remote = false
  ): Promise<void> {
    const agentAuthored =
      isAgentAuthored(sender.address) ||
      (remote && sender.address === SYSTEM_ADDRESS);
    if (replyTarget === null || !agentAuthored) return;
    const since = this.hourAgoIso();
    const count = this.store.countAgentAuthored(
      replyTarget.thread,
      since,
      SYSTEM_ADDRESS
    );
    if (count < this.limits.agentTurnsPerThreadPerHour) return;
    const flagged = this.store
      .thread(replyTarget.thread)
      .some((m) => isSystemMarker(m, 'x-breaker') && m.createdAt >= since);
    if (!flagged) {
      await this.send(
        {
          to: [this.host.owner(sender.address)],
          kind: 'notice',
          replyTo: replyTarget.id,
          body: `Agents have sent ${count} messages in thread ${replyTarget.thread} this hour; further agent replies are paused.`,
          data: { type: 'x-breaker', thread: replyTarget.thread },
        },
        SYSTEM_SENDER
      );
    }
    throw new MessagingError(
      'limited',
      `thread ${replyTarget.thread} hit the agent turn limit; a human has been asked to step in`,
      'replyTo'
    );
  }
}

function alreadyAnswered(questionId: string): MessagingError {
  return new MessagingError(
    'conflict',
    `${questionId} is already answered`,
    'replyTo'
  );
}

// A deciding principal: the system, or a human the host lets decide.
function decides(sender: Sender): boolean {
  return (
    sender.address === SYSTEM_ADDRESS ||
    (sender.canDecide && sender.address.startsWith('human:'))
  );
}

// Answers that may take effect: a deciding human's or the system's.
function decidingAuthor(address: Address): boolean {
  return address === SYSTEM_ADDRESS || address.startsWith('human:');
}

// The higher of a remote row's state and a home's report: any report replaces
// refused, and between pushed and notified the row keeps what it holds.
function maxRemote(current: RemoteState, reported: RemoteState): RemoteState {
  if (current === 'refused') return reported;
  return REMOTE_RANK[reported] > REMOTE_RANK[current] ? reported : current;
}

// A received target homed on other replicas, waiting for their reports.
function remoteRow(
  messageId: string,
  t: RemoteTarget,
  now: string
): RemoteDelivery {
  return {
    messageId,
    recipient: t.recipient,
    via: t.via,
    state: 'forwarded',
    homes: t.homes,
    wakeAt: t.wakeAt ?? null,
    refusedBy: [],
    updatedAt: now,
  };
}

// A settler's close as a non-settler stores it: under the settler's answer id,
// from the system address with the settler as origin, so never a local marker.
function closeCopy(
  q: Message,
  id: string,
  reason: string,
  settler: string,
  now: string,
  hlc: string | undefined
): Message {
  const close: Message = {
    id,
    thread: q.thread,
    replyTo: q.id,
    from: SYSTEM_ADDRESS,
    to: [q.from],
    kind: 'answer',
    body: `Closed: ${reason}`,
    refs: [],
    data: { type: 'x-closed', reason },
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: now,
    origin: settler,
  };
  // Clocked here, so the close sorts after its question in the thread.
  if (hlc !== undefined) close.hlc = hlc;
  return close;
}

// The send input a received message stands for, so validation judges it as
// it would a local send.
function toSendInput(m: Message): SendInput {
  const input: SendInput = {
    to: m.to,
    kind: m.kind,
    body: m.body,
    refs: m.refs,
    urgent: m.urgent,
    blocking: m.blocking,
    replyTo: m.replyTo,
    wake: m.wake,
  };
  if (m.data !== undefined) input.data = m.data;
  if (m.choices !== undefined) input.choices = m.choices;
  if (m.choice !== undefined) input.choice = m.choice;
  if (m.session !== undefined) input.session = m.session;
  return input;
}

function malformed(field: string, why: string): never {
  throw new MessagingError('invalid', `${field}: ${why}`, field);
}

// A received message's shape, checked before any rule reads it: its ids are
// identifiers, so none can break a rendered line, and every field has its type.
function checkReceivedEnvelope(m: Message): void {
  if (!isIdentifier(m.id)) malformed('id', 'expected a message id');
  if (!isIdentifier(m.thread)) malformed('thread', 'expected a message id');
  if (m.replyTo !== null && !isIdentifier(m.replyTo))
    malformed('replyTo', 'expected a message id or null');
  for (const field of ['from', 'kind', 'body', 'createdAt'] as const)
    if (typeof m[field] !== 'string') malformed(field, 'expected a string');
  for (const field of ['session', 'hlc', 'choice'] as const)
    if (m[field] !== undefined && typeof m[field] !== 'string')
      malformed(field, 'expected a string');
  if (!Array.isArray(m.to)) malformed('to', 'expected a list');
  checkStrings(m.to, 'to');
  if (m.choices !== undefined) {
    if (!Array.isArray(m.choices)) malformed('choices', 'expected a list');
    checkStrings(m.choices, 'choices');
  }
  if (
    !Array.isArray(m.refs) ||
    !m.refs.every((r) => typeof r === 'object' && r !== null)
  )
    malformed('refs', 'expected a list of refs');
  m.refs.forEach((r, i) => {
    if (typeof r.type !== 'string')
      malformed(`refs[${i}].type`, 'expected a string');
    if (typeof r.id !== 'string')
      malformed(`refs[${i}].id`, 'expected a string');
    if (r.at !== undefined && typeof r.at !== 'string')
      malformed(`refs[${i}].at`, 'expected a string');
  });
  if (typeof m.urgent !== 'boolean') malformed('urgent', 'expected a boolean');
  if (typeof m.blocking !== 'boolean')
    malformed('blocking', 'expected a boolean');
  if (m.wake !== 'none' && m.wake !== 'request')
    malformed('wake', 'expected none or request');
}

// Refuses the first element of a received list that is not a string.
function checkStrings(list: readonly unknown[], field: string): void {
  list.forEach((v, i) => {
    if (typeof v !== 'string') malformed(`${field}[${i}]`, 'expected a string');
  });
}

// The origin's resolution, shaped as RemoteTarget, may name only addresses
// that parse and may leave their machine; any failure refuses the message.
function checkReceivedTargets(origin: RemoteOrigin): void {
  if (!Array.isArray(origin.targets)) malformed('targets', 'expected a list');
  if (
    origin.forwardTarget !== undefined &&
    typeof origin.forwardTarget !== 'string'
  )
    malformed('forwardTarget', 'expected an address');
  origin.targets.forEach((raw: unknown, i) => {
    const at = `targets[${i}]`;
    const t: Partial<Record<keyof RemoteTarget, unknown>> =
      typeof raw === 'object' && raw !== null ? raw : {};
    if (typeof t.recipient !== 'string')
      malformed(`${at}.recipient`, 'expected an address');
    if (t.via !== 'direct' && t.via !== 'channel')
      malformed(`${at}.via`, 'expected direct or channel');
    if (!Array.isArray(t.homes)) malformed(`${at}.homes`, 'expected a list');
    checkStrings(t.homes, `${at}.homes`);
    if (t.wakeAt !== undefined && typeof t.wakeAt !== 'string')
      malformed(`${at}.wakeAt`, 'expected a replica id');
    if (isFederationLocalAddress(t.recipient))
      throw new MessagingError('forbidden', LOCAL_ONLY_TEXT.participant, 'to');
    parseAddress(t.recipient, at);
  });
}

// A root is its own thread and a reply joins its target's, as every honest
// sender files them; any other thread would skip participation and the breaker.
function checkReceivedThread(m: Message, replyTarget: Message | null): void {
  if (m.replyTo === null && m.thread !== m.id)
    malformed(
      'thread',
      'a message that replies to nothing starts its own thread'
    );
  if (replyTarget !== null && m.thread !== replyTarget.thread)
    malformed(
      'thread',
      `expected ${replyTarget.thread}, the thread of ${replyTarget.id}`
    );
}

// The fields an origin signs; `origin` is this replica's own record of it.
const SIGNED_FIELDS = [
  'id',
  'thread',
  'replyTo',
  'from',
  'session',
  'to',
  'kind',
  'body',
  'refs',
  'data',
  'urgent',
  'blocking',
  'choices',
  'choice',
  'wake',
  'createdAt',
  'hlc',
] as const;

// Whether an incoming copy carries the stored message's signed content; a
// superseded or candidate row is stored as a reply but was signed as an answer.
function sameSignedContent(
  stored: Message,
  settledAs: SettledAs | null,
  incoming: Message
): boolean {
  const storedKind =
    settledAs === 'superseded' || settledAs === 'candidate'
      ? 'answer'
      : stored.kind;
  const signed = (m: Message, kind: MessageKind) =>
    canonical(
      Object.fromEntries(
        SIGNED_FIELDS.map((f) => [f, f === 'kind' ? kind : m[f]])
      )
    );
  return signed(stored, storedKind) === signed(incoming, incoming.kind);
}

// JSON with object keys sorted and undefined members dropped, so two copies of
// one message compare equal whatever order their fields arrived in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  const text: string | undefined = JSON.stringify(value);
  return text ?? 'null';
}

// Only a local human's wake may name an ended run: it asks to continue exactly
// that run. A message from another replica never continues one.
function wakesEndedRuns(message: Message): boolean {
  return (
    message.wake === 'request' &&
    message.origin === undefined &&
    message.from.startsWith('human:')
  );
}
