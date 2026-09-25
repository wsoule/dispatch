import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InboxClusterer } from '../src/inboxClusterer.js';
import type { ServerHandle, StartServerOptions } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { JudgmentClient } from '../src/judgments/client.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// POST /api/inbox/cluster with a stub judgment client: items the triage gives
// a confident epic must never reach the clusterer's model call, and with no
// client at all every open item still does.

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-triage-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle | null = null;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// A clusterer whose model call records the prompt it was handed and groups nothing.
function recordingClusterer(prompts: string[]): InboxClusterer {
  function* messages(): Generator<unknown> {
    yield {
      type: 'result',
      subtype: 'success',
      session_id: 's',
      structured_output: { groups: [] },
    };
  }
  const fakeQueryFn = (args: { prompt: unknown }) => {
    prompts.push(String(args.prompt));
    return messages() as unknown as Query;
  };
  return new InboxClusterer(root, fakeQueryFn as never);
}

// Answers every item as "belongs to `epicId`" with full confidence.
function confidentClient(epicId: string): JudgmentClient {
  return {
    model: 'jev-test',
    judge: () =>
      Promise.resolve({
        model: 'jev-test',
        answers: {
          kind: {
            type: 'choice',
            choice: 'task',
            confidence: 1,
            probabilities: {},
          },
          epic: {
            type: 'choice',
            choice: epicId,
            confidence: 1,
            probabilities: {},
          },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never),
  };
}

async function boot(over: Partial<StartServerOptions>): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    judgments: null,
    ...over,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

async function capture(text: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const items = (await res.json()) as { id: string }[];
  return items[0].id;
}

describe('POST /api/inbox/cluster with triage', () => {
  it('keeps confidently-homed items away from the clusterer and serves the triage', async () => {
    const store = new TaskStore(root);
    const epic = store.create({ title: 'Landing', kind: 'epic' });
    const prompts: string[] = [];
    await boot({
      judgments: confidentClient(epic.meta.id),
      inboxClusterer: recordingClusterer(prompts),
    });
    const a = await capture('landing rows lose their gate');
    const b = await capture('landing table flickers');
    const c = await capture('completely different thing');

    const res = await fetch(`${baseUrl}/api/inbox/cluster`, { method: 'POST' });
    expect(res.status).toBe(200);
    // Every item was homed, so nothing was left to cluster: MIN_ITEMS is 3
    // and the clusterer returns early without a model call.
    expect(prompts).toHaveLength(0);

    const triage = (await (
      await fetch(`${baseUrl}/api/inbox/triage`)
    ).json()) as {
      items: Record<string, { epicId: string | null; kind: string }>;
    };
    for (const id of [a, b, c]) {
      expect(triage.items[id].epicId).toBe(epic.meta.id);
      expect(triage.items[id].kind).toBe('task');
    }
  });

  it('sends every open item to the clusterer when no judgment client is configured', async () => {
    const prompts: string[] = [];
    await boot({
      judgments: null,
      inboxClusterer: recordingClusterer(prompts),
    });
    const ids = [
      await capture('one thing'),
      await capture('another thing'),
      await capture('third thing'),
    ];
    const res = await fetch(`${baseUrl}/api/inbox/cluster`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    for (const id of ids) expect(prompts[0]).toContain(id);

    const triage = await (await fetch(`${baseUrl}/api/inbox/triage`)).json();
    expect(triage).toBeNull();
  });
});

describe('InboxClusterer', () => {
  // The clusterer reads teammates' raw captures, so its model call must carry
  // no tools: no built-ins and none of the operator's own MCP connectors.
  it('offers the model no built-in or operator MCP tools', async () => {
    let options: Record<string, unknown> = {};
    const clusterer = new InboxClusterer(root, ((args: {
      options: Record<string, unknown>;
    }) => {
      options = args.options;
      return (function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 's',
          structured_output: { groups: [] },
        };
      })() as unknown as Query;
    }) as never);
    const now = new Date().toISOString();
    const item = (id: string) => ({
      id,
      kind: 'note' as const,
      text: id,
      done: false,
      linkedTaskId: null,
      createdByRunId: null,
      created: now,
    });
    await clusterer.cluster([item('i-1'), item('i-2'), item('i-3')] as never);
    expect(options.tools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toBeUndefined();
  });
});
