import type { Message } from '@dispatch/protocol';

import { A2AError } from '../../src/errors.js';
import type {
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
  PushConfigPort,
  TaskFacts,
} from '../../src/port.js';
import { decideState, project } from '../../src/projection.js';
import type { ProjectionView } from '../../src/projection.js';
import { deliverPush } from '../../src/push.js';
import type { PushConfigInput, PushConfigJson } from '../../src/push.js';
import type { Snapshot } from '../../src/server/sse.js';
import { eventsBetween, snapshotOf } from '../../src/server/sse.js';
import type { ArtifactJson } from '../../src/wire.js';

const CALLER: Caller = { address: 'agent:tck/a2a.tck', name: 'a2a.tck' };
const OWNER = 'human:tck-owner';
const TEXT: [prefix: string, text: string][] = [
  ['tck-complete-task', 'Hello from TCK'],
  ['tck-artifact-text', 'Generated text content'],
  ['tck-stream-001', 'Stream hello from TCK'],
  ['tck-stream-003', 'Stream task lifecycle'],
  ['tck-stream-ordering-001', 'Ordered output'],
  ['tck-stream-artifact-text', 'Streamed text content'],
];
const FILE: ArtifactJson = {
  artifactId: 'output',
  name: 'output.txt',
  parts: [
    {
      raw: Buffer.from('TCK file content').toString('base64'),
      mediaType: 'text/plain',
      filename: 'output.txt',
    },
  ],
};
const FILE_URL: ArtifactJson = {
  artifactId: 'output',
  name: 'output.txt',
  parts: [
    {
      url: 'https://example.com/output.txt',
      mediaType: 'text/plain',
      filename: 'output.txt',
    },
  ],
};
const DATA: ArtifactJson = {
  artifactId: 'data',
  name: 'data',
  parts: [{ data: { key: 'value', count: 42 }, mediaType: 'application/json' }],
};

const PUSH_VIEW: ProjectionView = {
  client: CALLER.address,
  extensions: new Set(),
  textMediaType: 'text/markdown',
  historyLength: 0,
  includeArtifacts: true,
};

// Push configs for the SUT, keyed by task. The TCK's webhook listens on its
// own local host, so delivery here is unguarded: never point it elsewhere.
class TckPushConfigs implements PushConfigPort {
  readonly configs = new Map<string, Map<string, PushConfigJson>>();
  readonly last = new Map<string, Snapshot>();
  constructor(private readonly exists: (taskId: string) => boolean) {}

  check(): Promise<void> {
    return Promise.resolve();
  }

  private of(taskId: string): Map<string, PushConfigJson> {
    if (!this.exists(taskId))
      throw new A2AError('TASK_NOT_FOUND', 'task not found');
    const found = this.configs.get(taskId) ?? new Map<string, PushConfigJson>();
    this.configs.set(taskId, found);
    return found;
  }

  create(
    _caller: Caller,
    taskId: string,
    input: PushConfigInput
  ): Promise<PushConfigJson> {
    const configs = this.of(taskId);
    const config: PushConfigJson = {
      id: input.id ?? `cfg-${configs.size + 1}`,
      taskId,
      url: input.url,
      ...(input.token === undefined ? {} : { token: input.token }),
      ...(input.authentication === undefined
        ? {}
        : { authentication: input.authentication }),
    };
    configs.set(config.id, config);
    return Promise.resolve(config);
  }

  get(_caller: Caller, taskId: string, id: string) {
    return Promise.resolve(this.of(taskId).get(id) ?? null);
  }

  list(_caller: Caller, taskId: string) {
    return Promise.resolve([...this.of(taskId).values()]);
  }

  delete(_caller: Caller, taskId: string, id: string) {
    this.of(taskId).delete(id);
    return Promise.resolve();
  }

  // Sends each config of the task what changed since that config last heard.
  deliver(f: TaskFacts): void {
    for (const config of this.configs.get(f.id)?.values() ?? []) {
      const key = `${f.id} ${config.id}`;
      const next = snapshotOf(project(f, PUSH_VIEW), decideState(f).state);
      const events = eventsBetween(this.last.get(key) ?? null, next);
      this.last.set(key, next);
      void (async () => {
        for (const event of events)
          await deliverPush(config, event, { unguarded: true });
      })();
    }
  }
}

let seq = 0;
function message(over: Partial<Message>): Message {
  seq += 1;
  const id = `m-tck-${String(seq).padStart(6, '0')}`;
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

// The TCK's scenarios by messageId prefix (core_operations.feature and
// streaming.feature at 263b9cf). It exercises the binding, not Dispatch semantics.
export class TckBridgePort implements BridgePort {
  publicUrl = 'http://127.0.0.1';
  private readonly tasks = new Map<string, TaskFacts>();
  private readonly watchers = new Map<string, Set<() => void>>();
  readonly pushConfigs = new TckPushConfigs((id) => this.tasks.has(id));

  authenticate(): Promise<AuthResult> {
    return Promise.resolve({ ok: true, caller: CALLER });
  }
  admit(): Promise<Admission> {
    return Promise.resolve({ ok: true, release: () => {} });
  }
  card(): Promise<CardInputs> {
    return Promise.resolve({
      name: 'Dispatch TCK SUT',
      description: null,
      publicUrl: this.publicUrl,
      version: 'tck',
      skills: ['ask'],
      blockingWaitSec: 60,
      pushNotifications: true,
    });
  }

  private put(f: TaskFacts): void {
    this.tasks.set(f.id, f);
    for (const fn of this.watchers.get(f.id) ?? []) fn();
    this.pushConfigs.deliver(f);
  }

  private current(id: string): TaskFacts {
    const f = this.tasks.get(id);
    if (f === undefined) throw new A2AError('TASK_NOT_FOUND', 'task not found');
    return f;
  }

  // A client's contextId is kept, never replaced (§3.4.1); dispatchd refuses
  // one that is not a thread the client is in.
  private begin(input: OpenInput): TaskFacts {
    const asked = message({
      from: CALLER.address,
      to: [OWNER],
      kind: 'question',
      blocking: true,
      body: input.body,
    });
    const root = { ...asked, thread: input.contextId ?? asked.id };
    const f: TaskFacts = {
      id: root.id,
      contextId: root.thread,
      skill: 'ask',
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
    };
    this.put(f);
    return f;
  }

  private complete(
    id: string,
    body: string,
    hostArtifacts: ArtifactJson[] = []
  ): void {
    const cur = this.current(id);
    const answer = message({
      thread: cur.contextId,
      replyTo: id,
      kind: 'answer',
      body,
    });
    this.put({
      ...cur,
      answer,
      openQuestions: [],
      scope: [...cur.scope, answer],
      hostArtifacts,
    });
  }

  open(_caller: Caller, input: OpenInput): Promise<OpenResult> {
    const key = input.clientMessageId;
    if (key.startsWith('tck-message-response'))
      return Promise.resolve({
        kind: 'reply',
        text: 'Direct message response',
      });
    const { id, contextId } = this.begin(input);
    const later = (ms: number, fn: () => void) => void setTimeout(fn, ms);
    const text = TEXT.find(([prefix]) => key.startsWith(prefix))?.[1];
    if (key.startsWith('tck-input-required')) {
      const q = message({
        thread: contextId,
        replyTo: id,
        kind: 'question',
        blocking: true,
        body: 'Please provide input',
      });
      const cur = this.current(id);
      this.put({ ...cur, openQuestions: [q], scope: [...cur.scope, q] });
    } else if (key.startsWith('tck-reject-task')) {
      const cur = this.current(id);
      const answer = message({
        thread: contextId,
        replyTo: id,
        kind: 'answer',
        body: 'rejected',
      });
      this.put({
        ...cur,
        declinedAt: new Date().toISOString(),
        answer,
        scope: [...cur.scope, answer],
      });
    } else if (key.startsWith('tck-artifact-file-url')) {
      this.complete(id, 'Done', [FILE_URL]);
    } else if (key.startsWith('tck-artifact-file')) {
      this.complete(id, 'Done', [FILE]);
    } else if (key.startsWith('tck-artifact-data')) {
      this.complete(id, 'Done', [DATA]);
    } else if (key.startsWith('tck-stream-artifact-chunked')) {
      later(100, () =>
        this.put({
          ...this.current(id),
          hostArtifacts: [
            { artifactId: 'chunked', parts: [{ text: 'chunk-1 ' }] },
          ],
        })
      );
      later(200, () =>
        this.complete(id, 'Done', [
          {
            artifactId: 'chunked',
            parts: [{ text: 'chunk-1 ' }, { text: 'chunk-2' }],
          },
        ])
      );
    } else if (key.startsWith('tck-stream-artifact-file')) {
      later(100, () => this.complete(id, 'Done', [FILE]));
    } else if (key.startsWith('tck-stream')) {
      later(100, () => this.complete(id, text ?? 'Done'));
    } else if (key.startsWith('test-resubscribe-message-id')) {
      later(Number(process.env.TCK_RESUBSCRIBE_DELAY_MS ?? 4000), () =>
        this.complete(id, 'Done')
      );
    } else {
      this.complete(id, text ?? input.body);
    }
    return Promise.resolve({ kind: 'task', taskId: id });
  }

  continue(_caller: Caller, input: ContinueInput): Promise<ContinueResult> {
    this.complete(input.taskId, `Received: ${input.body}`);
    return Promise.resolve({ reask: null });
  }

  facts(_caller: Caller, taskId: string): Promise<TaskFacts | null> {
    return Promise.resolve(this.tasks.get(taskId) ?? null);
  }

  // Filters by contextId only; the MUST level filters on nothing else.
  list(_caller: Caller, q: ListQuery): Promise<ListPage> {
    const ids = [...this.tasks.keys()]
      .filter(
        (id) =>
          q.contextId === undefined ||
          this.tasks.get(id)?.contextId === q.contextId
      )
      .reverse();
    return Promise.resolve({
      ids: ids.slice(0, q.pageSize),
      nextPageToken: '',
      totalSize: ids.length,
    });
  }

  cancel(_caller: Caller, taskId: string): Promise<void> {
    const cur = this.current(taskId);
    if (cur.canceledAt !== null) return Promise.resolve();
    if (cur.answer !== null || cur.declinedAt !== null)
      throw new A2AError(
        'TASK_NOT_CANCELABLE',
        'this task is already finished'
      );
    this.put({ ...cur, canceledAt: new Date().toISOString() });
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
