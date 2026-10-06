import type {
  Admission,
  AuthResult,
  BridgePort,
  Caller,
  CardInputs,
  ContinueInput,
  ContinueResult,
  ListPage,
  OpenInput,
  OpenResult,
  TaskFacts,
} from '@dispatch-foo/a2a';
import { handleA2A, IpLimiter } from '@dispatch-foo/a2a';
import { DEFAULT_A2A } from '@dispatch-foo/core';
import type { Message } from '@dispatch-foo/protocol';
import { MessagingError } from '@dispatch-foo/protocol';

const CALLER: Caller = {
  address: 'agent:peer/a2a.dispatch',
  name: 'a2a.dispatch',
};
const OWNER = 'human:peer-owner';
let seq = 0;

// The same request with a pre-1.0 version header, so handleA2A answers VERSION_NOT_SUPPORTED.
function asPreOneClient(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set('A2A-Version', '0.3');
  return new Request(req, { headers });
}

function msg(over: Partial<Message>): Message {
  seq += 1;
  const id = `m-fx${String(seq).padStart(6, '0')}`;
  return {
    id,
    thread: id,
    replyTo: null,
    from: OWNER,
    to: [CALLER.address],
    kind: 'message',
    body: '',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

// A scripted A2A agent served by handleA2A on loopback. Every message opens
// (or, for a repeated messageId, returns) a task that stays WORKING until the
// test answers or asks.
export class FixturePeer implements BridgePort {
  readonly opened: OpenInput[] = [];
  readonly continued: ContinueInput[] = [];
  /** Answer every request with this HTTP status instead of serving A2A (503, 404, …). */
  status = 200;
  /** The body sent with `status`. */
  statusBody = 'unavailable';
  /** Answer every A2A call (never the card) as a peer that no longer accepts A2A 1.0. */
  versionNotSupported = false;
  /** The interface URL the card names, when not its own (an origin move). */
  cardPublicUrl: string | null = null;
  /** How many times the card was fetched (a refresh adds one). */
  cardFetches = 0;
  /** HTTP message sends and task reads received, deduped or not. */
  sends = 0;
  taskReads = 0;
  /** Refuses every token as a revoked client (403 AUTH_AGENT_REVOKED). */
  revoked = false;
  /** Refuses every opening message's recipient (403 FORBIDDEN_ADDRESS). */
  refuseRecipient = false;
  /** Delays each message send by this long, to hold a relay in flight. */
  sendDelayMs = 0;
  url = '';
  private readonly tasks = new Map<string, TaskFacts>();
  private readonly byClientId = new Map<string, string>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private server: ReturnType<typeof Bun.serve> | null = null;

  start(): this {
    const limiter = new IpLimiter({ failuresPerMinute: 10_000 });
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path.endsWith('/message:send')) {
          this.sends += 1;
          if (this.sendDelayMs > 0) await Bun.sleep(this.sendDelayMs);
        }
        if (this.status !== 200)
          return new Response(this.statusBody, { status: this.status });
        if (path === '/.well-known/agent-card.json') this.cardFetches += 1;
        if (
          req.method === 'GET' &&
          path.startsWith('/a2a/v1/tasks/') &&
          !path.includes(':')
        )
          this.taskReads += 1;
        const wire =
          this.versionNotSupported && path.startsWith('/a2a/')
            ? asPreOneClient(req)
            : req;
        return handleA2A(wire, this, {
          basePath: '/a2a/v1',
          policy: { ...DEFAULT_A2A, blockingWaitSec: 1 },
          clientIp: '127.0.0.1',
          limiter,
        });
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}`;
    return this;
  }

  cardUrl(): string {
    return `${this.url}/.well-known/agent-card.json`;
  }

  latest(): string {
    return [...this.tasks.keys()].at(-1) ?? '';
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
  }

  private put(f: TaskFacts): void {
    this.tasks.set(f.id, f);
    for (const fn of this.watchers.get(f.id) ?? []) fn();
  }

  private current(id: string): TaskFacts {
    const f = this.tasks.get(id);
    if (f === undefined) throw new Error(`no fixture task ${id}`);
    return f;
  }

  // Drops a task, so reading it answers TASK_NOT_FOUND (404).
  forget(taskId: string): void {
    this.tasks.delete(taskId);
    for (const fn of this.watchers.get(taskId) ?? []) fn();
  }

  answer(taskId: string, body: string): void {
    const cur = this.current(taskId);
    const answer = msg({
      thread: taskId,
      replyTo: taskId,
      kind: 'answer',
      body,
    });
    this.put({
      ...cur,
      answer,
      openQuestions: [],
      scope: [...cur.scope, answer],
    });
  }

  ask(taskId: string, body: string, choices?: string[]): void {
    const cur = this.current(taskId);
    const q = msg({
      thread: taskId,
      replyTo: taskId,
      kind: 'question',
      blocking: true,
      body,
      ...(choices === undefined ? {} : { choices }),
    });
    this.put({ ...cur, openQuestions: [q], scope: [...cur.scope, q] });
  }

  authenticate(bearer: string): Promise<AuthResult> {
    return Promise.resolve(
      this.revoked
        ? {
            ok: false,
            status: 403,
            reason: 'AUTH_AGENT_REVOKED',
            message: 'revoked',
          }
        : bearer === 'peer-token'
          ? { ok: true, caller: CALLER }
          : {
              ok: false,
              status: 401,
              reason: 'AUTH_INVALID_TOKEN',
              message: 'unknown token',
            }
    );
  }

  admit(): Promise<Admission> {
    return Promise.resolve({ ok: true });
  }

  card(): Promise<CardInputs> {
    return Promise.resolve({
      name: 'Fixture peer',
      description: null,
      publicUrl: this.cardPublicUrl ?? this.url,
      version: 'fixture',
      skills: ['ask'],
      blockingWaitSec: 1,
      pushNotifications: false,
    });
  }

  open(_caller: Caller, input: OpenInput): Promise<OpenResult> {
    if (this.refuseRecipient)
      return Promise.reject(
        new MessagingError(
          'forbidden',
          'not reachable from this client',
          'to[0]'
        )
      );
    const known = this.byClientId.get(input.clientMessageId);
    if (known !== undefined)
      return Promise.resolve({ kind: 'task', taskId: known });
    this.opened.push(input);
    const root = msg({
      from: CALLER.address,
      to: [OWNER],
      kind: 'question',
      blocking: true,
      body: input.body,
    });
    this.byClientId.set(input.clientMessageId, root.id);
    this.put({
      id: root.id,
      contextId: root.id,
      skill: input.kind === 'handoff' ? 'handoff' : 'ask',
      client: CALLER.address,
      createdAt: root.createdAt,
      canceledAt: null,
      declinedAt: null,
      root,
      scope: [root],
      rootDeliveries: ['notified'],
      answer: null,
      openQuestions: [],
      openGates: [],
      task: null,
      dropped: null,
      recipientTaskDropped: false,
      work: {},
      clientIds: { [root.id]: input.clientMessageId },
    });
    return Promise.resolve({ kind: 'task', taskId: root.id });
  }

  continue(_caller: Caller, input: ContinueInput): Promise<ContinueResult> {
    this.continued.push(input);
    const cur = this.current(input.taskId);
    const reply = msg({
      from: CALLER.address,
      to: [OWNER],
      thread: input.taskId,
      replyTo: cur.openQuestions[0]?.id ?? input.taskId,
      kind: 'answer',
      body: input.body,
    });
    this.put({ ...cur, openQuestions: [], scope: [...cur.scope, reply] });
    return Promise.resolve({ reask: null });
  }

  facts(_caller: Caller, taskId: string): Promise<TaskFacts | null> {
    return Promise.resolve(this.tasks.get(taskId) ?? null);
  }

  list(): Promise<ListPage> {
    return Promise.resolve({
      ids: [...this.tasks.keys()],
      nextPageToken: '',
      totalSize: this.tasks.size,
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  watch(_caller: Caller, taskId: string, onChange: () => void): () => void {
    const set = this.watchers.get(taskId) ?? new Set();
    set.add(onChange);
    this.watchers.set(taskId, set);
    return () => {
      set.delete(onChange);
    };
  }
}
