import { TaskStore } from '@dispatch-foo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

// task_list, task_next and run_list page their results; agent_list lists
// the roster's reachable agents.

const SHARED = 'shared-agent-token';

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

let fakeHome: string;
let root: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let rosterAuth: string | null;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-paging-'));
  rosterAuth = null;
  TaskStore.init(root);
});

afterEach(() => {
  void server?.stop(true);
  server = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  const s = createDispatchMcpServer(root);
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), s.connect(b)]);
  return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

// A daemon answering health, /api/runs and the agent roster.
function startFakeDaemon(runs: unknown[], agents: unknown[]): void {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/runs') return Response.json(runs);
      if (url.pathname === '/api/agents/roster') {
        rosterAuth = req.headers.get('authorization');
        return Response.json({ agents });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  const path = daemonFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: SHARED,
    })
  );
}

function seedTasks(count: number): string[] {
  const store = TaskStore.init(root);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const created = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    ids.push(
      store.create({ title: `Task ${i}`, status: 'ready' }, created).meta.id
    );
  }
  return ids;
}

describe('task_list paging', () => {
  it('returns a page, the total and the next offset', async () => {
    const ids = seedTasks(5);
    const first = await call('task_list', { limit: 2 });
    const sc = first.structuredContent as {
      tasks: { id: string }[];
      total: number;
      nextOffset: number | null;
    };
    expect(sc.tasks.map((t) => t.id)).toEqual(ids.slice(0, 2));
    expect(sc.total).toBe(5);
    expect(sc.nextOffset).toBe(2);

    const last = (await call('task_list', { limit: 2, offset: 4 }))
      .structuredContent as { tasks: { id: string }[]; nextOffset: null };
    expect(last.tasks.map((t) => t.id)).toEqual([ids[4]]);
    expect(last.nextOffset).toBeNull();
  });

  it('caps an unpaged call at the default limit of 100', async () => {
    seedTasks(102);
    const sc = (await call('task_list')).structuredContent as {
      tasks: unknown[];
      total: number;
      nextOffset: number | null;
    };
    expect(sc.tasks).toHaveLength(100);
    expect(sc.total).toBe(102);
    expect(sc.nextOffset).toBe(100);
  });

  it('refuses a limit above 500', async () => {
    const result = await call('task_list', { limit: 501 });
    expect(result.isError).toBe(true);
  });
});

describe('task_next paging', () => {
  it('pages the ready queue', async () => {
    const ids = seedTasks(3);
    const sc = (await call('task_next', { limit: 1, offset: 1 }))
      .structuredContent as {
      tasks: { id: string }[];
      total: number;
      nextOffset: number | null;
    };
    expect(sc.tasks.map((t) => t.id)).toEqual([ids[1]]);
    expect(sc.total).toBe(3);
    expect(sc.nextOffset).toBe(2);
  });
});

describe('run_list paging', () => {
  it('pages the daemon runs, newest first as the daemon sends them', async () => {
    startFakeDaemon([{ id: 'r-3' }, { id: 'r-2' }, { id: 'r-1' }], []);
    const sc = (await call('run_list', { limit: 2 })).structuredContent as {
      runs: { id: string }[];
      total: number;
      nextOffset: number | null;
    };
    expect(sc.runs.map((r) => r.id)).toEqual(['r-3', 'r-2']);
    expect(sc.total).toBe(3);
    expect(sc.nextOffset).toBe(2);
  });
});

describe('agent_list', () => {
  it("lists this machine's and teammates' agents, never revoked ones", async () => {
    startFakeDaemon(
      [],
      [
        {
          address: 'agent:wyat/claude-code',
          displayName: 'Claude\nCode',
          client: 'claude-code',
          status: 'approved',
          muted: false,
          approvedBy: 'human:wyat',
          createdAt: '2026-10-06T00:00:00Z',
          remote: null,
        },
        {
          address: 'agent:sam/codex',
          displayName: 'codex',
          client: 'codex',
          status: 'approved',
          muted: false,
          approvedBy: 'human:sam',
          createdAt: '2026-10-06T00:00:00Z',
          remote: 'sam',
        },
        {
          address: 'agent:wyat/old',
          displayName: 'old',
          client: 'codex',
          status: 'revoked',
          muted: false,
          approvedBy: null,
          createdAt: '2026-10-06T00:00:00Z',
          remote: null,
        },
      ]
    );
    const result = await call('agent_list');
    expect(rosterAuth).toBe(`Bearer ${SHARED}`);
    expect(result.structuredContent?.agents).toEqual([
      {
        address: 'agent:sam/codex',
        name: 'codex',
        client: 'codex',
        status: 'approved',
        machine: 'sam',
      },
      {
        address: 'agent:wyat/claude-code',
        name: 'Claude Code',
        client: 'claude-code',
        status: 'approved',
        machine: 'this machine',
      },
    ]);
  });
});
