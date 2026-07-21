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
  return new PlanManager({ store, cache, events }, planner);
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
  it('writes the epic first, then tasks with parent + blockedBy wired from indices', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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

  it('writes a flat task list with no epic when the proposal omits one', () => {
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
    const started = manager.startPlan('small thing');
    const result = manager.confirm(started.id, proposal);

    expect(result.epicId).toBeUndefined();
    const task = store.get(result.taskIds[0]);
    expect(task?.meta.parent).toBeNull();
  });

  it('404s confirming an unknown plan id', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    expect(() => manager.confirm('plan-000000', SAMPLE_PROPOSAL)).toThrow(
      OrchestratorNotFoundError
    );
  });

  it('409s a second confirm of the same plan', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
    manager.confirm(started.id, SAMPLE_PROPOSAL);
    expect(() => manager.confirm(started.id, SAMPLE_PROPOSAL)).toThrow(
      OrchestratorConflictError
    );
  });

  it('accepts a client-edited proposal instead of the stored one (confirm body is authoritative)', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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

  it('400s a proposal with a non-array tasks field', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
    expect(() => manager.confirm(started.id, { tasks: 'nope' })).toThrow(
      OrchestratorClientError
    );
  });

  it('400s a proposal with an empty task title', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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

  it('400s a proposal with an invalid priority', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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

  it('400s a proposal with an out-of-range blockedByIndices entry', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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

  it('400s a proposal whose blockedByIndices form a cycle', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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

  it('400s a proposal where a task blocks on itself', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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

  it('ignores a client-supplied status field — tasks and epic are always created todo', () => {
    const manager = makeManager(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = manager.startPlan('build a widget feature');
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
});
