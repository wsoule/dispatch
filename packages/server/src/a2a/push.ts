import type {
  A2AStore,
  Caller,
  GuardOptions,
  LookupAll,
  PushConfigInput,
  PushConfigJson,
  PushConfigPort,
  PushConfigRow,
  Snapshot,
  StreamResponseJson,
  TaskFacts,
  TaskRow,
} from '@dispatch/a2a';
import {
  A2AError,
  decideState,
  deliverPush,
  eventsBetween,
  guardPublicUrl,
  project,
  PUSH_LIMITS,
  snapshotOf,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import { MessagingError } from '@dispatch/protocol';
import { randomUUID } from 'node:crypto';

function toJson(r: PushConfigRow): PushConfigJson {
  return {
    id: r.id,
    taskId: r.taskId,
    url: r.url,
    ...(r.token === null ? {} : { token: r.token }),
    ...(r.authScheme === null
      ? {}
      : {
          authentication: {
            scheme: r.authScheme,
            ...(r.authCredentials === null
              ? {}
              : { credentials: r.authCredentials }),
          },
        }),
  };
}

// The public-address guard for push URLs, which clients choose: the resolver
// is read at each lookup, so a test can swap it.
function pushGuard(deps: { lookup?: LookupAll }): GuardOptions {
  return deps.lookup === undefined
    ? {}
    : {
        lookup: (host) =>
          (deps.lookup ?? (() => Promise.resolve([] as string[])))(host),
      };
}

// Runs `fn` as a promise, so a throw rejects instead of escaping the caller.
function later<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve) => resolve(fn()));
}

export interface PushDeps {
  store: A2AStore;
  now?: () => Date;
  lookup?: LookupAll;
}

// Push configs for the daemon's A2A tasks: the caller's own tasks only, public
// addresses only, at most 3 per task and 50 per client (spec:1768-1787).
export class DaemonPushConfigs implements PushConfigPort {
  constructor(private readonly deps: PushDeps) {}

  private owned(caller: Caller, taskId: string): void {
    const row = this.deps.store.getTask(taskId);
    if (row === null || row.client !== caller.address)
      throw new A2AError('TASK_NOT_FOUND', 'task not found');
  }

  // The URL's addresses and the caps; `id` names a config being replaced.
  async check(
    caller: Caller,
    input: PushConfigInput,
    taskId: string | null
  ): Promise<void> {
    if (taskId !== null) this.owned(caller, taskId);
    await guardPublicUrl(input.url, { ...pushGuard(this.deps), field: 'url' });
    const onTask = taskId === null ? [] : this.deps.store.pushConfigsOf(taskId);
    const replacing =
      input.id !== null && onTask.some((c) => c.id === input.id);
    if (replacing) return;
    if (onTask.length >= PUSH_LIMITS.perTask)
      throw new MessagingError(
        'limited',
        `at most ${PUSH_LIMITS.perTask} push configs per task`,
        'pushNotificationConfig'
      );
    if (
      this.deps.store.countPushConfigs(caller.address) >= PUSH_LIMITS.perClient
    )
      throw new MessagingError(
        'limited',
        `at most ${PUSH_LIMITS.perClient} push configs per client`,
        'pushNotificationConfig'
      );
  }

  async create(
    caller: Caller,
    taskId: string,
    input: PushConfigInput
  ): Promise<PushConfigJson> {
    await this.check(caller, input, taskId);
    const id = input.id ?? `pc-${randomUUID()}`;
    const row: PushConfigRow = {
      id,
      taskId,
      client: caller.address,
      url: input.url,
      token: input.token ?? null,
      authScheme: input.authentication?.scheme ?? null,
      authCredentials: input.authentication?.credentials ?? null,
      failures: 0,
      disabledAt: null,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    this.deps.store.putPushConfig(row);
    return toJson(row);
  }

  get(
    caller: Caller,
    taskId: string,
    id: string
  ): Promise<PushConfigJson | null> {
    return later(() => {
      this.owned(caller, taskId);
      const row = this.deps.store.getPushConfig(taskId, id);
      return row === null || row.disabledAt !== null ? null : toJson(row);
    });
  }

  list(caller: Caller, taskId: string): Promise<PushConfigJson[]> {
    return later(() => {
      this.owned(caller, taskId);
      return this.deps.store.pushConfigsOf(taskId).map(toJson);
    });
  }

  delete(caller: Caller, taskId: string, id: string): Promise<void> {
    return later(() => {
      this.owned(caller, taskId);
      this.deps.store.deletePushConfig(taskId, id);
    });
  }
}

const pushView = (client: string) => ({
  client,
  extensions: new Set<never>(),
  textMediaType: 'text/markdown' as const,
  historyLength: 0,
  includeArtifacts: true,
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// Sends each change of a task with push configs as the events a subscriber
// would get, on one chain per config, so a slow webhook delays nothing else
// (Review Focus 5). Every attempt is re-resolved and pinned to a public
// address: a refused address disables the config at once, a network error
// (an unresolvable name included) retries at 10 s, 60 s and 300 s, and ten
// failures in a row disable it. Logs name the config, never its secrets.
export class PushWorker {
  private readonly last = new Map<string, Snapshot>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: PushDeps & {
      // Whether a client may still hear from us: approved, not revoked.
      clientActive: (client: string) => boolean;
      fetchImpl?: typeof fetch;
      delaysMs?: readonly number[];
    }
  ) {}

  // Returns at once; deliveries run on per-config chains.
  onChanged(
    row: TaskRow,
    facts: TaskFacts,
    opts: { force?: boolean } = {}
  ): void {
    if (!this.deps.clientActive(row.client)) return;
    const configs = this.deps.store.pushConfigsOf(row.id);
    if (configs.length === 0) return;
    const state = decideState(facts).state;
    const next = snapshotOf(project(facts, pushView(row.client)), state);
    const events = eventsBetween(
      opts.force === true ? null : (this.last.get(row.id) ?? null),
      next
    );
    const final = TERMINAL_STATES.has(state);
    if (final) this.last.delete(row.id);
    else this.last.set(row.id, next);
    for (const config of configs) {
      for (const event of events) this.chain(config, event);
      // Once the final event is delivered or given up, the config (and its
      // secrets) has nothing left to do.
      if (final)
        this.then(config, () => {
          this.deps.store.deletePushConfig(config.taskId, config.id);
        });
    }
  }

  async idle(): Promise<void> {
    while (this.chains.size > 0)
      await Promise.allSettled([...this.chains.values()]);
  }

  private chain(config: PushConfigRow, event: StreamResponseJson): void {
    this.then(config, () => this.attempt(config, event, 0));
  }

  // Appends `step` to the config's chain, after everything already queued.
  private then(config: PushConfigRow, step: () => Promise<void> | void): void {
    const key = `${config.taskId} ${config.id}`;
    const next: Promise<void> = (this.chains.get(key) ?? Promise.resolve())
      .then(step)
      .catch((err: unknown) =>
        console.error(
          `a2a: push to config ${config.id} of ${config.taskId} failed: ${err instanceof Error ? err.name : 'error'}`
        )
      )
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  private async attempt(
    config: PushConfigRow,
    event: StreamResponseJson,
    tries: number
  ): Promise<void> {
    const current = this.deps.store.getPushConfig(config.taskId, config.id);
    if (current === null || current.disabledAt !== null) return;
    if (!this.deps.clientActive(current.client)) return;
    const at = () => (this.deps.now?.() ?? new Date()).toISOString();
    const result = await deliverPush(toJson(current), event, {
      ...(this.deps.fetchImpl === undefined
        ? {}
        : { fetchImpl: this.deps.fetchImpl }),
      guard: pushGuard(this.deps),
    });
    if (result.ok) {
      this.deps.store.recordPushResult(config.taskId, config.id, true, at());
      return;
    }
    if (result.refused) {
      this.deps.store.disablePushConfig(config.taskId, config.id, at());
      console.error(
        `a2a: push config ${config.id} of ${config.taskId} disabled: ${result.error}`
      );
      return;
    }
    const updated = this.deps.store.recordPushResult(
      config.taskId,
      config.id,
      false,
      at(),
      PUSH_LIMITS.failuresBeforeDisable
    );
    if (updated === null || updated.disabledAt !== null) return;
    const delay = (this.deps.delaysMs ?? PUSH_LIMITS.retryDelaysMs)[tries];
    if (delay === undefined) return;
    await wait(delay);
    await this.attempt(config, event, tries + 1);
  }
}
