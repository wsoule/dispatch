import type {
  A2AStore,
  Admission,
  AuthResult,
  BridgePort,
  Caller,
  CardInputs,
  CardRequest,
  ContinueInput,
  ContinueResult,
  ExtensionRoute,
  HandoffStatuses,
  ListPage,
  ListQuery,
  LookupAll,
  OpenInput,
  OpenResult,
  ReceivedRequest,
  RequestParts,
  StatusEntry,
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
  peerSelfAddressed,
  signResponse,
  signResponseFor,
  statusReply,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import type {
  A2AConfig,
  A2ASkill,
  CommandEvidence,
  CreateInput,
  TaskDoc,
  TaskStorePort,
  UpdatePatch,
} from '@dispatch/core';
import type {
  Address,
  DeliveryEngine,
  Message,
  SendInput,
  SqliteMessageStore,
} from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';
import { basename } from 'node:path';

import { closeGate, SYSTEM_SENDER } from '../messaging/gates.js';
import { settle } from '../messaging/host.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { RunResultsMemo } from './artifacts.js';
import { authenticateA2AClient } from './auth.js';
import { gatherFacts } from './facts.js';
import { approvedTasksOf, finishCancel, openHandoff } from './handoff.js';
import type { KeyService } from './keys.js';
import { completePairing } from './pairing.js';
import type { Unpairer } from './pairing.js';
import type { PeerService } from './peers.js';
import { DaemonPushConfigs } from './push.js';
import { reconcileHandoff, rowFor } from './reconcile.js';
import {
  authenticateByKey,
  revalidateSigned,
  verifySignedClient,
} from './signed.js';
import type { CardSigner } from './signing.js';
import type { BridgeWatch } from './watch.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// The status skill reports at most this many handoffs, newest first.
const STATUS_LIMIT = 50;
const SKILL_REFUSALS: Record<A2ASkill, string> = {
  ask: 'this project does not take questions or messages',
  handoff: 'this project does not take handoffs',
  status: 'this project does not offer the status skill',
};

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
  // How the project's statuses read to the handoff code.
  statuses: () => HandoffStatuses;
  cardBase: () => { publicUrl: string; version: string };
  // Task writes as POST and PATCH /api/tasks make them: checked, stored,
  // cached and broadcast.
  validateTask(input: CreateInput): string | null;
  createTask(input: CreateInput): TaskDoc;
  updateTask(id: string, patch: UpdatePatch): TaskDoc;
  // What a handoff's work artifacts read: a run's recorded command evidence,
  // its patch against its base (null once it has none) and PR poll state.
  runEvidence(runId: string): readonly CommandEvidence[];
  runPatch(runId: string): string | null;
  prOpen(url: string): boolean;
  // Those evidence and patch reads, kept per task's latest settled run.
  runResults: RunResultsMemo;
  now?: () => Date;
  // Resolves webhook names for the push guard; tests swap it.
  lookup?: LookupAll;
  // The card signer, created on first use; null serves the card unsigned.
  signer?: () => CardSigner | null;
  // The peer service, once a2a.db is open; pairing writes peers through it.
  peers?: () => PeerService | null;
  // Unpairing's notices and their retries, once a2a.db is open.
  unpairer?: () => Unpairer | null;
  // Rotations and peers' key statements, once a2a.db is open.
  keys?: () => KeyService | null;
}

// dispatchd's BridgePort: every inbound A2A request becomes an engine send
// as the client (never deciding), and every read is gathered fresh.
export class DaemonBridgePort implements BridgePort {
  private readonly requestTimes = new Map<string, number[]>();
  private readonly streams = new Map<string, number>();
  readonly pushConfigs: DaemonPushConfigs;

  constructor(
    readonly deps: BridgeDeps,
    private readonly hub: BridgeWatch
  ) {
    this.pushConfigs = new DaemonPushConfigs(deps);
  }

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

  // The Dispatch tasks the caller's approved handoffs created.
  private approvedTasks(caller: Caller): Set<string> {
    return approvedTasksOf(this.deps, caller.address);
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
    const list = peerSelfAddressed(
      input.to ?? [this.deps.ownerRef],
      this.deps.ownerRef
    );
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
      // One unreadable task hides only its own scope.
      try {
        for (const m of gatherFacts(this.deps, row, { work: false }).scope)
          visible.add(m.id);
      } catch (err) {
        console.error(`a2a: could not read task ${row.id}`, err);
      }
    }
    refs.forEach((ref, i) => {
      if (!visible.has(ref.id))
        throw new MessagingError('not-found', 'unknown message', `refs[${i}]`);
    });
  }

  // The card's skills are the contract: an unoffered one is refused, not run.
  private checkOffered(kind: OpenInput['kind']): void {
    const skill =
      kind === 'handoff' || kind === 'status' ? kind : ('ask' as const);
    if (
      offeredSkills(this.deps.policy().skills, this.deps.statuses()).includes(
        skill
      )
    )
      return;
    throw new MessagingError(
      'invalid',
      SKILL_REFUSALS[skill],
      skill === 'ask' ? 'message' : 'work.skill'
    );
  }

  // Counted from the stores, so a restart does not reset them.
  private checkDurableLimits(caller: Caller, opensTask: boolean): void {
    const policy = this.deps.policy();
    const hourAgo = new Date(this.now().getTime() - HOUR_MS).toISOString();
    if (
      this.deps.messages.countFrom(
        caller.address,
        hourAgo,
        false,
        undefined,
        this.now().toISOString()
      ) >= policy.sendsPerHour
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
        (a) => this.deps.store.getClient(a)?.auth ?? null,
        bearer
      )
    );
  }

  // The in-daemon listener verifies against its own configured URL.
  authenticateSigned(req: ReceivedRequest): Promise<AuthResult | null> {
    return this.authenticateSignedAt(req, this.deps.cardBase().publicUrl);
  }

  // A standalone host's forwarded request, verified against that host's pinned URL.
  authenticateSignedAt(
    req: ReceivedRequest,
    origin: string
  ): Promise<AuthResult | null> {
    return settle(() => verifySignedClient(this.deps, req, origin));
  }

  revalidate(caller: Caller): Promise<boolean> {
    return settle(() => revalidateSigned(this.deps, caller));
  }

  // Signs the listener's reply to a signed request, for the URL the client
  // was told to call; unsigned (and so refused by the peer) when signing is off.
  async signResponse(res: Response, req: Request): Promise<Response> {
    const signer = this.deps.signer?.() ?? null;
    if (signer === null) return res;
    const url = new URL(req.url);
    const origin = new URL(this.deps.cardBase().publicUrl).origin;
    return signResponseFor(
      res,
      {
        method: req.method,
        targetUri: `${origin}${url.pathname}${url.search}`,
        headers: req.headers,
      },
      signer.requestKey(),
      this.now()
    );
  }

  // The signature headers for a standalone host's reply, for that host's URL;
  // null when signing is off.
  signFor(
    res: { status: number; headers: Headers; body: Uint8Array | null },
    request: RequestParts
  ): Record<string, string> | null {
    const signer = this.deps.signer?.() ?? null;
    if (signer === null) return null;
    const key = signer.requestKey();
    return signResponse({
      status: res.status,
      headers: res.headers,
      body: res.body,
      request,
      keyid: key.keyid,
      privateKey: key.privateKey,
      now: this.now(),
    });
  }

  // This project's last key-change or revocation statement, public.
  keyStatement(): Promise<string | null> {
    return Promise.resolve(this.deps.keys?.()?.statement() ?? null);
  }

  // The listener's extension routes: a pairing proof or an unpair notice.
  async extension(route: ExtensionRoute, req: Request): Promise<Response> {
    const url = new URL(req.url);
    return this.extensionAt(
      route,
      {
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        body: new Uint8Array(await req.arrayBuffer()),
      },
      this.deps.cardBase().publicUrl
    );
  }

  // An extension request received at publicUrl (this listener's, or a host's
  // pinned URL); replies are signed for that URL.
  async extensionAt(
    route: ExtensionRoute,
    r: ReceivedRequest,
    publicUrl: string
  ): Promise<Response> {
    const peers = this.deps.peers?.() ?? null;
    const unpairer = this.deps.unpairer?.() ?? null;
    if (peers === null) return new Response('not found', { status: 404 });
    const parts = {
      method: r.method,
      targetUri: `${new URL(publicUrl).origin}${r.path}${r.query}`,
      headers: r.headers,
    };
    const d = { ...peers.deps, notices: peers.notices, emit: peers.emit };
    if (route === 'pair')
      return completePairing(d, r.body ?? new Uint8Array(), parts);
    if (route === 'key-change') {
      const keys = this.deps.keys?.() ?? null;
      if (keys === null) return new Response('not found', { status: 404 });
      return keys.receive(r.body, parts);
    }
    if (unpairer === null) return new Response('not found', { status: 404 });
    return unpairer.receive(
      await this.authenticateSignedAt(r, publicUrl),
      r.body,
      parts
    );
  }

  // A signed caller re-checked by address and the key it proved (a
  // standalone host's session).
  authenticateSignedAddress(
    address: string,
    keyid: string
  ): Promise<AuthResult> {
    return settle(() => authenticateByKey(this.deps, address, keyid));
  }

  // Requests per minute and open streams, per client, in memory.
  admit(caller: Caller, what: 'request' | 'stream'): Promise<Admission> {
    return settle(() =>
      what === 'stream' ? this.admitStream(caller) : this.admitRequest(caller)
    );
  }

  // `req` comes only from a trusted host (T36), never from a request's Host
  // or X-Forwarded-* headers; the listener's card uses the configured URL.
  async card(req: CardRequest = {}): Promise<CardInputs> {
    const policy = this.deps.policy();
    const base = this.deps.cardBase();
    const inputs: CardInputs = {
      name: policy.name ?? basename(this.deps.rootDir),
      description: policy.description,
      publicUrl: req.publicUrl ?? base.publicUrl,
      version: base.version,
      skills: offeredSkills(policy.skills, this.deps.statuses()),
      blockingWaitSec: policy.blockingWaitSec,
      pushNotifications: req.standalone !== true,
    };
    const signer = this.deps.signer?.() ?? null;
    if (signer === null) return inputs;
    return {
      ...inputs,
      signatures: await signer.signaturesFor(inputs),
      jwks: signer.jwks(),
    };
  }

  // A replayed messageId returns its first result before any limit applies;
  // an ask or a handoff opens a task, status and plain sends get a direct reply.
  async open(caller: Caller, input: OpenInput): Promise<OpenResult> {
    const prior = this.deps.messages.byIdemKey(
      caller.address,
      input.clientMessageId
    );
    if (prior !== null) {
      if (prior.kind !== 'question' && prior.kind !== 'handoff')
        return this.delivered(prior);
      this.deps.store.insertTask(rowFor(caller.address, prior));
      const row = this.deps.store.getTask(prior.id);
      // A first try that failed before its draft or gate finishes them now.
      if (
        row?.skill === 'handoff' &&
        (row.dispatchTask === null || row.gate === null)
      )
        await reconcileHandoff(this.deps, this.hub, row);
      return { kind: 'task', taskId: prior.id };
    }
    this.checkOffered(input.kind);
    if (input.kind === 'status') return this.statusSkill(caller, input);
    this.checkDurableLimits(
      caller,
      input.kind === 'ask' || input.kind === 'handoff'
    );
    this.checkRefs(caller, input.refs);
    if (input.kind === 'handoff')
      return openHandoff(this.deps, this.hub, caller, input);
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
    const facts = gatherFacts(this.deps, row, { work: false });
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

  // Where a continuation outside INPUT_REQUIRED goes: an ask's recipients; a
  // handoff's task once approved, its owner until then.
  protected continuationRecipients(row: TaskRow, facts: TaskFacts): Address[] {
    if (row.skill === 'ask') return facts.root.to;
    const task = facts.task;
    return task !== null && task !== 'deleted' && task.approved
      ? [`task:${task.id}`]
      : [this.deps.ownerRef];
  }

  // The caller's handoffs (or the one `work.task` names), newest first; it
  // opens no task and sends nothing.
  private statusSkill(caller: Caller, input: OpenInput): OpenResult {
    const named = input.work?.skill === 'status' ? input.work.task : undefined;
    const rows = this.deps.store
      .tasksOf(caller.address)
      .filter(
        (r) => r.skill === 'handoff' && (named === undefined || r.id === named)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, STATUS_LIMIT);
    const entries: StatusEntry[] = [];
    for (const row of rows) {
      const entry = this.statusEntry(row);
      if (entry !== null) entries.push(entry);
    }
    return { kind: 'reply', ...statusReply(entries) };
  }

  // One handoff's status line, or null while it has no Dispatch task.
  private statusEntry(row: TaskRow): StatusEntry | null {
    const facts = gatherFacts(this.deps, row);
    const task = facts.task;
    if (task === null || task === 'deleted') return null;
    const { stage } = decideState(facts);
    const pr = facts.work.pr;
    return {
      a2aTask: row.id,
      task: task.id,
      title: task.title,
      status: task.status,
      ...(stage === undefined ? {} : { stage }),
      ...(pr?.kind === 'pr' ? { pr: pr.url } : {}),
    };
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

  // Closes an unanswered ask, or a handoff still awaiting the owner, as the
  // system; a second cancel is a no-op.
  async cancel(caller: Caller, taskId: string): Promise<void> {
    const row = this.ownedRow(caller, taskId);
    if (row.canceledAt !== null) return;
    const facts = gatherFacts(this.deps, row, { work: false });
    if (TERMINAL_STATES.has(decideState(facts).state)) {
      throw new A2AError(
        'TASK_NOT_CANCELABLE',
        'this task is already finished'
      );
    }
    if (row.skill === 'handoff') return this.cancelHandoff(caller, row);
    if (
      !this.canceledThenClosed(row.id, row.id, `canceled by ${caller.address}`)
    ) {
      throw new A2AError(
        'TASK_NOT_CANCELABLE',
        'this question was just answered'
      );
    }
    this.hub.recompute(row.id);
  }

  // Records canceledAt before closing the gate, so a crash between the two
  // still reads CANCELED; an answer that won the race takes it back.
  private canceledThenClosed(
    taskId: string,
    gate: string,
    reason: string
  ): boolean {
    this.deps.store.updateTask(taskId, {
      canceledAt: this.now().toISOString(),
    });
    let closed = false;
    try {
      closed = closeGate(this.deps.engine, gate, reason);
    } finally {
      if (!closed) this.deps.store.updateTask(taskId, { canceledAt: null });
    }
    return closed;
  }

  // A proposal still open is closed and its draft dropped; once the owner has
  // approved, nothing is dropped and the owner hears the client asked.
  private async cancelHandoff(caller: Caller, row: TaskRow): Promise<void> {
    const { engine } = this.deps;
    if (row.gate !== null && engine.answerOf(row.gate) !== null) {
      await engine.send(
        {
          to: [this.deps.ownerRef],
          kind: 'notice',
          body: `${caller.address} asked to cancel ${row.dispatchTask ?? row.id} over A2A.`,
          refs: [{ type: 'message', id: row.id }],
          // A client asking again replays this notice rather than repeating it.
          idempotencyKey: `a2a-cancel:${row.id}`,
        },
        SYSTEM_SENDER
      );
      throw new A2AError(
        'TASK_NOT_CANCELABLE',
        'the task is approved; the project owner was notified'
      );
    }
    if (row.gate === null) {
      this.deps.store.updateTask(row.id, {
        canceledAt: this.now().toISOString(),
      });
    } else if (
      !this.canceledThenClosed(row.id, row.gate, 'canceled by the client')
    ) {
      throw new A2AError(
        'TASK_NOT_CANCELABLE',
        'the project owner just answered this proposal'
      );
    }
    await finishCancel(this.deps, this.hub, row);
  }

  watch(caller: Caller, taskId: string, onChange: () => void): () => void {
    const row = this.deps.store.getTask(taskId);
    if (row === null || row.client !== caller.address) return () => {};
    return this.hub.add(taskId, onChange);
  }
}
