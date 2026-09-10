import { initProjectStores, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';

// The MCP task tools against a REAL running daemon.
//
// This is the half of single-writer that packages/mcp's own suite cannot
// cover: those tests run with no daemon, which exercises the fallback path
// only. Here dispatchd is up and holding the store, so every assertion below
// is about the proxy path — including the two behaviors that are the point
// of routing through it at all. Namely that a tool call made from inside a
// run worktree reads the PROJECT's board rather than the worktree's frozen
// copy, and that a write made through a tool is immediately visible to the
// daemon's own API (one writer, one copy).
//
// Driven as a child process against the built `dispatch-mcp` bin, the same
// way packages/mcp/test/e2e.test.ts does, rather than through the SDK's
// in-memory transport: @modelcontextprotocol/sdk is a dependency of
// @dispatch/mcp, not of this package, and spawning the real binary is closer
// to how a dispatched agent actually reaches these tools anyway.
//
// Note there is no `useTestAuth` here on purpose: the tools present the agent
// token out of the daemon file, so these calls go through the real two-tier
// guard rather than a test bypass.

const MCP_BIN = resolve(
  dirname(import.meta.dirname),
  '..',
  'mcp',
  'dist',
  'bin.js'
);

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: unknown;
}

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

type Send = (method: string, params?: unknown) => Promise<JsonRpcResponse>;

function resultText(result: ToolCallResult): string {
  return result.content.map((c) => c.text ?? '').join('');
}

// The structured payload of a successful tool call. Throws with the tool's
// own text when there isn't one, so an unexpected tool ERROR reads as its
// message rather than as `undefined is not an object` three lines later.
function structured(result: ToolCallResult): Record<string, unknown> {
  if (result.structuredContent === undefined) {
    throw new Error(`expected structured content, got: ${resultText(result)}`);
  }
  return result.structuredContent;
}

function initGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

/**
 * Runs `fn` against an initialized dispatch-mcp child rooted at `rootDir`.
 *
 * `env` is merged over the child's inherited environment — the tools resolve
 * the daemon file through `DISPATCH_HOME` and the project through
 * `DISPATCH_PROJECT_ROOT`, and both have to reach the child rather than just
 * this process.
 */
async function withMcp(
  rootDir: string,
  env: Record<string, string>,
  fn: (send: Send) => Promise<void>
): Promise<void> {
  const proc = Bun.spawn(['node', MCP_BIN, '--root', rootDir], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env, ...env },
  });
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  let nextId = 1;
  let buf = '';

  const pump = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() === '') continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  })();

  const send: Send = (method, params = {}) => {
    const id = nextId++;
    void proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    );
    return new Promise((res) => pending.set(id, res));
  };

  try {
    await send('initialize', {
      protocolVersion: '2026-11-25',
      capabilities: {},
      clientInfo: { name: 'proxy-test', version: '0.0.1' },
    });
    void proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
    await fn(send);
  } finally {
    proc.kill();
    await pump.catch(() => {});
  }
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
let childEnv: Record<string, string>;
const originalDispatchHome = process.env.DISPATCH_HOME;

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  opts: { rootDir?: string; env?: Record<string, string> } = {}
): Promise<ToolCallResult> {
  let captured: ToolCallResult | undefined;
  await withMcp(
    opts.rootDir ?? root,
    { ...childEnv, ...opts.env },
    async (send) => {
      const res = await send('tools/call', { name, arguments: args });
      captured = res.result as ToolCallResult;
    }
  );
  if (captured === undefined) throw new Error(`no result for ${name}`);
  return captured;
}

function appAuth(): Record<string, string> {
  return { authorization: `Bearer ${handle.tokens.appToken}` };
}

async function createTaskViaApi(
  title: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const doc = (await json(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...appAuth() },
      body: JSON.stringify({ title, ...extra }),
    })
  )) as { meta: { id: string } };
  return doc.meta.id;
}

function getTaskViaApi(id: string): Promise<{ meta: Record<string, string> }> {
  return fetch(`${baseUrl}/api/tasks/${id}`, { headers: appAuth() }).then(json);
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  // Set on THIS process, not only on the child: the daemon below writes its
  // daemon file from here, and test/setup.ts fails the suite if that reaches
  // the real ~/.dispatch. The child inherits it through `process.env`.
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-mcp-proxy-');
  handle = await startServer({
    rootDir: root,
    port: 0,
    // The tools find this daemon by reading its daemon file, so unlike most
    // suites this one must actually write one — safe because DISPATCH_HOME
    // below points the child at a per-test temp dir.
    writeDaemonFile: true,
    webDistDir: null,
    boardSyncPeriodicMs: 10 * 60_000,
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  childEnv = { DISPATCH_HOME: fakeHome };
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('the built dispatch-mcp bin', () => {
  it('exists — build @dispatch/mcp before running this suite', () => {
    expect(existsSync(MCP_BIN)).toBe(true);
  });
});

describe('task_list / task_get through a live daemon', () => {
  it('lists tasks the daemon knows about', async () => {
    await createTaskViaApi('through the daemon');
    const result = await callTool('task_list');
    expect(result.isError).toBeUndefined();
    const tasks = structured(result).tasks as { title: string }[];
    expect(tasks.map((t) => t.title)).toEqual(['through the daemon']);
  });

  it('applies a status filter server-side', async () => {
    const id = await createTaskViaApi('filter me');
    await fetch(`${baseUrl}/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...appAuth() },
      body: JSON.stringify({ status: 'in-progress' }),
    });

    const matching = await callTool('task_list', { status: 'in-progress' });
    expect((structured(matching).tasks as unknown[]).length).toBe(1);

    const other = await callTool('task_list', { status: 'todo' });
    expect((structured(other).tasks as unknown[]).length).toBe(0);
  });

  it('rejects an unknown status rather than asking the daemon', async () => {
    const result = await callTool('task_list', { status: 'nonsense' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('invalid status: nonsense');
  });

  it('fetches one task with its body', async () => {
    const id = await createTaskViaApi('with a body');
    const result = await callTool('task_get', { id });
    expect((structured(result).meta as { id: string }).id).toBe(id);
    expect(typeof structured(result).body).toBe('string');
  });

  it("surfaces the daemon's own 404 wording for an unknown id", async () => {
    const result = await callTool('task_get', { id: 't-nope00' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('task not found: t-nope00');
  });
});

describe('task_save through a live daemon', () => {
  it('creates a task the daemon immediately serves', async () => {
    const result = await callTool('task_save', { title: 'made by an agent' });
    const meta = structured(result).meta as { id: string };

    // The daemon is the writer, so its own API must already see it — no
    // watcher tick, no rebuild delay.
    const fetched = await getTaskViaApi(meta.id);
    expect(fetched.meta.title).toBe('made by an agent');
  });

  it('updates an existing task', async () => {
    const id = await createTaskViaApi('rename me');
    await callTool('task_save', { id, title: 'renamed' });
    expect((await getTaskViaApi(id)).meta.title).toBe('renamed');
  });

  it('is a no-op when a patch carries no changed field', async () => {
    const id = await createTaskViaApi('untouched');
    const before = await getTaskViaApi(id);
    const result = await callTool('task_save', { id });
    const meta = structured(result).meta as { updated: string };
    expect(meta.updated).toBe(before.meta.updated);
  });

  it('reports an unknown id rather than creating one', async () => {
    const result = await callTool('task_save', {
      id: 't-nope00',
      title: 'ghost',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('task not found: t-nope00');
  });
});

describe('task_next through a live daemon', () => {
  it('applies the ready-work rule to the daemon board', async () => {
    const blocker = await createTaskViaApi('blocker');
    await createTaskViaApi('blocked', { blockedBy: [blocker] });

    const result = await callTool('task_next');
    const tasks = structured(result).tasks as { title: string }[];
    expect(tasks.map((t) => t.title)).toEqual(['blocker']);
  });
});

describe('a tool called from inside a run worktree', () => {
  it("reads the project's board, not the worktree's copy", async () => {
    await createTaskViaApi('only in the project');

    // A worktree is a different directory with its own (here: empty)
    // `.dispatch`. Before routing through the daemon, a tool rooted here
    // would have listed that copy and reported nothing.
    const worktree = mkdtempSync(join(tmpdir(), 'dispatch-mcp-worktree-'));
    try {
      const result = await callTool(
        'task_list',
        {},
        { rootDir: worktree, env: { DISPATCH_PROJECT_ROOT: root } }
      );
      const tasks = structured(result).tasks as { title: string }[];
      expect(tasks.map((t) => t.title)).toEqual(['only in the project']);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

// With no daemon running, what a tool may do depends entirely on the backend
// — the safety property this whole change rests on. These cases deliberately
// point DISPATCH_HOME at an empty directory so daemon discovery finds nothing.
describe('with no daemon running', () => {
  let emptyHome: string;

  beforeEach(() => {
    emptyHome = mkdtempSync(join(tmpdir(), 'dispatch-no-daemon-home-'));
  });

  // A real database-backed project is a database AND the marker recording
  // that choice — the daemon writes both. The marker is what the tools read:
  // a stray `dispatch.db` on its own must NOT lock anyone out of a project
  // whose tasks are still in markdown, so creating only the database here
  // would be testing a state that never occurs.
  function makeDatabaseProject(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    initProjectStores({ rootDir: dir, backend: 'sqlite' }).close();
    writeFileSync(
      join(dir, '.dispatch', 'storage.json'),
      JSON.stringify({ backend: 'sqlite' })
    );
    return dir;
  }

  afterEach(() => {
    rmSync(emptyHome, { recursive: true, force: true });
  });

  it('falls back to reading the files of a file-backed project', async () => {
    const fileProject = mkdtempSync(join(tmpdir(), 'dispatch-files-'));
    TaskStore.init(fileProject).create({ title: 'read me off disk' });
    try {
      const result = await callTool(
        'task_list',
        {},
        { rootDir: fileProject, env: { DISPATCH_HOME: emptyHome } }
      );
      expect(result.isError).toBeUndefined();
      const tasks = structured(result).tasks as { title: string }[];
      expect(tasks.map((t) => t.title)).toEqual(['read me off disk']);
    } finally {
      rmSync(fileProject, { recursive: true, force: true });
    }
  });

  it('refuses to open a database-backed project itself', async () => {
    const dbProject = makeDatabaseProject('dispatch-db-');
    try {
      const result = await callTool(
        'task_list',
        {},
        { rootDir: dbProject, env: { DISPATCH_HOME: emptyHome } }
      );
      // A second process opening that database is exactly what single-writer
      // exists to prevent, so this must be a clean refusal — not a fallback
      // read, and not a crash.
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('dispatchd is not running');
      expect(resultText(result)).toContain('dispatch serve');
    } finally {
      rmSync(dbProject, { recursive: true, force: true });
    }
  });

  it('treats a stray database with no recorded choice as not owned', async () => {
    // Existence is not ownership: a half-created or leftover `dispatch.db`
    // beside a real markdown board must not lock every tool out of it.
    const strayDb = mkdtempSync(join(tmpdir(), 'dispatch-stray-db-'));
    TaskStore.init(strayDb).create({ title: 'still in markdown' });
    initProjectStores({ rootDir: strayDb, backend: 'sqlite' }).close();
    try {
      const result = await callTool(
        'task_list',
        {},
        { rootDir: strayDb, env: { DISPATCH_HOME: emptyHome } }
      );
      expect(result.isError).toBeUndefined();
      const tasks = structured(result).tasks as { title: string }[];
      expect(tasks.map((t) => t.title)).toEqual(['still in markdown']);
    } finally {
      rmSync(strayDb, { recursive: true, force: true });
    }
  });

  it('refuses a write to a database-backed project too', async () => {
    const dbProject = makeDatabaseProject('dispatch-db-write-');
    try {
      const result = await callTool(
        'task_save',
        { title: 'should never land' },
        { rootDir: dbProject, env: { DISPATCH_HOME: emptyHome } }
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('dispatchd is not running');
    } finally {
      rmSync(dbProject, { recursive: true, force: true });
    }
  });
});

// task_comment has proxied the daemon since before this change, but with no
// Authorization header — every route except /api/health requires one, so the
// POST 401'd and the tool silently fell through to writing the markdown
// itself. That is invisible on the file backend (the direct write works), so
// this pins it where it cannot hide: a database-backed project has no
// markdown for the fallback to write, and only a genuinely authenticated
// proxy call can succeed.
describe('task_comment against a database-backed daemon', () => {
  let dbRoot: string;
  let dbHandle: ServerHandle;

  beforeEach(async () => {
    dbRoot = initGitRepo('dispatch-mcp-comment-db-');
    dbHandle = await startServer({
      rootDir: dbRoot,
      port: 0,
      writeDaemonFile: true,
      webDistDir: null,
      storeBackend: 'sqlite',
      boardSyncPeriodicMs: 10 * 60_000,
    });
  });

  afterEach(async () => {
    await dbHandle.stop();
    rmSync(dbRoot, { recursive: true, force: true });
  });

  it('appends through the daemon rather than falling back to a file', async () => {
    const created = (await json(
      await fetch(`http://127.0.0.1:${dbHandle.port}/api/tasks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${dbHandle.tokens.appToken}`,
        },
        body: JSON.stringify({ title: 'comment target' }),
      })
    )) as { meta: { id: string } };

    const result = await callTool(
      'task_comment',
      { id: created.meta.id, text: 'progress from the agent' },
      {
        rootDir: dbRoot,
        // A run id is what makes task_comment attempt the proxy at all.
        env: { DISPATCH_RUN_ID: 'r-abc123' },
      }
    );
    expect(result.isError).toBeUndefined();

    const doc = (await json(
      await fetch(
        `http://127.0.0.1:${dbHandle.port}/api/tasks/${created.meta.id}`,
        {
          headers: { authorization: `Bearer ${dbHandle.tokens.appToken}` },
        }
      )
    )) as { body: string };
    expect(doc.body).toContain('progress from the agent');
  });
});
