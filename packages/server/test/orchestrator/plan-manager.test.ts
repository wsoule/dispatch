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
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';

let root: string;
let store: TaskStore;
let cache: TaskCache;
let events: EventBus;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-plan-'));
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

// Starts a plan and waits for it to leave 'running' — confirm() now requires
// state === 'ready' (see the minors fix), so every confirm-path test needs
// the plan to have actually settled first, not just been started.
async function startAndSettle(
  manager: PlanManager,
  prompt: string
): Promise<ReturnType<PlanManager['get']>> {
  const started = manager.startPlan(prompt);
  await waitFor(() => manager.get(started.id).state !== 'running');
  return manager.get(started.id);
}

const SAMPLE_PROPOSAL: PlanProposal = {
  epic: { title: 'Ship the widget', description: 'Build the whole widget.' },
  tasks: [
    {
      title: 'Design the widget',
      description: 'Sketch the API.',
      acceptanceCriteria: ['API sketch reviewed'],
      blockedByIndices: [],
      priority: 'high',
    },
    {
      title: 'Implement the widget',
      description: 'Write the code.',
      acceptanceCriteria: ['Tests pass'],
      blockedByIndices: [0],
      priority: 'medium',
    },
  ],
};

describe('PlanManager.startPlan / get', () => {
  it('goes running -> ready on a successful FakePlanner', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
    expect(started.state).toBe('running');

    await waitFor(() => manager.get(started.id).state !== 'running');
    const record = manager.get(started.id);
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(SAMPLE_PROPOSAL);
  });

  it('goes running -> failed when the planner rejects', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: false, error: 'planner exploded' })
    );
    const started = manager.startPlan('anything');

    await waitFor(() => manager.get(started.id).state !== 'running');
    const record = manager.get(started.id);
    expect(record.state).toBe('failed');
    expect(record.error).toBe('planner exploded');
  });

  it('broadcasts plan.changed on state transitions', async () => {
    const received: unknown[] = [];
    events.add({ send: (data: string) => received.push(JSON.parse(data)) });
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');

    await waitFor(() => manager.get(started.id).state !== 'running');
    expect(
      received.some(
        (e) =>
          (e as { type: string; planId: string }).type === 'plan.changed' &&
          (e as { planId: string }).planId === started.id
      )
    ).toBe(true);
  });

  it('throws OrchestratorNotFoundError for an unknown plan id', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.get('plan-000000')).toThrow(OrchestratorNotFoundError);
  });
});

describe('PlanManager.confirm', () => {
  it('writes the epic first, then tasks with parent + blockedBy wired from indices', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const result = manager.confirm(started.id, SAMPLE_PROPOSAL);

    expect(result.epicId).toBeDefined();
    expect(result.taskIds).toHaveLength(2);

    const epic = store.get(result.epicId!);
    expect(epic?.meta.kind).toBe('epic');
    expect(epic?.meta.status).toBe('todo');
    expect(epic?.meta.title).toBe('Ship the widget');

    const [designId, implementId] = result.taskIds;
    const design = store.get(designId);
    const implement = store.get(implementId);
    expect(design?.meta.status).toBe('todo');
    expect(design?.meta.parent).toBe(result.epicId);
    expect(design?.meta.blockedBy).toEqual([]);
    expect(implement?.meta.parent).toBe(result.epicId);
    expect(implement?.meta.blockedBy).toEqual([designId]);
    expect(implement?.meta.priority).toBe('medium');
    expect(implement?.body).toContain('Tests pass');
  });

  it('leaves an epic Activity note when a confirmed task has no declared writes', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const result = manager.confirm(started.id, SAMPLE_PROPOSAL);

    const epic = store.get(result.epicId!);
    expect(epic?.body).toContain('undeclared writes');
    // The hold is against every live run in the project, not just this epic's
    // siblings — see epic.test.ts's "wait on any live claim, even a disjoint one".
    expect(epic?.body).toContain('no run is live anywhere in the project');
  });

  // A single-task epic is where "serialize" reads as vacuous, but the hold is
  // project-wide, so that lone task still waits behind an unrelated run.
  it('leaves the note on a single-task epic as well', async () => {
    const proposal: PlanProposal = {
      epic: { title: 'One thing', description: 'Just the one task.' },
      tasks: [
        {
          title: 'Touches who knows what',
          description: 'No writes declared.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'medium',
        },
      ],
    };
    const manager = makeManager(new FakePlanner({ ok: true, proposal }));
    const started = await startAndSettle(manager, 'do one thing');
    const result = manager.confirm(started.id, proposal);

    expect(store.get(result.epicId!)?.body).toContain('undeclared writes');
  });

  it("carries a task's declared writes/risk onto its created TaskMeta", async () => {
    const proposal: PlanProposal = {
      tasks: [
        {
          title: 'Migrate the schema',
          description: 'Touches the DB.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'high',
          writes: ['migrations/001.sql'],
          risk: 'elevated',
        },
      ],
    };
    const manager = makeManager(new FakePlanner({ ok: true, proposal }));
    const started = await startAndSettle(manager, 'migrate the schema');
    const result = manager.confirm(started.id, proposal);

    const task = store.get(result.taskIds[0]);
    expect(task?.meta.writes).toEqual(['migrations/001.sql']);
    expect(task?.meta.risk).toBe('elevated');
  });

  it('leaves no undeclared-writes note when every task declares writes', async () => {
    const proposal: PlanProposal = {
      epic: { title: 'Ship it', description: 'Two well-scoped tasks.' },
      tasks: [
        {
          title: 'A',
          description: 'Touches a.ts.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'medium',
          writes: ['a.ts'],
        },
        {
          title: 'B',
          description: 'Touches b.ts.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'medium',
          writes: ['b.ts'],
        },
      ],
    };
    const manager = makeManager(new FakePlanner({ ok: true, proposal }));
    const started = await startAndSettle(manager, 'build two things');
    const result = manager.confirm(started.id, proposal);

    const epic = store.get(result.epicId!);
    expect(epic?.body).not.toContain('undeclared writes');
  });

  it('writes a flat task list with no epic when the proposal omits one', async () => {
    const proposal: PlanProposal = {
      tasks: [
        {
          title: 'Solo task',
          description: 'No epic needed.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'none',
        },
      ],
    };
    const manager = makeManager(new FakePlanner({ ok: true, proposal }));
    const started = await startAndSettle(manager, 'small thing');
    const result = manager.confirm(started.id, proposal);

    expect(result.epicId).toBeUndefined();
    const task = store.get(result.taskIds[0]);
    expect(task?.meta.parent).toBeNull();
  });

  it('404s confirming an unknown plan id', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.confirm('plan-000000', SAMPLE_PROPOSAL)).toThrow(
      OrchestratorNotFoundError
    );
  });

  it('409s a second confirm of the same plan', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    manager.confirm(started.id, SAMPLE_PROPOSAL);
    expect(() => manager.confirm(started.id, SAMPLE_PROPOSAL)).toThrow(
      OrchestratorConflictError
    );
  });

  it('accepts a client-edited proposal instead of the stored one (confirm body is authoritative)', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const edited: PlanProposal = {
      tasks: [
        {
          title: 'Edited solo task',
          description: 'Client removed the epic and second task.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'low',
        },
      ],
    };
    const result = manager.confirm(started.id, edited);
    expect(result.taskIds).toHaveLength(1);
    expect(store.get(result.taskIds[0])?.meta.title).toBe('Edited solo task');
  });

  it('400s a proposal with a non-array tasks field', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    expect(() => manager.confirm(started.id, { tasks: 'nope' })).toThrow(
      OrchestratorClientError
    );
  });

  it('400s a proposal with an empty task title', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const bad: PlanProposal = {
      tasks: [
        {
          title: '   ',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'none',
        },
      ],
    };
    expect(() => manager.confirm(started.id, bad)).toThrow(
      OrchestratorClientError
    );
  });

  it('400s a proposal with an invalid priority', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const bad = {
      tasks: [
        {
          title: 'Bad priority',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'super-urgent',
        },
      ],
    };
    expect(() => manager.confirm(started.id, bad)).toThrow(
      OrchestratorClientError
    );
  });

  it('400s a proposal with an out-of-range blockedByIndices entry', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const bad: PlanProposal = {
      tasks: [
        {
          title: 'Only task',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [5],
          priority: 'none',
        },
      ],
    };
    expect(() => manager.confirm(started.id, bad)).toThrow(
      OrchestratorClientError
    );
  });

  it('400s a proposal whose blockedByIndices form a cycle', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const bad: PlanProposal = {
      tasks: [
        {
          title: 'A',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [1],
          priority: 'none',
        },
        {
          title: 'B',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [0],
          priority: 'none',
        },
      ],
    };
    expect(() => manager.confirm(started.id, bad)).toThrow(
      OrchestratorClientError
    );
  });

  it('400s a proposal where a task blocks on itself', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const bad: PlanProposal = {
      tasks: [
        {
          title: 'Self blocker',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [0],
          priority: 'none',
        },
      ],
    };
    expect(() => manager.confirm(started.id, bad)).toThrow(
      OrchestratorClientError
    );
  });

  it('ignores a client-supplied status field — tasks and epic are always created todo', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    const withStatus = {
      epic: { title: 'Sneaky epic', description: '', status: 'done' },
      tasks: [
        {
          title: 'Sneaky task',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'none',
          status: 'in-progress',
        },
      ],
    };
    const result = manager.confirm(started.id, withStatus);
    expect(store.get(result.epicId!)?.meta.status).toBe('todo');
    expect(store.get(result.taskIds[0])?.meta.status).toBe('todo');
  });

  // Minor fix: confirm is only meaningful against a plan that actually
  // produced a proposal — confirming one still `running` (the planner
  // hasn't answered yet) or `failed` (it errored) must 409, not silently
  // write whatever the client happened to send.
  it('409s confirming a plan that is still running', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
    expect(manager.get(started.id).state).toBe('running');
    expect(() => manager.confirm(started.id, SAMPLE_PROPOSAL)).toThrow(
      OrchestratorConflictError
    );
  });

  it('409s confirming a plan that failed', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: false, error: 'planner exploded' })
    );
    const started = await startAndSettle(manager, 'anything');
    expect(started.state).toBe('failed');
    expect(() => manager.confirm(started.id, SAMPLE_PROPOSAL)).toThrow(
      OrchestratorConflictError
    );
  });

  // Minor fix: a planner (Fake or Claude) can return a proposal that itself
  // fails validation — confirm() re-validates from scratch regardless, but
  // a plan should never sit at `ready` advertising a proposal nobody could
  // actually confirm. runPlanner() now validates before marking ready, and
  // downgrades to `failed` with the validation message on a bad proposal.
  it('marks the plan failed (not ready) when the planner itself returns an invalid proposal', async () => {
    const invalidProposal = {
      tasks: [
        {
          title: 'Bad priority from planner',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'super-urgent',
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: invalidProposal })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    expect(started.state).toBe('failed');
    expect(started.error).toMatch(/invalid priority/);
    expect(started.proposal).toBeUndefined();
  });

  // Minor fix: duplicate indices in blockedByIndices (a planner artifact, or
  // a client double-entry) must collapse to a single blockedBy id rather
  // than writing the same real id into the array more than once.
  it('dedupes duplicate blockedByIndices entries into a single blockedBy id', async () => {
    const proposal: PlanProposal = {
      tasks: [
        {
          title: 'A',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'none',
        },
        {
          title: 'B',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'none',
        },
        {
          title: 'C depends on A and B twice each',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [0, 0, 1, 1],
          priority: 'none',
        },
      ],
    };
    const manager = makeManager(new FakePlanner({ ok: true, proposal }));
    const started = await startAndSettle(manager, 'build a widget feature');
    const result = manager.confirm(started.id, proposal);

    const [aId, bId, cId] = result.taskIds;
    expect(store.get(cId)?.meta.blockedBy).toEqual([aId, bId]);
  });
});

// A plan is a durable conversation, not a single prompt-in/proposal-out call.
// PlanManager records the message history, threads the planner's session id
// across turns, and keeps the *latest* working proposal as the confirm target.
describe('PlanManager multi-turn conversation', () => {
  const DRAFT_ONE: PlanProposal = {
    tasks: [
      {
        title: 'First task',
        description: 'The opening draft.',
        acceptanceCriteria: [],
        blockedByIndices: [],
        priority: 'medium',
      },
    ],
  };
  const DRAFT_TWO: PlanProposal = {
    tasks: [
      {
        title: 'First task',
        description: 'The opening draft.',
        acceptanceCriteria: [],
        blockedByIndices: [],
        priority: 'medium',
      },
      {
        title: 'Second task',
        description: 'Added on the follow-up turn.',
        acceptanceCriteria: [],
        blockedByIndices: [0],
        priority: 'low',
      },
    ],
  };

  function conversationalManager(): PlanManager {
    return makeManager(
      new FakePlanner({
        ok: true,
        turns: [
          { reply: 'here is a first draft', proposal: DRAFT_ONE },
          { reply: 'added the second task', proposal: DRAFT_TWO },
        ],
      })
    );
  }

  it('records the opening turn as a user prompt + assistant reply', async () => {
    const manager = conversationalManager();
    const started = await startAndSettle(manager, 'build a widget');
    expect(started.state).toBe('ready');
    expect(started.proposal).toEqual(DRAFT_ONE);
    expect(started.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(started.messages[0].text).toBe('build a widget');
    expect(started.messages[1].text).toBe('here is a first draft');
  });

  it('refines the working proposal on a follow-up message and grows the history', async () => {
    const manager = conversationalManager();
    const started = await startAndSettle(manager, 'build a widget');

    manager.sendMessage(started.id, 'add a second task');
    await waitFor(
      () =>
        manager.get(started.id).state === 'ready' &&
        manager.get(started.id).proposal?.tasks.length === 2
    );

    const record = manager.get(started.id);
    expect(record.proposal).toEqual(DRAFT_TWO);
    expect(record.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(record.messages[2].text).toBe('add a second task');
    expect(record.messages[3].text).toBe('added the second task');
  });

  it('confirms the latest working proposal after a refinement', async () => {
    const manager = conversationalManager();
    const started = await startAndSettle(manager, 'build a widget');
    manager.sendMessage(started.id, 'add a second task');
    await waitFor(() => manager.get(started.id).proposal?.tasks.length === 2);

    const record = manager.get(started.id);
    const result = manager.confirm(record.id, record.proposal);
    expect(result.taskIds).toHaveLength(2);
    const [firstId, secondId] = result.taskIds;
    expect(store.get(secondId)?.meta.blockedBy).toEqual([firstId]);
  });

  it('broadcasts plan.changed for each conversational turn', async () => {
    const received: unknown[] = [];
    events.add({ send: (data: string) => received.push(JSON.parse(data)) });
    const manager = conversationalManager();
    const started = await startAndSettle(manager, 'build a widget');
    const afterStart = received.length;

    manager.sendMessage(started.id, 'add a second task');
    await waitFor(() => manager.get(started.id).proposal?.tasks.length === 2);
    // The follow-up produces at least the running -> ready broadcast on top of
    // whatever the opening turn already sent.
    expect(received.length).toBeGreaterThan(afterStart);
  });

  it('404s a follow-up message to an unknown plan', () => {
    const manager = conversationalManager();
    expect(() => manager.sendMessage('plan-000000', 'hello')).toThrow(
      OrchestratorNotFoundError
    );
  });

  it('409s a follow-up message while a turn is still running', () => {
    const manager = conversationalManager();
    const started = manager.startPlan('build a widget');
    expect(manager.get(started.id).state).toBe('running');
    expect(() => manager.sendMessage(started.id, 'too soon')).toThrow(
      OrchestratorConflictError
    );
  });

  it('409s a follow-up message after the plan is confirmed', async () => {
    const manager = conversationalManager();
    const started = await startAndSettle(manager, 'build a widget');
    manager.confirm(started.id, started.proposal);
    expect(() => manager.sendMessage(started.id, 'one more thing')).toThrow(
      OrchestratorConflictError
    );
  });
});

describe('PlanManager questions-only turns', () => {
  it('accepts a turn that asks questions with a null proposal, landing ready (not failed)', async () => {
    const questions = [
      {
        id: 'q1',
        question: 'Scope: mobile too, or desktop only?',
        options: [],
      },
    ];
    const manager = makeManager(
      new FakePlanner({
        ok: true,
        proposal: null,
        reply: 'A couple of things first.',
        questions,
      })
    );
    const started = manager.startPlan('build something vague');

    await waitFor(() => manager.get(started.id).state !== 'running');
    const record = manager.get(started.id);
    expect(record.state).toBe('ready');
    expect(record.error).toBeUndefined();
    expect(record.proposal).toBeUndefined();
    expect(record.questions).toEqual(questions);
    expect(record.messages[1].text).toBe('A couple of things first.');
  });

  it('keeps the prior working proposal when a later turn only asks more questions', async () => {
    const manager = makeManager(
      new FakePlanner({
        ok: true,
        turns: [
          { reply: 'first pass', proposal: SAMPLE_PROPOSAL },
          {
            reply: 'one more thing',
            proposal: null,
            questions: [{ id: 'q1', question: 'And non-goals?', options: [] }],
          },
        ],
      })
    );
    const started = await startAndSettle(manager, 'build a widget feature');
    manager.sendMessage(started.id, 'looks good, keep going');
    await waitFor(() => manager.get(started.id).questions.length > 0);

    const record = manager.get(started.id);
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(SAMPLE_PROPOSAL);
    expect(record.questions).toHaveLength(1);
  });

  it('clears the prior turn’s questions once a follow-up message is sent', async () => {
    const manager = makeManager(
      new FakePlanner({
        ok: true,
        turns: [
          {
            reply: 'a question first',
            proposal: null,
            questions: [{ id: 'q1', question: 'Scope?', options: [] }],
          },
          { reply: 'thanks, here is the plan', proposal: SAMPLE_PROPOSAL },
        ],
      })
    );
    const started = await startAndSettle(manager, 'build something vague');
    expect(started.questions).toHaveLength(1);

    const sent = manager.sendMessage(started.id, 'desktop only');
    expect(sent.questions).toEqual([]);
  });
});

// The natural-language single-task creator: mints a DraftRecord and runs the
// turn in the background, the same running -> ready|failed shape as a plan.
describe('PlanManager.startDraft / getDraft / listDrafts / dismissDraft', () => {
  it('returns immediately with state running, then settles ready with the proposal + reply', async () => {
    const manager = makeManager(
      new FakePlanner({
        ok: true,
        reply: 'here is your task',
        proposal: SAMPLE_PROPOSAL,
      })
    );
    const started = manager.startDraft('design the widget please');
    expect(started.state).toBe('running');
    expect(started.proposal).toBeNull();
    expect(started.error).toBeNull();

    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    const record = manager.getDraft(started.id);
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(SAMPLE_PROPOSAL);
    expect(record.message).toBe('here is your task');
    expect(record.error).toBeNull();
  });

  // No busy-guard between drafts: two started back to back run fully
  // concurrently and both show up in listDrafts() once done.
  it('runs two drafts started back-to-back fully concurrently, both reaching ready independently', async () => {
    const manager = new PlanManager({ store, cache, events, rootDir: root });
    const widgetProposal: PlanProposal = {
      tasks: [
        {
          title: 'Widget task',
          description: 'Build the widget.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'high',
        },
      ],
    };
    const gadgetProposal: PlanProposal = {
      tasks: [
        {
          title: 'Gadget task',
          description: 'Build the gadget.',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'low',
        },
      ],
    };
    manager.registerPlanner(
      'widget-planner',
      new FakePlanner({ ok: true, proposal: widgetProposal })
    );
    manager.registerPlanner(
      'gadget-planner',
      new FakePlanner({ ok: true, proposal: gadgetProposal })
    );

    const first = manager.startDraft('a widget', 'widget-planner');
    const second = manager.startDraft('a gadget', 'gadget-planner');
    expect(first.id).not.toBe(second.id);
    expect(first.state).toBe('running');
    expect(second.state).toBe('running');

    await waitFor(
      () =>
        manager.getDraft(first.id).state !== 'running' &&
        manager.getDraft(second.id).state !== 'running'
    );

    expect(manager.getDraft(first.id).state).toBe('ready');
    expect(manager.getDraft(first.id).proposal).toEqual(widgetProposal);
    expect(manager.getDraft(second.id).state).toBe('ready');
    expect(manager.getDraft(second.id).proposal).toEqual(gadgetProposal);

    const ids = manager.listDrafts().map((d) => d.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  // A failing turn must land only that draft `failed`, without affecting a
  // sibling draft running on a different planner at the same time.
  it('lands a failing draft as failed with error set, without affecting a concurrent successful draft', async () => {
    const manager = new PlanManager({ store, cache, events, rootDir: root });
    manager.registerPlanner(
      'claude',
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    manager.registerPlanner(
      'broken',
      new FakePlanner({ ok: false, error: 'planner exploded' })
    );

    const good = manager.startDraft('build a widget feature', 'claude');
    const bad = manager.startDraft('anything', 'broken');

    await waitFor(
      () =>
        manager.getDraft(good.id).state !== 'running' &&
        manager.getDraft(bad.id).state !== 'running'
    );

    expect(manager.getDraft(bad.id).state).toBe('failed');
    expect(manager.getDraft(bad.id).error).toBe('planner exploded');
    expect(manager.getDraft(bad.id).proposal).toBeNull();

    expect(manager.getDraft(good.id).state).toBe('ready');
    expect(manager.getDraft(good.id).proposal).toEqual(SAMPLE_PROPOSAL);
    expect(manager.getDraft(good.id).error).toBeNull();
  });

  it('re-validates the planner proposal with the same priority rules, landing failed rather than throwing', async () => {
    const invalidProposal = {
      tasks: [
        {
          title: 'Bad priority from planner',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'super-urgent',
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: invalidProposal })
    );
    const started = manager.startDraft('anything');
    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    const record = manager.getDraft(started.id);
    expect(record.state).toBe('failed');
    expect(record.error).toMatch(/invalid priority/);
    expect(record.proposal).toBeNull();
  });

  it('fails a draft whose planner returns a proposal with no tasks', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: { tasks: [] } })
    );
    const started = manager.startDraft('nothing actionable');
    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    const record = manager.getDraft(started.id);
    expect(record.state).toBe('failed');
    expect(record.error).toMatch(/no task/);
  });

  it('throws for an unregistered planner name (same contract as startPlan)', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.startDraft('anything', 'fake')).toThrow(
      OrchestratorClientError
    );
  });

  it('broadcasts draft.changed on state transitions', async () => {
    const received: unknown[] = [];
    events.add({ send: (data: string) => received.push(JSON.parse(data)) });
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startDraft('design the widget please');

    await waitFor(() => manager.getDraft(started.id).state !== 'running');
    expect(
      received.some((e) => (e as { type: string }).type === 'draft.changed')
    ).toBe(true);
  });

  it('throws OrchestratorNotFoundError for an unknown draft id', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.getDraft('d-000000')).toThrow(
      OrchestratorNotFoundError
    );
  });

  it('dismissDraft removes the record — a subsequent getDraft 404s and it drops out of listDrafts', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startDraft('design the widget please');
    await waitFor(() => manager.getDraft(started.id).state !== 'running');

    manager.dismissDraft(started.id);

    expect(() => manager.getDraft(started.id)).toThrow(
      OrchestratorNotFoundError
    );
    expect(manager.listDrafts().map((d) => d.id)).not.toContain(started.id);
  });

  it('dismissDraft is a silent no-op for an unknown id', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.dismissDraft('d-000000')).not.toThrow();
  });

  it('lists drafts newest first', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const first = manager.startDraft('first');
    await waitFor(() => manager.getDraft(first.id).state !== 'running');
    const second = manager.startDraft('second');
    await waitFor(() => manager.getDraft(second.id).state !== 'running');

    const ids = manager.listDrafts().map((d) => d.id);
    expect(ids[0]).toBe(second.id);
    expect(ids[1]).toBe(first.id);
  });

  // The map is capped at 50, dropping the oldest *non-running* drafts once
  // exceeded — a `running` draft is never evicted.
  it('caps listDrafts at 50 by evicting the oldest settled drafts, never a running one', async () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    // 55 quick-settling drafts, awaited one at a time so their createdAt
    // timestamps are strictly increasing (the eviction order key).
    for (let i = 0; i < 55; i++) {
      const started = manager.startDraft(`draft ${i}`);
      await waitFor(() => manager.getDraft(started.id).state !== 'running');
    }
    expect(manager.listDrafts()).toHaveLength(50);

    // A 56th, left running past the cap — must not evict itself or anything else.
    const stillRunning = manager.startDraft('the 56th, left running');
    expect(manager.getDraft(stillRunning.id).state).toBe('running');
    expect(manager.listDrafts().map((d) => d.id)).toContain(stillRunning.id);
  });
});

// Phase 7: PlanManager's own executor-style registry — registerPlanner/
// registeredPlannerNames — is what lets `POST /api/plan` accept a `planner`
// field with the same "unknown name is a 400 naming every valid option"
// contract createRun's `executor` field already has. These tests exercise
// the registry directly, independent of api.ts's HTTP-layer validation.
describe('PlanManager planner registry', () => {
  it('starts with no planners registered', () => {
    const manager = new PlanManager({ store, cache, events, rootDir: root });
    expect(manager.registeredPlannerNames()).toEqual([]);
  });

  it('lists every registered planner name', () => {
    const manager = new PlanManager({ store, cache, events, rootDir: root });
    manager.registerPlanner(
      'claude',
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    manager.registerPlanner(
      'fake',
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(manager.registeredPlannerNames().sort()).toEqual(['claude', 'fake']);
  });

  it('throws OrchestratorClientError for an unregistered planner name', () => {
    const manager = new PlanManager({ store, cache, events, rootDir: root });
    manager.registerPlanner(
      'claude',
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.startPlan('do something', 'fake')).toThrow(
      OrchestratorClientError
    );
  });

  it('runs the named planner, not just whichever was registered first', async () => {
    const claudeProposal: PlanProposal = { tasks: [] };
    const manager = new PlanManager({ store, cache, events, rootDir: root });
    manager.registerPlanner(
      'claude',
      new FakePlanner({ ok: true, proposal: claudeProposal })
    );
    manager.registerPlanner(
      'fake',
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build 5 things', 'fake');
    await waitFor(() => manager.get(started.id).state !== 'running');
    expect(manager.get(started.id).proposal).toEqual(SAMPLE_PROPOSAL);
  });
});
