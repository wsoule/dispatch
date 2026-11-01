import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus, type ServerEvent } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  claudeMemoryDir,
  claudeMemoryRoot,
} from '../../src/orchestrator/paths.js';
import type { NormalizedEntry } from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

// A run's Dispatch tool calls that write text stored for fewer readers than
// its transcript has (a personal doc, a doc proposal, a memory, a forget
// reason) keep only what names the call's target, before the entry is
// stored or broadcast.

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo();
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

const secrets = (text: string) => [
  ...new Set(text.match(/PRIVATE-[A-Z-]+/g) ?? []),
];

const TS = '2026-10-26T10:00:00.000Z';

function call(toolName: string, toolInput: unknown): NormalizedEntry {
  return { ts: TS, kind: 'tool', toolName, toolInput, status: 'running' };
}

// Each call as an executor logs it, and what its transcript keeps. Claude
// names a Dispatch tool `mcp__dispatch__<tool>`, Codex `mcp.dispatch.<tool>`
// (and logs a Codex call twice, started and completed).
const CASES: { logged: NormalizedEntry; kept: unknown }[] = [
  {
    logged: call('mcp__dispatch__doc_save', {
      title: 'PRIVATE-TITLE',
      body: 'PRIVATE-BODY',
      slug: 'plan',
      scope: 'personal',
      links: [{ target: 'task:t-1', rel: 'plan' }],
    }),
    kept: {
      slug: 'plan',
      scope: 'personal',
      links: [{ target: 'task:t-1', rel: 'plan' }],
    },
  },
  {
    logged: call('mcp.dispatch.doc_save', {
      doc: '~plan',
      ops: [
        {
          op: 'replace_section',
          section: '#PRIVATE-HEADING',
          text: 'PRIVATE-SECTION',
        },
        { op: 'replace', find: 'PRIVATE-FIND', text: 'PRIVATE-WITH' },
        { op: 'insert', before: '#PRIVATE-BEFORE', text: 'PRIVATE-INSERT' },
        { op: 'set_title', title: 'PRIVATE-RETITLE' },
      ],
      baseRev: 3,
    }),
    kept: {
      doc: '~plan',
      ops: [
        { op: 'replace_section' },
        { op: 'replace' },
        { op: 'insert' },
        { op: 'set_title' },
      ],
      baseRev: 3,
    },
  },
  {
    logged: {
      ...call('mcp.dispatch.doc_save', {
        doc: 'doc-01J00000000000000000000000',
        body: 'PRIVATE-WHOLE',
        title: 'PRIVATE-NEW-TITLE',
        baseRev: 'rev-1',
      }),
      status: 'done',
      toolUseId: 'item_1',
    },
    kept: { doc: 'doc-01J00000000000000000000000', baseRev: 'rev-1' },
  },
  {
    logged: call('mcp__dispatch__memory_save', {
      scope: 'personal',
      kind: 'preference',
      title: 'PRIVATE-LESSON',
      body: 'PRIVATE-WHY',
      refs: [{ type: 'task', id: 't-1' }],
      milestone: null,
      appliesTo: ['t-1'],
      supersedes: 'mem-1',
      projectOnly: true,
    }),
    kept: {
      scope: 'personal',
      kind: 'preference',
      refs: [{ type: 'task', id: 't-1' }],
      milestone: null,
      appliesTo: ['t-1'],
      supersedes: 'mem-1',
      projectOnly: true,
    },
  },
  {
    logged: call('mcp.dispatch.memory_forget', {
      id: '#AB12',
      reason: 'PRIVATE-REASON',
    }),
    kept: { id: '#AB12' },
  },
  // Input that is not an object keeps nothing.
  {
    logged: call('mcp.dispatch.memory_save', '{"title":"PRIVATE-RAW"}'),
    kept: {},
  },
  {
    logged: call('mcp__dispatch__msg_send', {
      to: ['human:test'],
      kind: 'message',
      body: 'PRIVATE-DM',
    }),
    kept: { to: ['human:test'], kind: 'message' },
  },
];

// Calls whose input the transcript keeps whole: Dispatch's reads and writes
// whose text every transcript reader may already read, and other servers'.
const UNTOUCHED: NormalizedEntry[] = [
  call('mcp__dispatch__doc_read', { doc: '~plan', section: '#goals' }),
  call('mcp__dispatch__doc_link', { doc: '~plan', target: 'task:t-1' }),
  call('mcp.dispatch.task_comment', { id: 't-1', text: 'on the board' }),
  call('mcp__other__doc_save', { title: 'theirs', body: 'theirs' }),
  call('Write', { file_path: 'a.md', content: 'in the diff' }),
  // Beside the exports, not in them.
  call('Edit', {
    file_path: '/tmp/claude-memory-notes.md',
    old_string: 'a',
    new_string: 'b',
  }),
];

function setUp(steps: { entry: NormalizedEntry }[]) {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      steps,
      finish: { state: 'finished', costUsd: 0, turns: 1 },
    })
  );
  const seen: ServerEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const task = store.create({ title: 'Write things down' });
  return { orchestrator, seen, taskId: task.meta.id };
}

describe("a run's Dispatch tool calls", () => {
  it('keep only what names their target when they write scoped text', async () => {
    const { orchestrator, seen, taskId } = setUp(
      CASES.map((c) => ({ entry: c.logged }))
    );
    const run = await orchestrator.dispatch(taskId, 'fake');
    await waitFor(() => orchestrator.getRun(run.id)?.meta.state === 'finished');

    const stored = orchestrator.getRun(run.id)?.entries ?? [];
    const logged = seen.flatMap((e) => (e.type === 'run.log' ? [e.entry] : []));
    for (const entries of [stored, logged]) {
      expect(secrets(JSON.stringify(entries))).toEqual([]);
      expect(entries.map((e) => e.toolInput)).toEqual(CASES.map((c) => c.kept));
      // Everything but the input is the executor's.
      expect(entries.map(({ toolInput: _, ...rest }) => rest)).toEqual(
        CASES.map(({ logged: { toolInput: _, ...rest } }) => rest)
      );
    }
  });

  it('keep their whole input otherwise', async () => {
    const { orchestrator, taskId } = setUp(
      UNTOUCHED.map((entry) => ({ entry }))
    );
    const run = await orchestrator.dispatch(taskId, 'fake');
    await waitFor(() => orchestrator.getRun(run.id)?.meta.state === 'finished');

    expect(orchestrator.getRun(run.id)?.entries).toEqual(UNTOUCHED);
  });
});

describe("a run's file writes into a Claude memory export", () => {
  // Export mode hands a Claude run an auto-memory directory and tells it to
  // save memories there as usual, with Write and Edit: what it writes there
  // becomes the operator's personal memory, and an edit's old text is one
  // already exported to it.
  it('keep only the file they name', async () => {
    const dir = claudeMemoryDir(repo, 'r-lineage');
    const writes: { logged: NormalizedEntry; kept: unknown }[] = [
      {
        logged: call('Write', {
          file_path: `${dir}/feedback_x.md`,
          content: '---\nname: PRIVATE-LESSON\n---\nPRIVATE-BODY',
        }),
        kept: { file_path: `${dir}/feedback_x.md` },
      },
      {
        logged: call('Edit', {
          file_path: `${dir}/MEMORY.md`,
          old_string: 'PRIVATE-OLD',
          new_string: 'PRIVATE-NEW',
          replace_all: false,
        }),
        kept: { file_path: `${dir}/MEMORY.md` },
      },
      {
        logged: {
          ...call('MultiEdit', {
            file_path: `${dir}/topic.md`,
            edits: [{ old_string: 'PRIVATE-FROM', new_string: 'PRIVATE-TO' }],
          }),
          parentToolUseId: 'toolu_agent',
        },
        kept: { file_path: `${dir}/topic.md` },
      },
      {
        logged: call('NotebookEdit', {
          notebook_path: `${claudeMemoryRoot(repo)}/o-c1/n.ipynb`,
          new_source: 'PRIVATE-CELL',
        }),
        kept: { notebook_path: `${claudeMemoryRoot(repo)}/o-c1/n.ipynb` },
      },
    ];
    const { orchestrator, seen, taskId } = setUp(
      writes.map((c) => ({ entry: c.logged }))
    );
    const run = await orchestrator.dispatch(taskId, 'fake');
    await waitFor(() => orchestrator.getRun(run.id)?.meta.state === 'finished');

    const stored = orchestrator.getRun(run.id)?.entries ?? [];
    const logged = seen.flatMap((e) => (e.type === 'run.log' ? [e.entry] : []));
    for (const entries of [stored, logged]) {
      expect(secrets(JSON.stringify(entries))).toEqual([]);
      expect(entries.map((e) => e.toolInput)).toEqual(
        writes.map((c) => c.kept)
      );
      expect(entries.map(({ toolInput: _, ...rest }) => rest)).toEqual(
        writes.map(({ logged: { toolInput: _, ...rest } }) => rest)
      );
    }
  });
});
