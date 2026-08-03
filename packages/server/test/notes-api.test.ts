import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Note } from '../src/notes.js';
import type {
  Planner,
  PlannerTurn,
  PlanProposal,
} from '../src/orchestrator/planner.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json(res: Response): Promise<any> {
  return res.json();
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-notes-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// FakePlanner with the one extra thing these tests need: the prompt it was
// handed, so "the note actually reaches the planner" is an assertion rather
// than an assumption.
class RecordingPlanner implements Planner {
  prompts: string[] = [];

  constructor(private readonly proposal: PlanProposal) {}

  async start(prompt: string): Promise<PlannerTurn> {
    this.prompts.push(prompt);
    return {
      reply: 'drafted a task',
      proposal: this.proposal,
      questions: [],
      sessionId: '1',
    };
  }

  async sendMessage(
    _sessionId: string | undefined,
    message: string
  ): Promise<PlannerTurn> {
    this.prompts.push(message);
    return {
      reply: 'refined',
      proposal: this.proposal,
      questions: [],
      sessionId: '2',
    };
  }
}

const DRAFTED_TASK: PlanProposal = {
  tasks: [
    {
      title: 'Split the 900-line NotesView into focused components',
      description: 'apps/desktop/src/views/NotesView.tsx does too much.',
      acceptanceCriteria: ['NotesView is under 200 lines'],
      blockedByIndices: [],
      priority: 'medium',
    },
  ],
};

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let planner: RecordingPlanner;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  planner = new RecordingPlanner(DRAFTED_TASK);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    // Registered as 'claude' because that is the planner the enrich endpoint
    // asks for; the real ClaudePlanner is never constructed in CI.
    registerPlanners: (planManager) => {
      planManager.registerPlanner('claude', planner);
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function createNote(
  title: string,
  body?: string,
  kind = 'triage'
): Promise<Note> {
  const res = await fetch(`${baseUrl}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, title, body }),
  });
  expect(res.status).toBe(201);
  return (await json(res)) as Note;
}

async function waitForReadyPlan(planId: string): Promise<any> {
  await waitFor(async () => {
    const r = await json(await fetch(`${baseUrl}/api/plan/${planId}`));
    return r.state !== 'running';
  });
  return json(await fetch(`${baseUrl}/api/plan/${planId}`));
}

describe('POST /api/notes/:id/enrich', () => {
  it('starts a plan that carries the note and its text to the planner', async () => {
    const note = await createNote(
      'NotesView is huge, split it',
      'it renders the composer, the rows, and the draft'
    );

    const res = await fetch(`${baseUrl}/api/notes/${note.id}/enrich`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const { planId } = await json(res);

    const record = await waitForReadyPlan(planId);
    expect(record.state).toBe('ready');
    expect(record.sourceNoteId).toBe(note.id);
    expect(record.proposal).toEqual(DRAFTED_TASK);

    expect(planner.prompts).toHaveLength(1);
    expect(planner.prompts[0]).toContain('NotesView is huge, split it');
    expect(planner.prompts[0]).toContain(
      'it renders the composer, the rows, and the draft'
    );
    // The draft is meant to replace one note with one task, not open an epic.
    expect(planner.prompts[0]).toContain('exactly ONE task');
  });

  it('leaves the note un-promoted until the plan is confirmed', async () => {
    const note = await createNote('NotesView is huge, split it');
    const { planId } = await json(
      await fetch(`${baseUrl}/api/notes/${note.id}/enrich`, { method: 'POST' })
    );
    await waitForReadyPlan(planId);

    const notes = (await json(await fetch(`${baseUrl}/api/notes`))) as Note[];
    expect(notes[0].linkedTaskId).toBeNull();
    expect(notes[0].done).toBe(false);
    const tasks = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(tasks).toHaveLength(0);
  });

  it('404s an unknown note', async () => {
    const res = await fetch(`${baseUrl}/api/notes/nt-nope/enrich`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('409s a note that was already promoted', async () => {
    const note = await createNote('already handled');
    await fetch(`${baseUrl}/api/notes/${note.id}/promote`, { method: 'POST' });

    const res = await fetch(`${baseUrl}/api/notes/${note.id}/enrich`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });
});

describe('confirming a note-derived plan', () => {
  it('writes the drafted task and links the note to it', async () => {
    const note = await createNote('NotesView is huge, split it');
    const { planId } = await json(
      await fetch(`${baseUrl}/api/notes/${note.id}/enrich`, { method: 'POST' })
    );
    const record = await waitForReadyPlan(planId);

    const confirmRes = await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: record.proposal }),
    });
    expect(confirmRes.status).toBe(200);
    const result = await json(confirmRes);
    expect(result.taskIds).toHaveLength(1);

    const task = await json(
      await fetch(`${baseUrl}/api/tasks/${result.taskIds[0]}`)
    );
    expect(task.meta.title).toBe(DRAFTED_TASK.tasks[0].title);
    expect(task.body).toContain('apps/desktop/src/views/NotesView.tsx');
    expect(task.body).toContain('NotesView is under 200 lines');

    const notes = (await json(await fetch(`${baseUrl}/api/notes`))) as Note[];
    expect(notes[0].linkedTaskId).toBe(result.taskIds[0]);
    expect(notes[0].done).toBe(true);
  });

  it('still creates the task when the note was deleted mid-draft', async () => {
    const note = await createNote('NotesView is huge, split it');
    const { planId } = await json(
      await fetch(`${baseUrl}/api/notes/${note.id}/enrich`, { method: 'POST' })
    );
    const record = await waitForReadyPlan(planId);
    await fetch(`${baseUrl}/api/notes/${note.id}`, { method: 'DELETE' });

    const confirmRes = await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: record.proposal }),
    });
    expect(confirmRes.status).toBe(200);
    expect((await json(confirmRes)).taskIds).toHaveLength(1);
  });

  it('leaves an ordinary plan alone (no note to link)', async () => {
    const startRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'build a widget' }),
    });
    const { planId } = await json(startRes);
    const record = await waitForReadyPlan(planId);
    expect(record.sourceNoteId).toBeUndefined();

    const confirmRes = await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: record.proposal }),
    });
    expect(confirmRes.status).toBe(200);
  });
});

describe('POST /api/notes/:id/promote', () => {
  it('copies the note across verbatim and links it', async () => {
    const note = await createNote('fix the flaky watcher test', 'it retries');

    const res = await fetch(`${baseUrl}/api/notes/${note.id}/promote`, {
      method: 'POST',
    });
    expect(res.status).toBe(201);
    const task = await json(res);
    expect(task.meta.title).toBe('fix the flaky watcher test');
    expect(task.body).toContain('it retries');

    const notes = (await json(await fetch(`${baseUrl}/api/notes`))) as Note[];
    expect(notes[0].linkedTaskId).toBe(task.meta.id);
    expect(notes[0].done).toBe(true);
  });

  it('409s a second promote', async () => {
    const note = await createNote('fix the flaky watcher test');
    await fetch(`${baseUrl}/api/notes/${note.id}/promote`, { method: 'POST' });
    const res = await fetch(`${baseUrl}/api/notes/${note.id}/promote`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });
});
