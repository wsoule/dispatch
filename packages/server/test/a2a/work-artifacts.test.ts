import { decideState } from '@dispatch/a2a';
import { afterEach, beforeEach, expect, it } from 'bun:test';

import { useTempProject } from '../messaging/harness.js';
import { approvedHandoff, bridgeFixture, stubRun } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
beforeEach(async () => {
  f = await bridgeFixture(project.root());
});
afterEach(() => f.close());

it('publishes pr (merged), diffstat and evidence once the task lands', async () => {
  const { id, row } = await approvedHandoff(f);
  stubRun(f, {
    id: 'r-00000a',
    taskId: row.dispatchTask!,
    kind: 'execute',
    prUrl: 'https://github.com/acme/api/pull/42',
    createdAt: '2026-09-25T10:00:00.000Z',
  });
  f.deps.runPatch = () =>
    'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new';
  f.deps.runEvidence = () => [
    {
      command: 'bun test',
      exitCode: 0,
      durationMs: 900,
      summary: '12 pass',
      at: '2026-09-25T10:05:00.000Z',
    },
  ];
  f.deps.updateTask(row.dispatchTask!, { status: 'landed' });
  const facts = (await f.port.facts(f.caller, id))!;
  expect(decideState(facts).state).toBe('COMPLETED');
  expect(facts.work.pr).toEqual({
    kind: 'pr',
    url: 'https://github.com/acme/api/pull/42',
    number: 42,
    state: 'merged',
  });
  expect(facts.work.diffstat).toMatchObject({
    files: 1,
    insertions: 1,
    deletions: 1,
  });
  expect(facts.work.evidence).toMatchObject({
    items: [{ command: 'bun test' }],
  });
});

it('has no pr artifact when the project lands by local merge', async () => {
  const { id, row } = await approvedHandoff(f);
  stubRun(f, {
    id: 'r-00000b',
    taskId: row.dispatchTask!,
    kind: 'execute',
    createdAt: '2026-09-25T10:00:00.000Z',
  });
  f.deps.updateTask(row.dispatchTask!, { status: 'landed' });
  expect((await f.port.facts(f.caller, id))!.work.pr).toBeUndefined();
});

it('reads only the latest execute run, never a review run after it', async () => {
  const { id, row } = await approvedHandoff(f);
  const task = row.dispatchTask!;
  stubRun(f, {
    id: 'r-00000c',
    taskId: task,
    kind: 'execute',
    prUrl: 'https://github.com/acme/api/pull/7',
    createdAt: '2026-09-25T09:00:00.000Z',
  });
  stubRun(f, {
    id: 'r-00000d',
    taskId: task,
    kind: 'execute',
    prUrl: 'https://github.com/acme/api/pull/8',
    createdAt: '2026-09-25T10:00:00.000Z',
  });
  stubRun(f, {
    id: 'r-00000e',
    taskId: task,
    kind: 'review',
    prUrl: 'https://github.com/acme/api/pull/9',
    createdAt: '2026-09-25T11:00:00.000Z',
  });
  const patched: string[] = [];
  f.deps.runPatch = (runId) => {
    patched.push(runId);
    return null;
  };
  f.deps.prOpen = (url) => url.endsWith('/8');
  const facts = (await f.port.facts(f.caller, id))!;
  expect(facts.work.pr).toEqual({
    kind: 'pr',
    url: 'https://github.com/acme/api/pull/8',
    number: 8,
    state: 'open',
  });
  expect(facts.work.diffstat).toBeUndefined();
  expect(facts.work.evidence).toBeUndefined();
  expect(patched).toEqual(['r-00000d']);
});

it('publishes nothing for a handoff still waiting on its proposal', async () => {
  const opened = await f.port.open(f.caller, {
    clientMessageId: 'c-h9',
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body: 'Please add limits.',
    refs: [],
    work: { skill: 'handoff', title: 'Rate-limit uploads' },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const row = f.store.getTask(opened.taskId)!;
  stubRun(f, {
    id: 'r-00000f',
    taskId: row.dispatchTask!,
    kind: 'execute',
    prUrl: 'https://github.com/acme/api/pull/3',
    createdAt: '2026-09-25T10:00:00.000Z',
  });
  expect((await f.port.facts(f.caller, opened.taskId))!.work).toEqual({});
});
