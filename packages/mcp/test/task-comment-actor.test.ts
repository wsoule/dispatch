import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

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

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

// Stands in for dispatchd's health check plus POST /api/tasks/:id/comment —
// the one route task_comment proxies to when a live run + healthy daemon can
// resolve the calling agent's identity (see api.ts's commentAuthorFor).
class FakeDaemon {
  // Set per-test to a real TaskDoc's `{ meta, body }` — task_comment's
  // outputSchema validates a full TaskMeta, so a minimal stub fails schema
  // validation rather than exercising the thing under test.
  commentResult: { status: number; body: unknown };
  commentCalls: { taskId: string; body: Record<string, unknown> }[] = [];

  constructor(commentResult: { status: number; body: unknown }) {
    this.commentResult = commentResult;
  }
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') {
          return Response.json({ ok: true });
        }
        const match = /^\/api\/tasks\/([^/]+)\/comment$/.exec(url.pathname);
        if (match !== null && req.method === 'POST') {
          this.commentCalls.push({
            taskId: match[1],
            body: (await req.json()) as Record<string, unknown>,
          });
          return Response.json(this.commentResult.body, {
            status: this.commentResult.status,
          });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    return this.server.port ?? 0;
  }

  stop(): void {
    void this.server?.stop(true);
  }
}

let fakeHome: string;
let root: string;
let daemon: FakeDaemon | undefined;
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalRunId = process.env.DISPATCH_RUN_ID;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-task-comment-'));
  TaskStore.init(root);
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  if (originalRunId === undefined) delete process.env.DISPATCH_RUN_ID;
  else process.env.DISPATCH_RUN_ID = originalRunId;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeFakeDaemonFile(port: number): void {
  const path = daemonFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
    })
  );
}

describe('task_comment (fake daemon, live run)', () => {
  it('forwards the calling run id so dispatchd can credit the agent, not the local human', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const store = new TaskStore(root);
    const doc = store.create({ title: 'Track me' });
    daemon = new FakeDaemon({ status: 200, body: { meta: doc.meta } });
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'task_comment',
      arguments: { id: doc.meta.id, text: 'made progress' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(daemon.commentCalls).toEqual([
      {
        taskId: doc.meta.id,
        body: { text: 'made progress', runId: 'r-self1' },
      },
    ]);
  });
});

describe('task_comment (unresolvable run: no daemon at all)', () => {
  it("writes the comment directly and credits 'none', never the local human", async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    // Deliberately no FakeDaemon started and no daemon file written — this
    // is the "unresolvable run" case: task_comment must still leave the
    // comment (it always has, even with no daemon), but must not guess at
    // an actor it has no way to actually resolve.
    const client = await connectClient(root);
    const store = new TaskStore(root);
    const doc = store.create({ title: 'Track me' });

    const result = (await client.callTool({
      name: 'task_comment',
      arguments: { id: doc.meta.id, text: 'made progress' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    const onDisk = store.get(doc.meta.id);
    expect(onDisk?.body).toContain('made progress — none');
  });
});
