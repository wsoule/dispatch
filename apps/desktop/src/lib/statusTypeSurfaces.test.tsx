import type { StatusModel, TaskDoc } from '@dispatch-foo/core/browser';
import {
  DEFAULT_STATUS_MODEL,
  defaultTaskFields,
  statusModelOf,
} from '@dispatch-foo/core/browser';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'bun:test';

import { BranchGraph } from '../components/graph/BranchGraph';
import { branchLayout } from './branchLayout';
import type { DagTask } from './dagLayout';
import { setActiveStatusModel } from './statusModel';
import { computeTaskWeights } from './taskWeight';

// A Linear team's workflow mirrored into config: none of these names is a built-in, so a
// surface that reads names (or the default model) gets every one of them wrong.
const LINEAR: StatusModel = statusModelOf({
  statusDefinitions: [
    { name: 'Backlog', type: 'backlog', color: null },
    { name: 'Todo', type: 'unstarted', color: null },
    { name: 'In Progress', type: 'started', color: null },
    { name: 'QA', type: 'started', color: null },
    { name: 'Done', type: 'completed', color: null },
    { name: 'Canceled', type: 'canceled', color: null },
  ],
  statusRoles: {
    ready: 'Todo',
    dispatched: 'In Progress',
    review: 'QA',
    landing: null,
    landed: 'Done',
    dropped: 'Canceled',
  },
});

function dag(id: string, status: string, blockedBy: string[] = []): DagTask {
  return {
    id,
    title: `Task ${id}`,
    status,
    created: '2026-09-01T00:00:00.000Z',
    blockedBy,
  };
}

// done (Done) → qa (QA) → todo (Todo); dropped (Canceled) hangs off done.
const chain: DagTask[] = [
  dag('t-done', 'Done'),
  dag('t-qa', 'QA', ['t-done']),
  dag('t-todo', 'Todo', ['t-qa']),
  dag('t-dropped', 'Canceled', ['t-done']),
];

function dotKinds(container: HTMLElement): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const lines = container.querySelectorAll('[data-slot="branch-line"]');
  const dots = container.querySelectorAll('[data-slot="branch-dot"]');
  lines.forEach((line, i) => {
    out[line.getAttribute('data-task-id') ?? ''] =
      dots[i]?.getAttribute('data-dot') ?? null;
  });
  return out;
}

// Unmount before resetting, so the reset does not redraw a mounted graph outside act.
afterEach(() => {
  cleanup();
  setActiveStatusModel(null);
});

describe('status surfaces under a mirrored Linear workflow', () => {
  it('branchLayout keeps Done and Canceled off the critical path', () => {
    const layout = branchLayout(chain, LINEAR);
    expect(layout.path).toEqual(['t-qa', 't-todo']);
    expect(layout.pathSummary).toEqual({
      remaining: 2,
      total: 3,
      nextId: 't-qa',
    });
    // The default model has never heard of "Done": it reads it as open work to pick up.
    expect(branchLayout(chain, DEFAULT_STATUS_MODEL).pathSummary.nextId).toBe(
      't-done'
    );
  });

  it('BranchGraph draws Done and Canceled finished and QA live', () => {
    const { container } = render(<BranchGraph tasks={chain} model={LINEAR} />);
    expect(dotKinds(container)).toEqual({
      't-done': 'done',
      't-qa': 'live',
      't-todo': 'open',
      't-dropped': 'done',
    });
  });

  it('BranchGraph falls back to the open project’s model', () => {
    setActiveStatusModel(LINEAR);
    const { container } = render(<BranchGraph tasks={chain} />);
    expect(dotKinds(container)['t-qa']).toBe('live');
    expect(dotKinds(container)['t-dropped']).toBe('done');
  });

  it('a graph drawn before the project’s statuses load redraws once they do', () => {
    const { container } = render(<BranchGraph tasks={chain} />);
    const glyph = () =>
      container
        .querySelector('[data-task-id=t-done] [data-status-shape]')
        ?.getAttribute('data-status-shape');
    expect(dotKinds(container)['t-done']).toBe('open');
    const before = glyph();
    act(() => setActiveStatusModel(LINEAR));
    expect(dotKinds(container)['t-done']).toBe('done');
    expect(dotKinds(container)['t-qa']).toBe('live');
    // The status glyph beside the dot redraws too: Done becomes the completed check.
    expect(glyph()).not.toBe(before);
    expect(glyph()).toBe('done');
  });

  it('computeTaskWeights zeroes Done and Canceled and counts QA as waiting', () => {
    const now = new Date('2026-09-24T00:00:00.000Z');
    const task = (
      id: string,
      status: string,
      overrides: Partial<TaskDoc['meta']> = {}
    ): TaskDoc => ({
      meta: {
        id,
        title: id,
        status,
        kind: 'task',
        parent: null,
        milestone: null,
        blockedBy: [],
        labels: [],
        priority: 'none',
        assignee: 'none',
        created: now.toISOString(),
        updated: now.toISOString(),
        external: null,
        selfReview: false,
        writes: [],
        risk: 'routine',
        model: null,
        exercised: false,
        ...defaultTaskFields(),
        ...overrides,
      },
      body: '',
    });
    const weights = computeTaskWeights(
      [
        task('blocker', 'Todo'),
        task('qa', 'QA', { blockedBy: ['blocker'] }),
        task('done', 'Done', { blockedBy: ['blocker'], priority: 'urgent' }),
        task('canceled', 'Canceled', { blockedBy: ['blocker'] }),
      ],
      now,
      LINEAR
    );
    expect(weights.get('blocker')?.unblocksCount).toBe(1);
    expect(weights.get('done')?.score).toBe(0);
    expect(weights.get('canceled')?.score).toBe(0);
  });
});
