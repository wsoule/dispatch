import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { PlanManager } from '../../src/orchestrator/plan.js';
import type { PlanProposal } from '../../src/orchestrator/planner.js';
import { FakePlanner } from '../../src/orchestrator/planners/fake.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';

let root: string;
let store: TaskStore;
let cache: TaskCache;
let events: EventBus;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-plan-draft-message-'));
  store = TaskStore.init(root);
  cache = new TaskCache();
  cache.rebuild(store);
  events = new EventBus();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeManager(planner: FakePlanner): PlanManager {
  const manager = new PlanManager({ store, cache, events, rootDir: root });
  manager.registerPlanner('claude', planner);
  return manager;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

const SAMPLE_PROPOSAL: PlanProposal = {
  tasks: [
    {
      title: 'Design the widget',
      description: 'Sketch the API.',
      acceptanceCriteria: ['API sketch reviewed'],
      blockedByIndices: [],
      priority: 'high',
    },
  ],
};

// A first turn that only asks, then a second that proposes — the shape
// sendDraftMessage's happy path and session-id threading both exercise.
function questionThenAnswerPlanner(): FakePlanner {
  return new FakePlanner({
    ok: true,
    turns: [
      {
        reply: 'quick question first',
        proposal: null,
        questions: [{ id: 'q1', question: 'Scope?', options: [] }],
      },
      { reply: 'here you go', proposal: SAMPLE_PROPOSAL },
    ],
  });
}

describe('PlanManager.sendDraftMessage', () => {
  it('sends a follow-up, keeps the prior questions in flight, and settles ready', async () => {
    const manager = makeManager(questionThenAnswerPlanner());
    const started = manager.startDraft('draft something vague');
    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    expect(manager.getDraft(started.id).questions).toHaveLength(1);

    const sent = manager.sendDraftMessage(started.id, 'desktop only');
    expect(sent.state).toBe('running');
    expect(sent.questions).toHaveLength(1);

    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    const record = manager.getDraft(started.id);
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(SAMPLE_PROPOSAL);
    expect(record.message).toBe('here you go');
  });

  it('threads the opening turn’s session id into the follow-up planner call', async () => {
    const manager = makeManager(questionThenAnswerPlanner());
    const started = manager.startDraft('draft something vague');
    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    expect(manager.getDraft(started.id).sessionId).toBe('1');

    manager.sendDraftMessage(started.id, 'desktop only');
    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    expect(manager.getDraft(started.id).sessionId).toBe('2');
  });

  it('409s a follow-up while a turn is still running', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startDraft('draft something');
    expect(manager.getDraft(started.id).state).toBe('running');
    expect(() => manager.sendDraftMessage(started.id, 'too soon')).toThrow(
      OrchestratorConflictError
    );
  });

  it('404s a follow-up to an unknown draft', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.sendDraftMessage('d-000000', 'hello')).toThrow(
      OrchestratorNotFoundError
    );
  });
});
