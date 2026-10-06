import { Database } from 'bun:sqlite';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../../../src/index.js';
import { startServer } from '../../../../src/index.js';
import { boardSyncDir, runsDir } from '../../../../src/orchestrator/paths.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../../../src/orchestrator/types.js';
import type { TeamKeys } from '../../../../src/team/federation/teamKeys.js';
import { runGitSync } from '../../../orchestrator/helpers.js';
import { rawFetch } from '../../../testAuth.js';

// Synced teammate daemons for the federation tests: each a real daemon with
// its own checkout and database, exchanging board ops through a bare git
// remote in a temp directory, never a network one and never the canonical root.

export interface TeammateOpts {
  federationNow?: () => number;
  federationDebounceMs?: number;
  gitName?: string;
  /** Extra .dispatch/config.yml lines. */
  config?: string;
}

// The runs a daemon started, and what each run was sent or notified: an
// executor that stays running until stopped and records its traffic.
class RecordingExecutor implements Executor {
  readonly started: string[] = [];
  readonly sent: string[] = [];
  readonly notified: string[] = [];
  readonly tokens = new Map<string, string>();

  start(opts: ExecutorStartOptions, _events: ExecutorEvents): ExecutorRun {
    const runId = opts.runId ?? '';
    this.started.push(runId);
    if (opts.runTokenFile !== undefined)
      this.tokens.set(runId, readFileSync(opts.runTokenFile, 'utf8').trim());
    return {
      interrupt: () => Promise.resolve(),
      requestStop: () => {},
      send: (message) => {
        this.sent.push(message);
      },
      approve: () => {},
      notify: (text) => {
        this.notified.push(text);
      },
    };
  }
}

type SendBody = Record<string, unknown>;

type Reply = { status: number; body: Record<string, unknown> | null };

export interface TeammateDaemon {
  /** The test's label for this daemon. */
  name: string;
  /** Its git user.name, so its Dispatch handle. */
  handle: string;
  root: string;
  syncDir: string;
  /** The app token unless `token` is given. */
  api(
    path: string,
    init?: { method?: string; body?: string; token?: string }
  ): Promise<Reply>;
  /** As the shared agent token, the request tier. */
  asAgent(
    path: string,
    init?: { method?: string; body?: string }
  ): Promise<Reply>;
  keys(): Promise<TeamKeys>;
  /** The runs it started and their traffic. */
  executor: RecordingExecutor;
  /** Starts an execute run on a task; its id and messaging token. */
  startRun(taskId: string): Promise<{ runId: string; token: string }>;
  /** POST /api/messages, as the app token or `token`; throws on a non-2xx. */
  send(
    input: SendBody,
    token?: string
  ): Promise<{ id: string; thread: string }>;
  trySend(input: SendBody, token?: string): Promise<Reply>;
  reply(
    id: string,
    input: SendBody,
    token?: string
  ): Promise<{ id: string; thread: string }>;
  tryReply(id: string, input: SendBody, token?: string): Promise<Reply>;
  /** The ids of the open decisions this daemon's human holds. */
  openDecisions(): Promise<string[]>;
  answerOf(id: string): Promise<{
    answer: { id: string; body: string } | null;
    settlement?: string;
  }>;
  /** Registers agent:<handle>/<name> and approves it with the app token. */
  registerAgent(name: string): Promise<{ address: string; token: string }>;
  /** FW-R34: the board names an assignee only by kind, so a test that needs
   *  a person writes one straight into this daemon's task store. */
  assignPerson(taskId: string, person: string): void;
  /** Read-only, messages.db. */
  messagesDb<T>(sql: string, params?: (string | number)[]): T[];
  replica(): Promise<string>;
  found(): Promise<{
    teamId: string;
    recoveryCode: string;
    fingerprint: string;
  }>;
  /** Admits `other`'s waiting key by its fingerprint, syncing both first. */
  admit(
    other: TeammateDaemon,
    opts?: { role?: 'admin'; observer?: boolean }
  ): Promise<void>;
  sync(): Promise<Reply>;
  create(title: string, fields?: Record<string, unknown>): Promise<string>;
  patch(id: string, patch: Record<string, unknown>): Promise<void>;
  title(id: string): Promise<string | null>;
  /** Read-only, the sync state.db. */
  stateDb<T>(sql: string, params?: (string | number)[]): T[];
  /** Points the sync clone's origin at a missing path, or back. */
  partition(offline: boolean): void;
  stop(): Promise<void>;
  /** Stops, then starts a daemon on the same root with the same options. */
  restart(): Promise<void>;
}

export function daemons(): {
  setup(): void;
  cleanup(): Promise<void>;
  teammate(name: string, opts?: TeammateOpts): Promise<TeammateDaemon>;
  remote(): string;
} {
  let fakeHome = '';
  let remote = '';
  const handles: ServerHandle[] = [];
  const dirs: string[] = [];
  const originalHome = process.env.DISPATCH_HOME;
  const tempDir = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  const boot = async (
    root: string,
    opts: TeammateOpts,
    executor: RecordingExecutor
  ): Promise<ServerHandle> => {
    const handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      storeBackend: 'sqlite',
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', executor);
      },
      ...(opts.federationNow === undefined
        ? {}
        : { federationNow: opts.federationNow }),
      ...(opts.federationDebounceMs === undefined
        ? {}
        : { federationDebounceMs: opts.federationDebounceMs }),
      // The fake relay listens on ws://127.0.0.1.
      federationAllowLoopbackRelay: true,
    });
    handles.push(handle);
    return handle;
  };

  const teammate = async (
    name: string,
    opts: TeammateOpts = {}
  ): Promise<TeammateDaemon> => {
    const handle = opts.gitName ?? name;
    const root = tempDir(`fed-daemon-${name}-`);
    runGitSync(root, ['init', '-q', '-b', 'main']);
    runGitSync(root, ['config', 'user.email', `${handle}@example.com`]);
    runGitSync(root, ['config', 'user.name', handle]);
    writeFileSync(join(root, 'README.md'), `# ${name}\n`);
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    // A long interval: every pass is asked for explicitly.
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      `sync:\n  enabled: true\n  repo: ${remote}\n  intervalSec: 3600\n${opts.config ?? ''}`
    );
    runGitSync(root, ['add', '-A']);
    runGitSync(root, ['commit', '-q', '-m', 'init']);
    const executor = new RecordingExecutor();
    let server = await boot(root, opts, executor);
    const syncDir = boardSyncDir(root);
    const call = async (
      path: string,
      init: { method?: string; body?: string; token?: string } = {}
    ): Promise<Reply> => {
      const res = await rawFetch(`http://127.0.0.1:${server.port}${path}`, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: init.body }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${init.token ?? server.tokens.appToken}`,
        },
      });
      const text = await res.text();
      return {
        status: res.status,
        body:
          text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
      };
    };
    const self: TeammateDaemon = {
      name,
      handle,
      root,
      syncDir,
      api: call,
      asAgent: (path, init = {}) =>
        call(path, { ...init, token: server.tokens.agentToken }),
      keys: async () =>
        (await call('/api/team/keys')).body as unknown as TeamKeys,
      replica: async () => (await self.keys()).machine.replica,
      found: async () => {
        const r = await call('/api/team/found', { method: 'POST', body: '{}' });
        if (r.status !== 200)
          throw new Error(`found: ${r.status} ${JSON.stringify(r.body)}`);
        return r.body as unknown as {
          teamId: string;
          recoveryCode: string;
          fingerprint: string;
        };
      },
      admit: async (other, admitOpts = {}) => {
        await self.sync();
        await other.sync();
        await self.sync();
        const { machine } = await other.keys();
        const r = await call(`/api/team/keys/${machine.replica}/admit`, {
          method: 'POST',
          body: JSON.stringify({
            fingerprint: machine.fingerprint,
            ...admitOpts,
          }),
        });
        if (r.status !== 200)
          throw new Error(`admit: ${r.status} ${JSON.stringify(r.body)}`);
      },
      sync: () => call('/api/board-sync/now', { method: 'POST' }),
      create: async (title, fields = {}) => {
        const r = await call('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({ title, ...fields }),
        });
        return (r.body as { meta: { id: string } }).meta.id;
      },
      patch: async (id, patch) => {
        await call(`/api/tasks/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
      },
      title: async (id) => {
        const r = await call(`/api/tasks/${id}`);
        return r.status === 200
          ? ((r.body as { meta: { title: string } }).meta.title ?? null)
          : null;
      },
      stateDb: <T>(sql: string, params: (string | number)[] = []): T[] => {
        const db = new Database(join(syncDir, 'state.db'), { readonly: true });
        try {
          return db.query<T, (string | number)[]>(sql).all(...params);
        } finally {
          db.close();
        }
      },
      executor,
      startRun: async (taskId) => {
        const r = await call(`/api/tasks/${taskId}/runs`, {
          method: 'POST',
          body: JSON.stringify({ executor: 'claude' }),
        });
        const runId = (r.body as { id?: string } | null)?.id;
        if (runId === undefined)
          throw new Error(`startRun: ${r.status} ${JSON.stringify(r.body)}`);
        for (let i = 0; i < 200 && !executor.tokens.has(runId); i++)
          await Bun.sleep(10);
        return { runId, token: executor.tokens.get(runId) ?? '' };
      },
      trySend: (input, token) =>
        call('/api/messages', {
          method: 'POST',
          body: JSON.stringify(input),
          ...(token === undefined ? {} : { token }),
        }),
      send: async (input, token) => {
        const r = await self.trySend(input, token);
        if (r.status >= 300)
          throw new Error(`send: ${r.status} ${JSON.stringify(r.body)}`);
        const m = (r.body as { message: { id: string; thread: string } })
          .message;
        return { id: m.id, thread: m.thread };
      },
      tryReply: (id, input, token) =>
        call(`/api/messages/${id}/reply`, {
          method: 'POST',
          body: JSON.stringify(input),
          ...(token === undefined ? {} : { token }),
        }),
      reply: async (id, input, token) => {
        const r = await self.tryReply(id, input, token);
        if (r.status >= 300)
          throw new Error(`reply: ${r.status} ${JSON.stringify(r.body)}`);
        const m = (r.body as { message: { id: string; thread: string } })
          .message;
        return { id: m.id, thread: m.thread };
      },
      openDecisions: async () =>
        (
          (
            (await call('/api/decisions/open')).body as {
              items?: { id: string }[];
            } | null
          )?.items ?? []
        ).map((m) => m.id),
      answerOf: async (id) =>
        (await call(`/api/messages/${id}/answer`)).body as {
          answer: { id: string; body: string } | null;
          settlement?: string;
        },
      registerAgent: async (agentName) => {
        const r = await call('/api/agents/register', {
          method: 'POST',
          body: JSON.stringify({ name: agentName, client: 'codex' }),
        });
        const reg = r.body as { address: string; token: string };
        await call(`/api/agents/${encodeURIComponent(reg.address)}/approve`, {
          method: 'POST',
        });
        return reg;
      },
      assignPerson: (taskId, person) => {
        const db = new Database(join(root, '.dispatch', 'dispatch.db'));
        try {
          db.query('UPDATE tasks SET assignee = ? WHERE id = ?').run(
            person,
            taskId
          );
        } finally {
          db.close();
        }
      },
      messagesDb: <T>(sql: string, params: (string | number)[] = []): T[] => {
        const db = new Database(join(runsDir(root), 'messages.db'), {
          readonly: true,
        });
        try {
          return db.query<T, (string | number)[]>(sql).all(...params);
        } finally {
          db.close();
        }
      },
      partition: (offline) => {
        runGitSync(join(syncDir, 'repo'), [
          'remote',
          'set-url',
          'origin',
          offline ? join(fakeHome, 'no-such-remote.git') : remote,
        ]);
      },
      stop: async () => {
        await server.stop();
        handles.splice(handles.indexOf(server), 1);
      },
      restart: async () => {
        await self.stop();
        server = await boot(root, opts, executor);
      },
    };
    return self;
  };

  return {
    setup: () => {
      fakeHome = tempDir('fed-home-');
      process.env.DISPATCH_HOME = fakeHome;
      remote = tempDir('fed-remote-');
      runGitSync(remote, ['init', '-q', '--bare', '-b', 'main']);
    },
    cleanup: async () => {
      for (const h of handles.splice(0)) await h.stop();
      if (originalHome === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = originalHome;
      for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
    },
    teammate,
    remote: () => remote,
  };
}
