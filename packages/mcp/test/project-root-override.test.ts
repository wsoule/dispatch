import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

// Bug 1's second half (fix/executor-mcp-wiring): ClaudeExecutor now roots
// the dispatch MCP server at a run's git WORKTREE (so task_list/task_get/
// task_save/task_next read the run's own checkout), but sets
// DISPATCH_PROJECT_ROOT to the dispatch PROJECT's root. These tests prove
// tools.ts's `projectRoot()` override actually takes effect for the two
// tools that must NOT resolve against the worktree — see its doc comment in
// packages/mcp/src/tools.ts for why: run_list/agent_message's daemon
// discovery (the daemon file is keyed by a hash of the project root, not the
// worktree) and task_comment's write (a comment written to the worktree's
// copy of a task file is discarded the moment that run's branch is merged
// or discarded).

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

async function connectClient(rootDir: string): Promise<Client> {
  const server = createDispatchMcpServer(rootDir);
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

let worktreeRoot: string;
let projectRoot: string;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalProjectRootOverride = process.env.DISPATCH_PROJECT_ROOT;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  worktreeRoot = mkdtempSync(join(tmpdir(), 'dispatch-mcp-worktree-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'dispatch-mcp-project-'));
  TaskStore.init(worktreeRoot);
  TaskStore.init(projectRoot);
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  if (originalProjectRootOverride === undefined) {
    delete process.env.DISPATCH_PROJECT_ROOT;
  } else {
    process.env.DISPATCH_PROJECT_ROOT = originalProjectRootOverride;
  }
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('task_comment honors DISPATCH_PROJECT_ROOT', () => {
  it('writes the comment to the project root store, not the worktree rootDir the server was constructed with', async () => {
    const task = new TaskStore(projectRoot).create({
      title: 'Tracked in the project store',
    });
    process.env.DISPATCH_PROJECT_ROOT = projectRoot;

    // Server constructed against the WORKTREE root, exactly like
    // ClaudeExecutor's --root arg — the override is what should redirect
    // task_comment's write to `projectRoot` instead.
    const client = await connectClient(worktreeRoot);
    const result = (await client.callTool({
      name: 'task_comment',
      arguments: { id: task.meta.id, text: 'hello from the override test' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    const reread = new TaskStore(projectRoot).get(task.meta.id);
    expect(reread?.body).toContain('hello from the override test');
  });

  it('falls back to rootDir when DISPATCH_PROJECT_ROOT is unset', async () => {
    delete process.env.DISPATCH_PROJECT_ROOT;
    const task = new TaskStore(worktreeRoot).create({ title: 'No override' });

    const client = await connectClient(worktreeRoot);
    const result = (await client.callTool({
      name: 'task_comment',
      arguments: { id: task.meta.id, text: 'plain rootDir write' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    const reread = new TaskStore(worktreeRoot).get(task.meta.id);
    expect(reread?.body).toContain('plain rootDir write');
  });

  it('reports "task not found" for a task that only exists in the project root, when the override is unset', async () => {
    // Sanity check the whole setup actually isolates the two stores: without
    // the override, a task created only in `projectRoot` must be invisible
    // to a server rooted at `worktreeRoot`.
    delete process.env.DISPATCH_PROJECT_ROOT;
    const task = new TaskStore(projectRoot).create({
      title: 'Only in project root',
    });

    const client = await connectClient(worktreeRoot);
    const result = (await client.callTool({
      name: 'task_comment',
      arguments: { id: task.meta.id, text: 'should not land anywhere' },
    })) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/task not found/);
  });
});

// A minimal daemon stand-in (same shape as agent-message.test.ts's
// FakeDaemon) — just enough to answer /api/health and /api/runs so run_list
// can prove which rootDir's daemon file it actually read.
function startFakeDaemon(runs: Record<string, unknown>[]): {
  port: number;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/runs') return Response.json(runs);
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return { port: server.port ?? 0, stop: () => void server.stop(true) };
}

function writeFakeDaemonFile(rootDir: string, port: number): void {
  const path = daemonFilePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port,
      pid: process.pid,
      rootDir,
      startedAt: new Date().toISOString(),
    })
  );
}

describe('run_list honors DISPATCH_PROJECT_ROOT', () => {
  it("proxies the project root's daemon file, not one keyed by the worktree rootDir", async () => {
    const projectRuns = [
      {
        id: 'r-project1',
        taskId: 't-aaa',
        taskTitle: 'Project run',
        state: 'running',
      },
    ];
    const daemon = startFakeDaemon(projectRuns);
    // Only the PROJECT root's daemon file exists — nothing is written for
    // `worktreeRoot`, so a lookup that (incorrectly) used the raw rootDir
    // would find no daemon at all and fall back to the "not running" note.
    writeFakeDaemonFile(projectRoot, daemon.port);
    process.env.DISPATCH_PROJECT_ROOT = projectRoot;

    try {
      const client = await connectClient(worktreeRoot);
      const result = (await client.callTool({
        name: 'run_list',
        arguments: {},
      })) as ToolCallResult;

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.note).toBeUndefined();
      expect(result.structuredContent?.runs).toEqual(projectRuns);
    } finally {
      daemon.stop();
    }
  });

  it('reports "dispatchd not running" when DISPATCH_PROJECT_ROOT is unset and only the worktree has no daemon file', async () => {
    delete process.env.DISPATCH_PROJECT_ROOT;
    const daemon = startFakeDaemon([]);
    writeFakeDaemonFile(projectRoot, daemon.port);

    try {
      const client = await connectClient(worktreeRoot);
      const result = (await client.callTool({
        name: 'run_list',
        arguments: {},
      })) as ToolCallResult;

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        runs: [],
        note: 'dispatchd not running',
      });
    } finally {
      daemon.stop();
    }
  });
});
