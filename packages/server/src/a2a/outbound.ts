import type {
  A2AStore,
  OutboundRow,
  PeerClient,
  PeerEvent,
  PeerLink,
  PeerRow,
  TaskJson,
} from '@dispatch/a2a';
import {
  guardPublicUrl,
  mapPeerEvent,
  peerEventFromMessage,
  peerEventFromTask,
  PeerHttpError,
  peerOutboundMessage,
  pollDelayMs,
  retrySchedule,
  summarizeCard,
  TERMINAL_STATES,
  TRACK_LIMIT_MS,
  UnresolvedHostError,
} from '@dispatch/a2a';
import type { A2AConfig } from '@dispatch/core';
import type {
  Delivery,
  DeliveryEngine,
  JsonValue,
  Message,
  SqliteMessageStore,
} from '@dispatch/protocol';
import {
  isPeerAddress,
  MessagingError,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';

import type { PeerService } from './peers.js';
import {
  disablePeer,
  markAuthFailed,
  peerClientFor,
  peerGuard,
  refreshPeer,
} from './peers.js';

const SYSTEM = { address: SYSTEM_ADDRESS, canDecide: true };

type GuardVerdict =
  | { kind: 'ok' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable'; reason: string };
const HOUR_MS = 3_600_000;
const QUOTA_RECHECK_MS = 5 * 60_000;

export interface OutboundDeps {
  engine: DeliveryEngine;
  messages: SqliteMessageStore;
  store: A2AStore;
  policy: () => A2AConfig;
  // peerClientFor; throws MessagingError 'token' when the credential is missing.
  clientFor: (row: PeerRow) => PeerClient;
  refreshPeer: (alias: string) => Promise<void>;
  markAuthFailed: (alias: string) => void;
  // Re-resolves and re-checks a decide-tier peer's interface URL before a
  // send, a poll or a subscribe; throws MessagingError when refused.
  guard: (row: PeerRow) => Promise<void>;
  // Sets the peer disabled, sends the owner one notice, and emits 'disabled'.
  disablePeer: (alias: string, reason: string) => void;
  now?: () => Date;
  pollMs?: (polls: number) => number;
  concurrency?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// The next stream event as 'tick', or 'done' when the stream ends or fails.
function nextTick(ticks: AsyncGenerator<void>): Promise<'tick' | 'done'> {
  return ticks.next().then(
    (r) => (r.done === true ? 'done' : 'tick'),
    () => 'done'
  );
}

// Resolves 'timeout' after `ms`, or at once when `signal` aborts.
function delay(ms: number, signal: AbortSignal): Promise<'timeout'> {
  return sleep(ms, signal).then(() => 'timeout');
}

// The lastError a removed peer's rows carry (peers.ts reads the same text);
// with cleared remote ids it marks a row tombstoned.
function removedReason(alias: string): string {
  return `a2a:${alias} was removed`;
}

const MAX_REMOTE_ID_BYTES = 200;

// A peer's task or context id as kept in a2a.db: one line, 1-200 bytes.
function isRemoteId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id !== '' &&
    !/[\r\n\u0085\u2028\u2029]/.test(id) &&
    new TextEncoder().encode(id).byteLength <= MAX_REMOTE_ID_BYTES
  );
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// A refused address: the guard's own MessagingError, or the pinned fetch's
// ADDRESS_REFUSED. Final for the delivery, and the peer is disabled.
function addressRefusal(err: unknown): string | null {
  if (err instanceof PeerHttpError && err.reason === 'ADDRESS_REFUSED')
    return err.message;
  return null;
}

// The outbound worker (spec:1444-1531): relays held a2a: deliveries one at a
// time per peer, at most `concurrency` peers at once, then follows each peer
// task and records what the peer says. What to record and when to retry come
// from @dispatch/a2a; this class only does I/O, timers and bookkeeping.
export class OutboundWorker {
  private readonly queues = new Map<string, string[]>();
  private readonly busy = new Set<string>();
  private readonly trackers = new Map<string, AbortController>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly lastWorking = new Map<string, string>();
  private readonly inflight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(private readonly deps: OutboundDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private hold(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private later(atIso: string, fn: () => void): void {
    if (this.stopped) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        fn();
      },
      Math.max(0, Date.parse(atIso) - this.now().getTime())
    );
    timer.unref();
    this.timers.add(timer);
  }

  // Subscribes to held peer deliveries, then relays what is already held and
  // resumes every open row.
  start(): () => void {
    const off = this.deps.engine.subscribe((e) => {
      if (
        e.type === 'delivery' &&
        e.delivery.state === 'held' &&
        isPeerAddress(e.delivery.recipient)
      )
        this.enqueue(e.delivery);
    });
    this.kick();
    return () => {
      off();
      this.stopped = true;
      for (const ac of this.trackers.values()) ac.abort();
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
    };
  }

  // Re-scans held peer deliveries and open rows (boot, enable, add, quota window).
  kick(alias?: string): void {
    if (this.stopped) return;
    const prefix = alias === undefined ? 'a2a:' : `a2a:${alias}`;
    for (const d of this.deps.messages.deliveries({
      recipientPrefix: prefix,
      states: ['held'],
    })) {
      if (alias === undefined || d.recipient === prefix) this.enqueue(d);
    }
    const open =
      alias === undefined
        ? this.deps.store.outboundIn(['open'])
        : this.deps.store.outboundOf(alias, ['open']);
    for (const row of open) this.track(row);
  }

  trackerCount(alias?: string): number {
    return [...this.trackers.keys()].filter(
      (k) => alias === undefined || k.endsWith(` ${alias}`)
    ).length;
  }

  // Resolves once no relay or poll is in flight (tests).
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private enqueue(d: Delivery): void {
    if (this.stopped) return;
    const alias = d.recipient.slice('a2a:'.length);
    const queue = this.queues.get(alias) ?? [];
    if (!queue.includes(d.id)) queue.push(d.id);
    this.queues.set(alias, queue);
    this.pump();
  }

  private pump(): void {
    for (const [alias, queue] of this.queues) {
      if (this.busy.size >= (this.deps.concurrency ?? 4)) return;
      if (this.busy.has(alias) || queue.length === 0) continue;
      this.busy.add(alias);
      this.hold(
        (async () => {
          try {
            for (let id = queue.shift(); id !== undefined; id = queue.shift())
              await this.relay(id);
          } catch (err) {
            console.error(`a2a: relaying to a2a:${alias} failed`, err);
          } finally {
            this.busy.delete(alias);
            this.pump();
          }
        })()
      );
    }
  }

  // An answer to the peer's own question continues the peer's task; anything
  // else joins the peer's context for this thread, if any (spec:1457-1459).
  private linkFor(message: Message, alias: string): PeerLink {
    if (message.kind === 'answer' && message.replyTo !== null) {
      const asked = this.deps.engine.getMessage(message.replyTo);
      if (
        asked !== null &&
        asked.from === `a2a:${alias}` &&
        asked.replyTo !== null
      ) {
        const origin = this.deps.store.getOutbound(asked.replyTo, alias);
        if (origin !== null && origin.remoteTaskId !== null)
          return {
            contextId: origin.remoteContextId,
            taskId: origin.remoteTaskId,
          };
      }
    }
    return {
      contextId: this.deps.store.contextFor(alias, message.thread),
      taskId: null,
    };
  }

  private async relay(deliveryId: string): Promise<void> {
    const d = this.deps.messages.getDelivery(deliveryId);
    if (d === null || d.state !== 'held') return;
    const alias = d.recipient.slice('a2a:'.length);
    const message = this.deps.engine.getMessage(d.messageId);
    const peer = this.deps.store.getPeer(alias);
    if (message === null || peer === null || peer.status !== 'active') return;
    const existing = this.deps.store.getOutbound(message.id, alias);
    if (existing !== null && existing.state !== 'queued') {
      // Sent before a crash or already given up: finish the bookkeeping only.
      if (existing.state !== 'failed') this.deps.engine.markRelayed(d.id);
      if (existing.state === 'open') this.track(existing);
      return;
    }
    const now = this.now();
    if (
      existing?.nextAttemptAt != null &&
      Date.parse(existing.nextAttemptAt) > now.getTime()
    ) {
      this.later(existing.nextAttemptAt, () => this.enqueue(d));
      return;
    }
    if (
      d.via === 'channel' &&
      this.deps.store.relayedSince(
        alias,
        new Date(now.getTime() - HOUR_MS).toISOString()
      ) >= this.deps.policy().outboundPerHour
    ) {
      this.later(new Date(now.getTime() + QUOTA_RECHECK_MS).toISOString(), () =>
        this.enqueue(d)
      );
      return;
    }
    const at = now.toISOString();
    const base: OutboundRow = existing ?? {
      messageId: message.id,
      alias,
      thread: message.thread,
      remoteTaskId: null,
      remoteContextId: null,
      state: 'queued',
      attempts: 0,
      firstAttemptAt: at,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: at,
    };
    const link = this.linkFor(message, alias);
    const verdict = await this.guarded(peer);
    if (verdict.kind === 'refused') {
      await this.refused(base, message, d.via, verdict.reason);
      return;
    }
    if (verdict.kind === 'unreachable') {
      await this.sendFailed(
        d,
        message,
        base,
        new PeerHttpError(null, verdict.reason)
      );
      return;
    }
    let result;
    try {
      const client = this.deps.clientFor(peer);
      result = await client.send(peerOutboundMessage(message, alias, link));
    } catch (err) {
      await this.sendFailed(d, message, base, err);
      return;
    }
    // The peer may have been removed, or the row given up, while the send was
    // in flight: keep it failed and leave the delivery as the removal left it.
    const after = this.deps.store.getOutbound(message.id, alias);
    if (this.deps.store.getPeer(alias) === null || after?.state === 'failed')
      return;
    const remoteTask = result.kind === 'task' ? result.task.id : null;
    const remoteContext =
      result.kind === 'task'
        ? result.task.contextId
        : (result.message.contextId ?? null);
    if (
      (remoteTask !== null && !isRemoteId(remoteTask)) ||
      (remoteContext !== null && !isRemoteId(remoteContext))
    ) {
      const reason = `a2a:${alias} answered with an invalid task or context id`;
      await this.refused(
        { ...base, attempts: base.attempts + 1 },
        message,
        d.via,
        reason
      );
      return;
    }
    const tracked =
      link.taskId === null &&
      result.kind === 'task' &&
      (d.via === 'direct' || message.kind === 'question');
    const row: OutboundRow = {
      ...base,
      attempts: base.attempts + 1,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: at,
      state: tracked ? 'open' : 'done',
      remoteTaskId: remoteTask ?? base.remoteTaskId,
      remoteContextId: remoteContext ?? base.remoteContextId,
    };
    // Written before markRelayed, so a crash between the two re-sends under
    // the same messageId, which the peer dedupes.
    this.deps.store.putOutbound(row);
    // The WORKING-notice throttle starts at the send, so a peer's immediate "Working." is not echoed.
    this.lastWorking.set(`${message.id} ${alias}`, at);
    this.deps.engine.markRelayed(d.id);
    if (link.taskId !== null) return; // the original row's tracker sees what follows
    const event =
      result.kind === 'task'
        ? peerEventFromTask(result.task)
        : peerEventFromMessage(result.message);
    if (event !== null) await this.apply(row, event, d.via);
    if (tracked && event?.kind === 'task' && !TERMINAL_STATES.has(event.state))
      this.track(row);
    else if (tracked) this.finish(row, 'done', null);
  }

  // A refused address is final for the delivery and disables the peer.
  private async refused(
    row: OutboundRow,
    message: Message,
    via: 'direct' | 'channel',
    reason: string
  ): Promise<void> {
    const at = this.now().toISOString();
    this.deps.store.putOutbound({
      ...row,
      state: 'failed',
      nextAttemptAt: null,
      lastError: reason,
      updatedAt: at,
    });
    await this.giveUp(message, via, reason, true);
  }

  private async sendFailed(
    d: Delivery,
    message: Message,
    row: OutboundRow,
    err: unknown
  ): Promise<void> {
    const status = err instanceof PeerHttpError ? err.status : null;
    const reason = errorText(err);
    const at = this.now().toISOString();
    const attempts = row.attempts + 1;
    const refusal = addressRefusal(err);
    if (refusal !== null) {
      const why = this.disableRefused(row.alias, refusal);
      await this.refused({ ...row, attempts }, message, d.via, why);
      return;
    }
    if (
      (err instanceof MessagingError && err.field === 'token') ||
      status === 401 ||
      status === 403
    ) {
      // Parked: the peer is auth-failed and its deliveries wait for `enable`.
      this.deps.store.putOutbound({
        ...row,
        attempts,
        lastError: reason,
        updatedAt: at,
      });
      this.deps.markAuthFailed(row.alias);
      return;
    }
    if (
      status === 404 ||
      (err instanceof PeerHttpError && err.reason === 'VERSION_NOT_SUPPORTED')
    ) {
      this.deps.refreshPeer(row.alias).catch((e: unknown) => {
        console.error(`a2a: refreshing a2a:${row.alias} failed`, e);
      });
    }
    const decision = retrySchedule(attempts, row.firstAttemptAt, this.now(), {
      status,
      retryAfterSec: err instanceof PeerHttpError ? err.retryAfterSec : null,
    });
    if (decision.kind === 'retry') {
      this.deps.store.putOutbound({
        ...row,
        attempts,
        nextAttemptAt: decision.at,
        lastError: reason,
        updatedAt: at,
      });
      this.later(decision.at, () => this.enqueue(d));
      return;
    }
    this.deps.store.putOutbound({
      ...row,
      attempts,
      state: 'failed',
      nextAttemptAt: null,
      lastError: `${decision.reason}: ${reason}`,
      updatedAt: at,
    });
    await this.giveUp(
      message,
      d.via,
      status === null
        ? `could not reach a2a:${row.alias} for 24 h`
        : `a2a:${row.alias} refused the message: ${reason}`,
      status !== null
    );
  }

  // Closes a direct question or handoff; tells the sender otherwise, or also.
  private async giveUp(
    message: Message,
    via: 'direct' | 'channel',
    reason: string,
    alsoNotice: boolean
  ): Promise<void> {
    const closable =
      via === 'direct' &&
      (message.kind === 'question' || message.kind === 'handoff');
    if (closable) this.closeQuietly(message.id, reason);
    if (!closable || alsoNotice) await this.notice(message, reason);
  }

  private closeQuietly(questionId: string, reason: string): void {
    try {
      this.deps.engine.close(questionId, reason);
    } catch (err) {
      if (!(err instanceof MessagingError && err.code === 'conflict'))
        throw err;
    }
  }

  private async notice(about: Message, body: string): Promise<void> {
    await this.deps.engine
      .send(
        {
          to: [this.deps.engine.deliverableAddress(about.from)],
          kind: 'notice',
          replyTo: about.id,
          body,
          refs: [{ type: 'message', id: about.id }],
        },
        SYSTEM
      )
      .catch((err: unknown) => console.error('a2a: sender notice failed', err));
  }

  // Disables a peer whose address was refused; returns the reason to record.
  private disableRefused(alias: string, why: string): string {
    this.deps.disablePeer(alias, `its address is now refused (${why})`);
    return `a2a:${alias} was not contacted: its address is now refused (${why})`;
  }

  // Re-checks a decide-tier peer's URL before a contact (spec:1776-1777). A
  // refusal disables the peer (one owner notice) and is final; a name that
  // does not resolve is only unreachable, retried like any network error.
  private async guarded(peer: PeerRow): Promise<GuardVerdict> {
    try {
      await this.deps.guard(peer);
      return { kind: 'ok' };
    } catch (err) {
      if (err instanceof UnresolvedHostError)
        return { kind: 'unreachable', reason: err.message };
      if (!(err instanceof MessagingError)) throw err;
      return {
        kind: 'refused',
        reason: this.disableRefused(peer.alias, err.message),
      };
    }
  }

  // A tracked row whose peer failed the guard: final, like a 4xx.
  private async blockedWhileTracking(
    row: OutboundRow,
    reason: string
  ): Promise<void> {
    this.finish(row, 'failed', reason);
    const original = this.deps.engine.getMessage(row.messageId);
    if (original !== null)
      await this.giveUp(original, this.viaOf(row), reason, false);
  }

  private finish(
    row: OutboundRow,
    state: 'done' | 'failed',
    error: string | null
  ): void {
    const current =
      this.deps.store.getOutbound(row.messageId, row.alias) ?? row;
    this.deps.store.putOutbound({
      ...current,
      state,
      lastError: error,
      nextAttemptAt: null,
      updatedAt: this.now().toISOString(),
    });
  }

  private viaOf(row: OutboundRow): 'direct' | 'channel' {
    return (
      this.deps.messages.deliveries({
        messageId: row.messageId,
        recipient: `a2a:${row.alias}`,
      })[0]?.via ?? 'direct'
    );
  }

  private track(row: OutboundRow): void {
    const key = `${row.messageId} ${row.alias}`;
    if (this.stopped || this.trackers.has(key) || row.remoteTaskId === null)
      return;
    const ac = new AbortController();
    this.trackers.set(key, ac);
    this.hold(
      this.follow(row, ac.signal)
        .catch((err: unknown) =>
          console.error(`a2a: tracking a2a:${row.alias} failed`, err)
        )
        .finally(() => {
          if (this.trackers.get(key) === ac) this.trackers.delete(key);
        })
    );
  }

  // Follows one peer task: SSE when the card streams, else GetTask every 5 s
  // backing off to 60 s; every signal re-reads the task.
  // Ends a row that has had no result for TRACK_LIMIT_MS; true when it did.
  private async expired(row: OutboundRow): Promise<boolean> {
    if (this.now().getTime() - Date.parse(row.firstAttemptAt) < TRACK_LIMIT_MS)
      return false;
    this.finish(row, 'failed', 'no result in 7 days');
    const original = this.deps.engine.getMessage(row.messageId);
    if (original !== null)
      await this.giveUp(
        original,
        this.viaOf(row),
        `no result from a2a:${row.alias} in 7 days`,
        false
      );
    return true;
  }

  // Follows one peer task: SSE when the card streams, else GetTask every 5 s
  // backing off to 60 s; every signal re-reads the task.
  private async follow(row: OutboundRow, signal: AbortSignal): Promise<void> {
    let polls = 0;
    while (!signal.aborted) {
      const current = this.deps.store.getOutbound(row.messageId, row.alias);
      const peer = this.deps.store.getPeer(row.alias);
      if (
        current === null ||
        current.state !== 'open' ||
        current.remoteTaskId === null ||
        peer === null ||
        peer.status !== 'active'
      )
        return;
      if (await this.expired(current)) return;
      let client: PeerClient;
      try {
        client = this.deps.clientFor(peer);
      } catch {
        this.deps.markAuthFailed(peer.alias);
        return;
      }
      // Before subscribing; poll() re-checks before every read.
      const verdict = await this.guarded(peer);
      if (verdict.kind === 'refused') {
        await this.blockedWhileTracking(current, verdict.reason);
        return;
      }
      if (verdict.kind === 'unreachable') {
        // Offline or DNS down: wait and look again, still tracking.
        await sleep(this.deps.pollMs?.(polls) ?? pollDelayMs(polls), signal);
        polls += 1;
        continue;
      }
      if (
        summarizeCard(this.cardOf(peer)).streaming &&
        (await this.stream(client, current, signal))
      )
        return;
      if (signal.aborted || (await this.poll(client, current, signal))) return;
      await sleep(this.deps.pollMs?.(polls) ?? pollDelayMs(polls), signal);
      polls += 1;
    }
  }

  // Follows the peer's SSE stream: each event re-reads the task, at most once
  // per poll floor (a burst becomes one read, the last event never lost), and
  // the 7-day limit holds even while events keep arriving. True when tracking
  // ends; false when the stream ended or failed and polling should take over.
  private async stream(
    client: PeerClient,
    row: OutboundRow,
    signal: AbortSignal
  ): Promise<boolean> {
    if (row.remoteTaskId === null) return true;
    const floor = this.deps.pollMs?.(0) ?? pollDelayMs(0);
    const idleCheck = this.deps.pollMs?.(4) ?? pollDelayMs(4);
    const ticks = client.changes(row.remoteTaskId, signal);
    let next: Promise<'tick' | 'done'> = nextTick(ticks);
    let lastRead = 0;
    let pending = false;
    try {
      while (!signal.aborted) {
        if (await this.expired(row)) return true;
        const wait = pending
          ? Math.max(0, lastRead + floor - Date.now())
          : idleCheck;
        const got = await Promise.race([next, delay(wait, signal)]);
        if (got === 'done') return false;
        if (got === 'tick') {
          next = nextTick(ticks);
          pending = true;
        }
        if (pending && Date.now() - lastRead >= floor) {
          pending = false;
          lastRead = Date.now();
          if (await this.poll(client, row, signal)) return true;
        }
      }
      return true;
    } finally {
      void ticks.return(undefined).catch(() => undefined);
    }
  }

  private cardOf(peer: PeerRow): Record<string, JsonValue> {
    try {
      return JSON.parse(peer.cardJson) as Record<string, JsonValue>;
    } catch {
      return {};
    }
  }

  // Reads the peer task once and records what changed; true when tracking ends.
  private async poll(
    client: PeerClient,
    row: OutboundRow,
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted || row.remoteTaskId === null) return true;
    const peer = this.deps.store.getPeer(row.alias);
    if (peer === null) return true;
    const verdict = await this.guarded(peer);
    if (verdict.kind === 'refused') {
      await this.blockedWhileTracking(row, verdict.reason);
      return true;
    }
    if (verdict.kind === 'unreachable') return false;
    let task: TaskJson;
    try {
      task = await client.getTask(row.remoteTaskId);
    } catch (err) {
      const refusal = addressRefusal(err);
      if (refusal !== null) {
        await this.blockedWhileTracking(
          row,
          this.disableRefused(row.alias, refusal)
        );
        return true;
      }
      const status = err instanceof PeerHttpError ? err.status : null;
      if (status === 401 || status === 403) {
        this.deps.markAuthFailed(row.alias);
        return true;
      }
      if (
        err instanceof PeerHttpError &&
        err.reason === 'VERSION_NOT_SUPPORTED'
      )
        this.deps.refreshPeer(row.alias).catch((e: unknown) => {
          console.error(`a2a: refreshing a2a:${row.alias} failed`, e);
        });
      if (status === 404) {
        this.finish(row, 'failed', 'the peer no longer knows the task');
        const original = this.deps.engine.getMessage(row.messageId);
        if (original !== null)
          await this.giveUp(
            original,
            this.viaOf(row),
            `a2a:${row.alias} lost the task`,
            false
          );
        return true;
      }
      return false;
    }
    if (signal.aborted) return true;
    const event = peerEventFromTask(task);
    if (event === null || event.kind !== 'task') return false;
    const current = {
      ...row,
      remoteContextId: isRemoteId(event.contextId)
        ? event.contextId
        : row.remoteContextId,
    };
    await this.apply(current, event, this.viaOf(row));
    if (!TERMINAL_STATES.has(event.state)) return false;
    this.finish(current, 'done', null);
    return true;
  }

  // Records one peer event in the thread, as the peer (never deciding).
  private async apply(
    row: OutboundRow,
    event: PeerEvent,
    via: 'direct' | 'channel'
  ): Promise<void> {
    const original = this.deps.engine.getMessage(row.messageId);
    if (original === null) return;
    const key = `${row.messageId} ${row.alias}`;
    const actions = mapPeerEvent(event, {
      alias: row.alias,
      original,
      via,
      originalAnswered: this.deps.engine.answerOf(original.id) !== null,
      lastWorkingNoticeAt: this.lastWorking.get(key) ?? null,
      now: this.now(),
    });
    for (const action of actions) {
      if (action.kind === 'close') {
        this.closeQuietly(original.id, action.reason);
        continue;
      }
      try {
        await this.deps.engine.send(action.input, {
          address: `a2a:${row.alias}`,
          canDecide: false,
        });
        if (event.kind === 'task' && event.state === 'WORKING')
          this.lastWorking.set(key, this.now().toISOString());
      } catch (err) {
        if (err instanceof MessagingError && err.code === 'conflict') continue;
        const reason = errorText(err);
        this.finish(row, 'failed', reason);
        await this.notice(
          original,
          `could not record a2a:${row.alias}'s reply: ${reason}`
        );
        return;
      }
    }
  }

  // Disabled: stop following, keep deliveries held for `enable`. Removed:
  // fail its unfinished rows, close its open direct questions and handoffs
  // and the questions it asked, and tombstone all its rows (remote ids
  // cleared), so the alias can be reused without the old peer's context.
  peerGone(alias: string, why: 'disabled' | 'removed'): void {
    for (const [key, ac] of this.trackers)
      if (key.endsWith(` ${alias}`)) ac.abort();
    this.queues.delete(alias);
    if (why === 'disabled') return;
    const reason = removedReason(alias);
    const at = this.now().toISOString();
    const unfinished = this.deps.store.outboundOf(alias, ['queued', 'open']);
    const seen = new Set(unfinished.map((r) => r.messageId));
    for (const d of this.deps.messages.deliveries({
      recipient: `a2a:${alias}`,
      states: ['held'],
    })) {
      if (seen.has(d.messageId)) continue;
      const m = this.deps.engine.getMessage(d.messageId);
      if (m === null) continue;
      seen.add(m.id);
      unfinished.push({
        messageId: m.id,
        alias,
        thread: m.thread,
        remoteTaskId: null,
        remoteContextId: null,
        state: 'queued',
        attempts: 0,
        firstAttemptAt: at,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: at,
      });
    }
    for (const row of unfinished) {
      this.deps.store.putOutbound({
        ...row,
        state: 'failed',
        remoteTaskId: null,
        remoteContextId: null,
        lastError: reason,
        nextAttemptAt: null,
        updatedAt: at,
      });
      this.lastWorking.delete(`${row.messageId} ${alias}`);
      const original = this.deps.engine.getMessage(row.messageId);
      if (original !== null)
        this.giveUp(original, this.viaOf(row), reason, false).catch(
          (err: unknown) =>
            console.error('a2a: closing after removal failed', err)
        );
    }
    for (const row of this.deps.store.outboundOf(alias, ['done', 'failed'])) {
      if (seen.has(row.messageId)) continue;
      this.deps.store.putOutbound({
        ...row,
        remoteTaskId: null,
        remoteContextId: null,
        lastError: reason,
        updatedAt: at,
      });
    }
    // The removed peer's own open questions wait on someone no longer there.
    for (const q of this.deps.engine.openBlocking()) {
      if (q.from === `a2a:${alias}`) this.closeQuietly(q.id, reason);
    }
  }
}

// Builds and starts the worker over a peer service, and routes peer changes to it.
export function startOutbound(
  peers: PeerService,
  opts: { pollMs?: (polls: number) => number; concurrency?: number } = {}
): { worker: OutboundWorker; stop: () => void } {
  const d = peers.deps;
  const worker: OutboundWorker = new OutboundWorker({
    engine: d.engine,
    messages: d.messages,
    store: d.store,
    policy: () => d.policy(),
    clientFor: (row) => peerClientFor(d, row),
    refreshPeer: async (alias) => {
      const row = await refreshPeer(d, peers.notices, alias);
      if (row.status !== 'active') peers.emit(alias, 'disabled');
    },
    markAuthFailed: (alias) => {
      markAuthFailed(d, peers.notices, alias);
      worker.peerGone(alias, 'disabled');
    },
    // Read at call time (d.lookup, not a copy), so a test can swap the resolver.
    guard: async (row) => {
      const guard = peerGuard(d, row);
      if (guard === undefined) return; // an operator admitted private addresses on purpose
      await guardPublicUrl(row.interfaceUrl, {
        ...guard,
        field: 'interfaceUrl',
      });
    },
    disablePeer: (alias, reason) => {
      disablePeer(
        d,
        peers.notices,
        alias,
        'blocked-address',
        `a2a:${alias} was disabled: ${reason}. Check where its name resolves, then enable it in Settings → A2A → Peers.`
      );
      peers.emit(alias, 'disabled');
    },
    now: () => d.now?.() ?? new Date(),
    ...opts,
  });
  const stopWorker = worker.start();
  const offPeers = peers.onChange((alias, what) => {
    if (what === 'removed' || what === 'disabled') worker.peerGone(alias, what);
    else worker.kick(alias);
  });
  return {
    worker,
    stop: () => {
      offPeers();
      stopWorker();
    },
  };
}
