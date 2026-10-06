import { statusModelOf, TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import { PlanManager } from '../src/orchestrator/plan.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import { statusModelFor } from '../src/statuses.js';

// A project mirroring a Linear workflow: no status is named like a built-in,
// so anything still keyed off a name would miss.
const LINEAR_CONFIG = `statuses:
  - { name: Backlog, type: backlog }
  - { name: Todo, type: unstarted }
  - { name: In Progress, type: started }
  - { name: In Review, type: started }
  - { name: Done, type: completed }
  - { name: Canceled, type: canceled }
statusRoles:
  ready: Todo
  dispatched: In Progress
  review: In Review
  landing: null
  landed: Done
  dropped: Canceled
`;

let root: string;
let store: TaskStore;
let cache: TaskCache;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-roles-'));
  store = TaskStore.init(root);
  writeFileSync(join(root, '.dispatch', 'config.yml'), LINEAR_CONFIG);
  cache = new TaskCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('status roles', () => {
  it('reads the project model, falling back on a broken config', () => {
    expect(statusModelFor(root).roles.review).toBe('In Review');
    writeFileSync(join(root, '.dispatch', 'config.yml'), 'statuses: 3\n');
    expect(statusModelFor(root)).toEqual(statusModelOf(null));
  });

  it('builds the ready queue from unstarted types', () => {
    const todo = store.create({ title: 'a', status: 'Todo' });
    store.create({ title: 'b', status: 'In Progress' });
    const blocked = store.create({
      title: 'c',
      status: 'Todo',
      blockedBy: [todo.meta.id],
    });
    cache.rebuild(store);
    const ready = cache.ready(statusModelFor(root)).map((t) => t.meta.id);
    expect(ready).toEqual([todo.meta.id]);
    // In Review satisfies a dependent's dispatch readiness by role.
    store.update(todo.meta.id, { status: 'In Review' });
    cache.rebuild(store);
    expect(cache.ready(statusModelFor(root))).toEqual([]);
    expect(blocked.meta.status).toBe('Todo');
  });

  it('confirms a plan into the ready role', async () => {
    cache.rebuild(store);
    const manager = new PlanManager({
      store,
      cache,
      events: new EventBus(),
      rootDir: root,
    });
    manager.registerPlanner(
      'claude',
      new FakePlanner({
        ok: true,
        proposal: {
          epic: { title: 'Ship', description: 'd' },
          tasks: [
            {
              title: 'one',
              description: 'x',
              acceptanceCriteria: [],
              blockedByIndices: [],
              priority: 'medium',
            },
          ],
        },
      })
    );
    const started = manager.startPlan('go');
    const deadline = Date.now() + 2000;
    while (manager.get(started.id).state === 'running') {
      if (Date.now() > deadline) throw new Error('plan never settled');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const result = manager.confirm(
      started.id,
      manager.get(started.id).proposal
    );
    expect(store.get(result.epicId!)!.meta.status).toBe('Todo');
    expect(store.get(result.taskIds[0])!.meta.status).toBe('Todo');
  });
});
