import { A2AError } from '../src/errors.js';
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
} from '../src/port.js';
import type { PushConfigInput, PushConfigJson } from '../src/push.js';
import { CLIENT, facts } from './facts.js';

// In-memory push configs over a FakePort's tasks.
export class MemoryPushConfigs implements PushConfigPort {
  readonly configs = new Map<string, PushConfigJson>();
  constructor(private readonly port: FakePort) {}

  private owned(caller: Caller, taskId: string): void {
    if (this.port.tasks.get(taskId)?.client !== caller.address)
      throw new A2AError('TASK_NOT_FOUND', 'task not found');
  }

  create(
    caller: Caller,
    taskId: string,
    input: PushConfigInput
  ): Promise<PushConfigJson> {
    this.owned(caller, taskId);
    const config: PushConfigJson = {
      id: input.id ?? `cfg-${this.configs.size + 1}`,
      taskId,
      url: input.url,
      ...(input.token === undefined ? {} : { token: input.token }),
      ...(input.authentication === undefined
        ? {}
        : { authentication: input.authentication }),
    };
    this.configs.set(`${taskId} ${config.id}`, config);
    return Promise.resolve(config);
  }

  get(caller: Caller, taskId: string, id: string) {
    this.owned(caller, taskId);
    return Promise.resolve(this.configs.get(`${taskId} ${id}`) ?? null);
  }

  list(caller: Caller, taskId: string) {
    this.owned(caller, taskId);
    return Promise.resolve(
      [...this.configs.values()].filter((c) => c.taskId === taskId)
    );
  }

  delete(caller: Caller, taskId: string, id: string) {
    this.owned(caller, taskId);
    this.configs.delete(`${taskId} ${id}`);
    return Promise.resolve();
  }
}

// A recording BridgePort whose world is plain maps; tests script its answers.
export class FakePort implements BridgePort {
  pushConfigs?: MemoryPushConfigs;
  calls: { method: string; args: unknown[] }[] = [];
  tokens = new Map<string, AuthResult>([
    ['good', { ok: true, caller: { address: CLIENT, name: 'a2a.acme' } }],
    [
      'other',
      {
        ok: true,
        caller: { address: 'agent:wyat/a2a.other', name: 'a2a.other' },
      },
    ],
    [
      'revoked',
      {
        ok: false,
        status: 401,
        reason: 'AUTH_AGENT_REVOKED',
        message: "this client's access was revoked",
      },
    ],
    [
      'pending',
      {
        ok: false,
        status: 403,
        reason: 'AUTH_AGENT_PENDING',
        message: 'awaiting approval in Dispatch',
      },
    ],
  ]);
  tasks = new Map<string, TaskFacts>([['m-root', facts()]]);
  cardInputs: CardInputs = {
    name: 'Acme API',
    description: null,
    publicUrl: 'http://127.0.0.1:1',
    version: '0.0.0-test',
    skills: ['ask'],
    blockingWaitSec: 60,
    pushNotifications: false,
  };
  requestAdmission: Admission = { ok: true };
  streamLimit = 5;
  openStreams = 0;
  // Thrown by watch(), as a failed a2a.db read would be.
  watchError: Error | null = null;
  private readonly watchers = new Map<string, Set<() => void>>();
  onOpen: (input: OpenInput) => OpenResult = () => ({
    kind: 'task',
    taskId: 'm-root',
  });
  onContinue: (input: ContinueInput) => ContinueResult = () => ({
    reask: null,
  });
  onCancel: (taskId: string) => void = () => {};

  authenticate(bearer: string): Promise<AuthResult> {
    this.calls.push({ method: 'authenticate', args: [bearer] });
    return Promise.resolve(
      this.tokens.get(bearer) ?? {
        ok: false,
        status: 401,
        reason: 'AUTH_INVALID_TOKEN',
        message: 'unknown token',
      }
    );
  }
  admit(_caller: Caller, what: 'request' | 'stream'): Promise<Admission> {
    if (what === 'request') return Promise.resolve(this.requestAdmission);
    if (this.openStreams >= this.streamLimit)
      return Promise.resolve({ ok: false, retryAfterSec: 1 });
    this.openStreams += 1;
    let released = false;
    return Promise.resolve({
      ok: true,
      release: () => {
        if (!released) {
          released = true;
          this.openStreams -= 1;
        }
      },
    });
  }
  card(...args: unknown[]): Promise<CardInputs> {
    this.calls.push({ method: 'card', args });
    return Promise.resolve(this.cardInputs);
  }
  open(_caller: Caller, input: OpenInput): Promise<OpenResult> {
    this.calls.push({ method: 'open', args: [input] });
    return Promise.resolve(this.onOpen(input));
  }
  continue(_caller: Caller, input: ContinueInput): Promise<ContinueResult> {
    this.calls.push({ method: 'continue', args: [input] });
    return Promise.resolve(this.onContinue(input));
  }
  facts(caller: Caller, taskId: string): Promise<TaskFacts | null> {
    const f = this.tasks.get(taskId);
    return Promise.resolve(
      f !== undefined && f.client === caller.address ? f : null
    );
  }
  list(caller: Caller, query: ListQuery): Promise<ListPage> {
    this.calls.push({ method: 'list', args: [query] });
    const ids = [...this.tasks.values()]
      .filter((f) => f.client === caller.address)
      .map((f) => f.id);
    return Promise.resolve({
      ids: ids.slice(0, query.pageSize),
      nextPageToken: '',
      totalSize: ids.length,
    });
  }
  cancel(_caller: Caller, taskId: string): Promise<void> {
    this.calls.push({ method: 'cancel', args: [taskId] });
    this.onCancel(taskId);
    return Promise.resolve();
  }
  watch(_caller: Caller, taskId: string, onChange: () => void): () => void {
    if (this.watchError !== null) throw this.watchError;
    const set = this.watchers.get(taskId) ?? new Set();
    set.add(onChange);
    this.watchers.set(taskId, set);
    return () => {
      set.delete(onChange);
    };
  }
  get activeWatchers(): number {
    return [...this.watchers.values()].reduce((n, s) => n + s.size, 0);
  }
  // Replaces a task's facts and fires its watchers, as the daemon's watch does.
  enablePush(): MemoryPushConfigs {
    this.pushConfigs = new MemoryPushConfigs(this);
    this.cardInputs = { ...this.cardInputs, pushNotifications: true };
    return this.pushConfigs;
  }

  change(taskId: string, next: TaskFacts): void {
    this.tasks.set(taskId, next);
    for (const fn of this.watchers.get(taskId) ?? []) fn();
  }
}
