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

// A stand-in for dispatchd's questions routes, shaped like the real ones but
// answering every long-poll immediately: `answerAfterPolls` is how many polls
// come back unanswered before one carries an answer, which is what lets a
// test exercise the tool's re-poll loop in milliseconds.
class FakeDaemon {
  askStatus = 201;
  askBody: unknown = { id: 'q-abc123', runId: 'r-self1', answer: null };
  answerAfterPolls = 1;
  pollStatus = 200;
  asked: { runId: string; question: string; options: string[] }[] = [];
  polls = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') return Response.json({ ok: true });

        const ask = /^\/api\/runs\/([^/]+)\/questions$/.exec(url.pathname);
        if (ask !== null && req.method === 'POST') {
          const body = (await req.json()) as {
            question: string;
            options: string[];
          };
          this.asked.push({
            runId: ask[1],
            question: body.question,
            options: body.options,
          });
          return Response.json(this.askBody, { status: this.askStatus });
        }

        const poll = /^\/api\/runs\/([^/]+)\/questions\/([^/]+)$/.exec(
          url.pathname
        );
        if (poll !== null && req.method === 'GET') {
          this.polls += 1;
          if (this.pollStatus !== 200) {
            return Response.json(
              { error: 'question not found' },
              { status: this.pollStatus }
            );
          }
          return Response.json({
            id: poll[2],
            runId: poll[1],
            answer: this.polls > this.answerAfterPolls ? 'postgres' : null,
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-ask-user-'));
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

describe('ask_user input validation', () => {
  it('errors on an empty question', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'ask_user',
      arguments: { question: '   ' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/question must not be empty/);
  });

  it('errors when DISPATCH_RUN_ID is not set', async () => {
    delete process.env.DISPATCH_RUN_ID;
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'ask_user',
      arguments: { question: 'which database?' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DISPATCH_RUN_ID/);
  });

  it('errors when no daemon is running', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'ask_user',
      arguments: { question: 'which database?' },
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dispatchd not running/);
  });
});

describe('ask_user (fake daemon)', () => {
  it('posts the question and re-polls past an unanswered poll to return the answer', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.answerAfterPolls = 2;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'ask_user',
      arguments: {
        question: 'Which database?',
        options: ['sqlite', 'postgres'],
      },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ answer: 'postgres' });
    expect(daemon.asked).toEqual([
      {
        runId: 'r-self1',
        question: 'Which database?',
        options: ['sqlite', 'postgres'],
      },
    ]);
    expect(daemon.polls).toBe(3);
  });

  it('stops waiting with an empty answer when the daemon no longer knows the question', async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.pollStatus = 404;
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'ask_user',
      arguments: { question: 'Which database?' },
    })) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ answer: '' });
    expect(result.content[0]?.text).toMatch(/best judgement/);
    expect(daemon.polls).toBe(1);
  });

  it("surfaces the daemon's own error when the question can't be posted", async () => {
    process.env.DISPATCH_RUN_ID = 'r-self1';
    daemon = new FakeDaemon();
    daemon.askStatus = 409;
    daemon.askBody = { error: 'run is not running: r-self1' };
    writeFakeDaemonFile(daemon.start());
    const client = await connectClient(root);

    const result = (await client.callTool({
      name: 'ask_user',
      arguments: { question: 'Which database?' },
    })) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/run is not running: r-self1/);
  });
});
