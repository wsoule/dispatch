import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle, StartServerOptions } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { JudgmentClient } from '../src/judgments/client.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// The capture-time judgments: a paste is split at confident boundaries, a
// fresh capture is triaged in the background (its regex kind replaced), and
// convert prefills the epic and reports a likely duplicate.

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-capture-judge-'));
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

// Answers split questions with "starts" on every line that begins with
// "new:", and triage questions with kind bug, the first listed epic, and a
// 0.9 duplicate on every candidate.
function scriptedClient(): JudgmentClient {
  return {
    model: 'jev-test',
    judge: (state, questions) => {
      const answers: Record<string, unknown> = {};
      const lines = (state as { lines?: string[] }).lines;
      const epics = (state as { epics?: { id: string }[] }).epics ?? [];
      for (const key of Object.keys(questions)) {
        if (key.startsWith('boundary_') && lines !== undefined) {
          const line = lines[Number(key.slice('boundary_'.length))] ?? '';
          const starts = line.startsWith('new:');
          answers[key] = {
            type: 'choice',
            choice: starts ? 'starts' : 'continues',
            confidence: 0.95,
            probabilities: {},
          };
        } else if (key === 'kind') {
          answers[key] = {
            type: 'choice',
            choice: 'bug',
            confidence: 0.9,
            probabilities: {},
          };
        } else if (key === 'epic') {
          answers[key] = {
            type: 'choice',
            choice: epics[0]?.id ?? 'none',
            confidence: 0.95,
            probabilities: {},
          };
        } else if (key.startsWith('dup_')) {
          answers[key] = { type: 'noul', noul: 0.9 };
        }
      }
      return Promise.resolve({
        model: 'jev-test',
        answers,
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never);
    },
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

async function capture(
  text: string
): Promise<{ id: string; kind: string; text: string }[]> {
  const res = await fetch(`${baseUrl}/api/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; kind: string; text: string }[];
}

async function listInbox(): Promise<
  { id: string; kind: string; text: string }[]
> {
  return (await (await fetch(`${baseUrl}/api/inbox`)).json()) as never;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timed out');
}

describe('capture-time judgments', () => {
  it('splits a paste at confident boundaries, in reading order', async () => {
    await boot({ judgments: scriptedClient() });
    const created = await capture(
      'fix the board\nit drops cards\nnew: dark mode for the site'
    );
    expect(created.map((i) => i.text)).toEqual([
      'fix the board\nit drops cards',
      'new: dark mode for the site',
    ]);
    const listed = await listInbox();
    expect(listed.map((i) => i.text)).toEqual(created.map((i) => i.text));
  });

  it('triages a fresh capture in the background and takes its judged kind', async () => {
    await boot({ judgments: scriptedClient() });
    const [item] = await capture('the thing looks off');
    expect(item.kind).toBe('note'); // the regex guess, returned immediately
    await waitFor(async () => (await listInbox())[0]?.kind === 'bug');
    const triage = (await (
      await fetch(`${baseUrl}/api/inbox/triage`)
    ).json()) as {
      items: Record<string, { kind: string }>;
    };
    expect(triage.items[item.id].kind).toBe('bug');
  });

  it('leaves capture exactly as before without a client', async () => {
    await boot({ judgments: null });
    const created = await capture('add dark mode\nnew: fix the board');
    expect(created).toHaveLength(1);
    expect(created[0].text).toBe('add dark mode\nnew: fix the board');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await listInbox())[0].kind).toBe('task');
    expect(
      await (await fetch(`${baseUrl}/api/inbox/triage`)).json()
    ).toBeNull();
  });

  it('convert prefills the judged epic and reports a likely duplicate task', async () => {
    const store = new TaskStore(root);
    const epic = store.create({ title: 'Landing', kind: 'epic' });
    const existing = store.create({ title: 'landing rows lose their gate' });
    await boot({ judgments: scriptedClient() });
    const [item] = await capture('landing rows lose their gate chip');
    await waitFor(
      async () =>
        (await (await fetch(`${baseUrl}/api/inbox/triage`)).json()) !== null
    );

    const res = await fetch(`${baseUrl}/api/inbox/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [item.id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { id: string; taskId?: string; duplicateOf?: string }[];
    };
    expect(body.results[0].duplicateOf).toBe(existing.meta.id);
    const task = (await (
      await fetch(`${baseUrl}/api/tasks/${body.results[0].taskId}`)
    ).json()) as {
      meta: { parent: string | null };
    };
    expect(task.meta.parent).toBe(epic.meta.id);
  });
});
