import { isAgentAuthored, parseAddress, SYSTEM_ADDRESS } from './address.js';
import type { Address } from './address.js';
import { checkIdempotencyKey, gateOf, validateSendInput } from './envelope.js';
import type { JsonValue, Message, Ref, SendInput } from './envelope.js';
import { MessagingError } from './errors.js';
import type { MessagingHost, WakeResult } from './host.js';
import { firstLine, renderDigestLine, renderForAgent } from './render.js';
import type {
  Delivery,
  DeliveryState,
  DeliveryVia,
  MessageStore,
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
  | { type: 'delivery'; delivery: Delivery };

interface Target {
  recipient: Address;
  via: DeliveryVia;
}

const HOUR_MS = 60 * 60 * 1000;

const SYSTEM_SENDER: Sender = { address: SYSTEM_ADDRESS, canDecide: true };

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

  // A target's initial delivery state and run; null drops a not-live run that
  // only a channel reached. A reply to an ended run with no task is held on it.
  private plan(
    target: Target,
    muted: boolean,
    field: string,
    repliesToIt: boolean
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
          if (repliesToIt) return { ...base, runId: null, state: 'held' };
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
    // A repeated key replays before any other check, so a retried answer or a
    // retry after the breaker trips gets the first result.
    const key = input.idempotencyKey;
    if (key !== undefined) {
      checkIdempotencyKey(key);
      const prior = this.replay(sender.address, key);
      if (prior !== null) return prior;
    }
    const replyTarget = input.replyTo
      ? this.store.getMessage(input.replyTo)
      : null;
    // Participation first: a non-participant must learn nothing about the target.
    if (replyTarget !== null) this.authorizeReply(replyTarget, sender);
    validateSendInput(input, sender.address, sender.canDecide, replyTarget);
    await this.checkBreaker(replyTarget, sender);
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
    const targets = this.resolveTargets(message.to, sender.address);
    const deliveries: Delivery[] = [];
    for (const t of targets) {
      const planned = this.plan(
        t,
        muted,
        fields.get(t.recipient) ?? 'to',
        t.recipient === replyTarget?.from
      );
      if (planned !== null) deliveries.push({ ...planned, messageId: id });
    }

    const question = message.kind === 'answer' ? replyTarget : null;
    const written = this.store.transaction((): Delivery[] | SendResult => {
      // Re-checked inside the write: the breaker await lets a duplicate key or
      // a second answer race in, and the duplicate replays.
      const prior = key === undefined ? null : this.replay(sender.address, key);
      if (prior !== null) return prior;
      if (question !== null && this.store.answersTo(question.id).length > 0)
        throw alreadyAnswered(question.id);
      this.store.insertMessage(message, key);
      for (const d of deliveries) this.store.insertDelivery(d);
      return question === null ? [] : this.markAnswered(question.id);
    });
    if (!Array.isArray(written)) return written;
    const answered = written;
    // A gate's effect lands before anyone hears of the answer.
    if (question !== null && gateOf(question) !== null && !isClose(message))
      await this.applyGate(question, message);
    this.emit({ type: 'message', message });
    for (const d of answered) this.emit({ type: 'delivery', delivery: d });

    const settled: Delivery[] = [];
    for (const d of deliveries)
      settled.push((await this.dispatch(d, message)).delivery);

    if (message.wake === 'request') {
      try {
        await this.runWake(message, settled);
      } catch (err) {
        // The message is committed; a failing wake path must not fail the send.
        console.error('messaging wake failed', err);
      }
    }

    return { message, deliveries: settled, downgraded };
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

  // The address a reply actually goes to: an ended run's task (see deliverableAddress).
  private rewriteForReply(address: Address, target: Message | null): Address {
    return target !== null && address === target.from
      ? this.deliverableAddress(address)
      : address;
  }

  // A reply's recipients, with the target's sender rewritten by
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

  // Only participants may reply: the target's sender or recipients, where a run
  // also stands for its task, that task's other runs and deliveries bound to it.
  private authorizeReply(target: Message, sender: Sender): void {
    if (sender.address === SYSTEM_ADDRESS) return;
    if (sender.canDecide && sender.address.startsWith('human:')) return;
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
    if (actsFor(target.from)) return;
    const addressed = this.store
      .deliveries({ messageId: target.id })
      .some(
        (d) =>
          actsFor(d.recipient) ||
          (senderRunId !== null && d.runId === senderRunId)
      );
    if (!addressed)
      throw new MessagingError(
        'forbidden',
        'only a participant can reply in this thread',
        'replyTo'
      );
  }

  // Runs the gate hook and marks it applied; a failure at either step is left
  // for recover() to replay, which is safe because onAnswered is idempotent.
  private async applyGate(
    question: Message,
    answer: Message
  ): Promise<boolean> {
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

  // Pushes or notifies one stored delivery (held again if its run went away);
  // `won` is false when something else moved the row off `sending` first.
  private async dispatch(
    d: Delivery,
    message: Message
  ): Promise<{ delivery: Delivery; won: boolean }> {
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

  // Finishes work a crash left between commit and hook: retries sending
  // deliveries whose run is still live, returns the rest to the mailbox, and
  // replays gate effects that never recorded as applied.
  async recover(): Promise<{
    retried: number;
    reverted: number;
    replayed: number;
  }> {
    let retried = 0;
    let reverted = 0;
    let replayed = 0;
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
      if (await this.applyGate(question, answer)) replayed++;
    }
    return { retried, reverted, replayed };
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

  // Channels hold tasks and actors, not runs: membership must outlive a run.
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
    this.store.transaction(() => {
      this.store.ensureChannel(channel, this.nowIso(), false);
      this.store.addMember(channel, member, this.nowIso());
    });
  }

  leave(channel: string, member: Address): boolean {
    return this.store.removeMember(channel, member);
  }

  // Where a reply or system notice for `address` should go: a run that is no
  // longer live is reached through its task; every other address is as given.
  deliverableAddress(address: Address): Address {
    if (!address.startsWith('run:')) return address;
    const runId = address.slice('run:'.length);
    if (this.host.isLiveRun(runId)) return address;
    const task = this.host.taskOfRun(runId);
    return task === null ? address : `task:${task}`;
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

  // A system answer that skips validation and hooks — used when the host
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

  // After a wake-requesting send, asks the host to wake each held task
  // recipient (or gates/denies it), so the message is actually seen soon.
  private async runWake(message: Message, settled: Delivery[]): Promise<void> {
    for (const d of settled) {
      if (d.state !== 'held' || !d.recipient.startsWith('task:')) continue;
      const ruling = this.host.decide({
        type: 'wake',
        target: d.recipient,
        message,
      });
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
        await this.send(
          {
            to: [this.host.owner(d.recipient)],
            kind: 'question',
            blocking: true,
            choices: ['approve', 'deny'],
            body: `${message.from} wants to wake ${d.recipient}:\n\n> ${firstLine(message.body)}`,
            data: { type: 'wake', target: d.recipient, message: message.id },
            refs: [{ type: 'message', id: message.id }],
          },
          SYSTEM_SENDER
        );
      }
    }
  }

  // Rejects an agent reply once a thread has seen too many agent turns this
  // hour, flagging the owner once so two agents cannot loop forever.
  private async checkBreaker(
    replyTarget: Message | null,
    sender: Sender
  ): Promise<void> {
    if (replyTarget === null || !isAgentAuthored(sender.address)) return;
    const since = this.hourAgoIso();
    const count = this.store.countAgentAuthored(
      replyTarget.thread,
      since,
      SYSTEM_ADDRESS
    );
    if (count < this.limits.agentTurnsPerThreadPerHour) return;
    const flagged = this.store.thread(replyTarget.thread).some((m) => {
      const data = m.data as { type?: string } | undefined;
      return (
        m.from === SYSTEM_ADDRESS &&
        data?.type === 'x-breaker' &&
        m.createdAt >= since
      );
    });
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

// A system close carries `x-closed` data and applies no gate effect.
function isClose(answer: Message): boolean {
  return (answer.data as { type?: unknown } | undefined)?.type === 'x-closed';
}
