import type {
  A2AStore,
  Admission,
  AuthResult,
  BridgePort,
  Caller,
  CardInputs,
  ContinueInput,
  ContinueResult,
  ListPage,
  ListQuery,
  OpenInput,
  OpenResult,
  TaskFacts,
  TaskRow,
} from '@dispatch/a2a';
import {
  A2AError,
  checkInboundRecipients,
  decideState,
  decodePageToken,
  encodePageToken,
  matchChoice,
  offeredSkills,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import type { A2AConfig, TaskStorePort } from '@dispatch/core';
import type {
  Address,
  DeliveryEngine,
  Message,
  SendInput,
  SqliteMessageStore,
} from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';
import { basename } from 'node:path';

import { closeGate } from '../messaging/gates.js';
import { settle } from '../messaging/host.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { authenticateA2AClient } from './auth.js';
import { gatherFacts } from './facts.js';
import { rowFor } from './reconcile.js';
import type { BridgeWatch } from './watch.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// What the daemon's bridge reads and writes. `policy` is a function so a
// config reload (or a test) can swap it; every call reads it afresh.
export interface BridgeDeps {
  rootDir: string;
  engine: DeliveryEngine;
  messages: SqliteMessageStore;
  store: A2AStore;
  tasks: TaskStorePort;
  runs: Pick<Orchestrator, 'list' | 'taskIdOfRun'>;
  ownerRef: Address;
  policy: () => A2AConfig;
  statuses: () => string[];
  cardBase: () => { publicUrl: string; version: string };
  now?: () => Date;
}

// dispatchd's BridgePort: every inbound A2A request becomes an engine send
// as the client (never deciding), and every read is gathered fresh.
export class DaemonBridgePort implements BridgePort {
  private readonly requestTimes = new Map<string, number[]>();
  private readonly streams = new Map<string, number>();

  constructor(
    readonly deps: BridgeDeps,
    private readonly hub: BridgeWatch
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private sender(caller: Caller) {
    return { address: caller.address, canDecide: false };
  }

  // The caller's row, or the same not-found for an absent and a foreign task.
  private ownedRow(caller: Caller, taskId: string): TaskRow {
    const row = this.deps.store.getTask(taskId);
    if (row === null || row.client !== caller.address)
      throw new MessagingError('not-found', 'task not found', 'taskId');
    return row;
  }

  // The Dispatch tasks the caller's approved handoffs created; none until
  // this project takes handoffs.
  private approvedTasks(_caller: Caller): Set<string> {
    return new Set();
  }

  // A reply with no `to` goes to the replied-to message's sender (the engine
  // checks participation); any other `to` must be on the client's list.
  private recipients(
    caller: Caller,
    input: Pick<OpenInput, 'to' | 'replyTo'>
  ): Address[] {
    if (input.to === null && input.replyTo !== null) {
      // Only a message addressed to the client counts; anything else falls
      // through, and the engine's replyTo check answers it as for any sender.
      const target = this.deps.engine.getMessage(input.replyTo);
      if (
        target !== null &&
        target.to.includes(caller.address) &&
        target.from !== caller.address
      )
        return [target.from];
    }
    const client = this.deps.store.getClient(caller.address);
    const list = input.to ?? [this.deps.ownerRef];
    checkInboundRecipients(list, {
      allowedHumans: [this.deps.ownerRef, ...(client?.recipients ?? [])],
      approvedTasks: this.approvedTasks(caller),
    });
    return list;
  }

  // Inbound refs may name only what the caller can see: its tasks, their
  // scope, and the Dispatch tasks of its approved handoffs.
  private checkRefs(caller: Caller, refs: OpenInput['refs']): void {
    if (refs.length === 0) return;
    const visible = new Set<string>(this.approvedTasks(caller));
    for (const row of this.deps.store.tasksOf(caller.address)) {
      visible.add(row.id);
      for (const m of gatherFacts(this.deps, row).scope) visible.add(m.id);
    }
    refs.forEach((ref, i) => {
      if (!visible.has(ref.id))
        throw new MessagingError('not-found', 'unknown message', `refs[${i}]`);
    });
  }

  // Counted from the stores, so a restart does not reset them.
  private checkDurableLimits(caller: Caller, opensTask: boolean): void {
    const policy = this.deps.policy();
    const hourAgo = new Date(this.now().getTime() - HOUR_MS).toISOString();
    if (
      this.deps.messages.countFrom(caller.address, hourAgo, false) >=
      policy.sendsPerHour
    ) {
      throw new MessagingError(
        'limited',
        `at most ${policy.sendsPerHour} sends per hour`,
        'from'
      );
    }
    if (
      opensTask &&
      this.deps.store.countOpen(caller.address) >= policy.openTasksPerClient
    ) {
      throw new MessagingError(
        'limited',
        `at most ${policy.openTasksPerClient} open tasks`,
        'from'
      );
    }
  }

  // An unknown and a foreign contextId get one answer, so neither confirms
  // that a thread exists.
  private contextError(err: unknown, input: OpenInput): unknown {
    const onContext = input.replyTo === null && input.contextId !== null;
    if (
      onContext &&
      err instanceof MessagingError &&
      err.field === 'replyTo' &&
      (err.code === 'forbidden' || err.code === 'not-found')
    ) {
      return new MessagingError(
        'invalid',
        'unknown contextId',
        'message.contextId'
      );
    }
    return err;
  }

  private delivered(m: Message): OpenResult {
    return {
      kind: 'reply',
      text: `Delivered to ${m.to.join(', ')} (${m.id}).`,
      about: { id: m.id, thread: m.thread },
    };
  }

  // One slot per open stream, returned once by its release().
  private admitStream(caller: Caller): Admission {
    const open = this.streams.get(caller.address) ?? 0;
    if (open >= this.deps.policy().streamsPerClient)
      return { ok: false, retryAfterSec: 30 };
    this.streams.set(caller.address, open + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.streams.set(
          caller.address,
          Math.max(0, (this.streams.get(caller.address) ?? 1) - 1)
        );
      },
    };
  }

  // A sliding one-minute window of request times.
  private admitRequest(caller: Caller): Admission {
    const policy = this.deps.policy();
    const now = this.now().getTime();
    const recent = (this.requestTimes.get(caller.address) ?? []).filter(
      (t) => t > now - MINUTE_MS
    );
    if (recent.length >= policy.requestsPerMinute) {
      this.requestTimes.set(caller.address, recent);
      return {
        ok: false,
        retryAfterSec: Math.max(
          1,
          Math.ceil((recent[0] + MINUTE_MS - now) / 1000)
        ),
      };
    }
    recent.push(now);
    this.requestTimes.set(caller.address, recent);
    return { ok: true };
  }

  authenticate(bearer: string): Promise<AuthResult> {
    return settle(() =>
      authenticateA2AClient(
        this.deps.messages,
        (a) => this.deps.store.getClient(a) !== null,
        bearer
      )
    );
  }

  // Requests per minute and open streams, per client, in memory.
  admit(caller: Caller, what: 'request' | 'stream'): Promise<Admission> {
    return settle(() =>
      what === 'stream' ? this.admitStream(caller) : this.admitRequest(caller)
    );
  }

  card(): Promise<CardInputs> {
    return settle(() => {
      const policy = this.deps.policy();
      const base = this.deps.cardBase();
      return {
        name: policy.name ?? basename(this.deps.rootDir),
        description: policy.description,
        publicUrl: base.publicUrl,
        version: base.version,
        skills: offeredSkills(policy.skills, this.deps.statuses()),
        blockingWaitSec: policy.blockingWaitSec,
        pushNotifications: false,
      };
    });
  }

  // A replayed messageId returns its first result before any limit applies;
  // an ask opens a task, any other kind is delivered with a direct reply.
  async open(caller: Caller, input: OpenInput): Promise<OpenResult> {
    const prior = this.deps.messages.byIdemKey(
      caller.address,
      input.clientMessageId
    );
    if (prior !== null) {
      if (prior.kind !== 'question' && prior.kind !== 'handoff')
        return this.delivered(prior);
      this.deps.store.insertTask(rowFor(caller.address, prior));
      return { kind: 'task', taskId: prior.id };
    }
    if (input.kind === 'handoff' || input.kind === 'status') {
      throw new MessagingError(
        'invalid',
        'this project does not take handoffs yet',
        'work.skill'
      );
    }
    this.checkDurableLimits(caller, input.kind === 'ask');
    this.checkRefs(caller, input.refs);
    const to = this.recipients(caller, input);
    const send: SendInput = {
      to,
      kind: input.kind === 'ask' ? 'question' : input.kind,
      body: input.body,
      refs: input.refs,
      replyTo: input.replyTo ?? input.contextId,
      idempotencyKey: input.clientMessageId,
      ...(input.data === undefined ? {} : { data: input.data }),
      ...(input.kind === 'ask'
        ? {
            blocking: true,
            ...(input.choices === undefined ? {} : { choices: input.choices }),
          }
        : {}),
    };
    let message: Message;
    try {
      ({ message } = await this.deps.engine.send(send, this.sender(caller)));
    } catch (err) {
      throw this.contextError(err, input);
    }
    if (input.kind !== 'ask') return this.delivered(message);
    this.deps.store.insertTask(rowFor(caller.address, message));
    this.hub.recompute(message.id);
    return { kind: 'task', taskId: message.id };
  }

  // In INPUT_REQUIRED the text answers the open question (re-asking on a
  // non-choice); otherwise it is a message to the root's recipients.
  async continue(
    caller: Caller,
    input: ContinueInput
  ): Promise<ContinueResult> {
    const row = this.ownedRow(caller, input.taskId);
    if (
      this.deps.messages.byIdemKey(caller.address, input.clientMessageId) !==
      null
    )
      return { reask: null };
    this.checkDurableLimits(caller, false);
    this.checkRefs(caller, input.refs);
    const facts = gatherFacts(this.deps, row);
    const decision = decideState(facts);
    const common = {
      body: input.body,
      refs: input.refs,
      idempotencyKey: input.clientMessageId,
      ...(input.data === undefined ? {} : { data: input.data }),
    };
    if (
      decision.state === 'INPUT_REQUIRED' &&
      decision.status.kind === 'message'
    ) {
      const question = decision.status.message;
      const choice = matchChoice(question.choices, input.body, input.choice);
      if (choice === null)
        return {
          reask: `Answer with one of: ${(question.choices ?? []).join(' | ')}`,
        };
      await this.deps.engine.send(
        {
          ...common,
          to: [question.from],
          kind: 'answer',
          replyTo: question.id,
          ...(choice === undefined ? {} : { choice }),
        },
        this.sender(caller)
      );
    } else {
      await this.deps.engine.send(
        {
          ...common,
          to: this.continuationRecipients(row, facts),
          kind: 'message',
          replyTo: row.id,
        },
        this.sender(caller)
      );
    }
    this.hub.recompute(row.id);
    return { reask: null };
  }

  // Where a continuation outside INPUT_REQUIRED goes: the root's recipients.
  protected continuationRecipients(_row: TaskRow, facts: TaskFacts): Address[] {
    return facts.root.to;
  }

  facts(caller: Caller, taskId: string): Promise<TaskFacts | null> {
    return settle(() => {
      const row = this.deps.store.getTask(taskId);
      return row === null || row.client !== caller.address
        ? null
        : gatherFacts(this.deps, row);
    });
  }

  list(caller: Caller, q: ListQuery): Promise<ListPage> {
    return settle(() => this.listNow(caller, q));
  }

  private listNow(caller: Caller, q: ListQuery): ListPage {
    const cursor =
      q.pageToken === undefined ? undefined : decodePageToken(q.pageToken);
    const { rows, total } = this.deps.store.listTasks({
      client: caller.address,
      limit: q.pageSize + 1,
      ...(q.contextId === undefined ? {} : { contextId: q.contextId }),
      ...(q.state === undefined ? {} : { state: q.state }),
      ...(q.after === undefined ? {} : { after: q.after }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const page = rows.slice(0, q.pageSize);
    const last = page.at(-1);
    return {
      ids: page.map((r) => r.id),
      nextPageToken:
        rows.length > q.pageSize && last !== undefined
          ? encodePageToken({ statusAt: last.statusAt, id: last.id })
          : '',
      totalSize: total,
    };
  }

  // Closes the unanswered root as the system; a second cancel is a no-op.
  cancel(caller: Caller, taskId: string): Promise<void> {
    return settle(() => this.cancelNow(caller, taskId));
  }

  private cancelNow(caller: Caller, taskId: string): void {
    const row = this.ownedRow(caller, taskId);
    if (row.canceledAt !== null) return;
    if (TERMINAL_STATES.has(decideState(gatherFacts(this.deps, row)).state)) {
      throw new A2AError(
        'TASK_NOT_CANCELABLE',
        'this task is already finished'
      );
    }
    if (!closeGate(this.deps.engine, row.id, `canceled by ${caller.address}`)) {
      throw new A2AError(
        'TASK_NOT_CANCELABLE',
        'this question was just answered'
      );
    }
    this.deps.store.updateTask(row.id, {
      canceledAt: this.now().toISOString(),
    });
    this.hub.recompute(row.id);
  }

  watch(caller: Caller, taskId: string, onChange: () => void): () => void {
    const row = this.deps.store.getTask(taskId);
    if (row === null || row.client !== caller.address) return () => {};
    return this.hub.add(taskId, onChange);
  }
}
