import { describe, expect, it } from 'bun:test';

import type { PlanProposal } from '../src/api';
import { reduceProposal } from '../src/proposalReducer';

// Three tasks with a chain of dependencies: Design (0) <- Implement (1) <-
// Ship (2), each depending on the one before it — enough to exercise every
// index-shift case removeTask has to get right (a dependency on the removed
// task itself, and a dependency on something *after* it that needs
// renumbering).
function chainProposal(): PlanProposal {
  return {
    epic: { title: 'Ship the widget', description: 'Build it end to end.' },
    tasks: [
      {
        title: 'Design',
        description: 'Sketch it.',
        acceptanceCriteria: ['Sketch reviewed'],
        blockedByIndices: [],
        priority: 'medium',
      },
      {
        title: 'Implement',
        description: 'Build it.',
        acceptanceCriteria: ['Tests pass'],
        blockedByIndices: [0],
        priority: 'medium',
      },
      {
        title: 'Ship',
        description: 'Release it.',
        acceptanceCriteria: ['Released'],
        blockedByIndices: [1],
        priority: 'medium',
      },
    ],
  };
}

describe('reduceProposal', () => {
  it('edits the epic title', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'setEpicTitle',
      title: 'Ship the widget v2',
    });
    expect(next.epic?.title).toBe('Ship the widget v2');
    expect(next.epic?.description).toBe('Build it end to end.');
  });

  it('edits the epic description', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'setEpicDescription',
      description: 'Updated plan.',
    });
    expect(next.epic?.description).toBe('Updated plan.');
  });

  it('is a no-op editing the epic when the proposal has none', () => {
    const proposal: PlanProposal = { tasks: [] };
    const next = reduceProposal(proposal, {
      type: 'setEpicTitle',
      title: 'nope',
    });
    expect(next).toEqual(proposal);
  });

  it('edits one task title without touching the others', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'setTaskTitle',
      index: 1,
      title: 'Build it (v2)',
    });
    expect(next.tasks[1].title).toBe('Build it (v2)');
    expect(next.tasks[0].title).toBe('Design');
    expect(next.tasks[2].title).toBe('Ship');
  });

  it('edits one task description', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'setTaskDescription',
      index: 0,
      description: 'Sketch it carefully.',
    });
    expect(next.tasks[0].description).toBe('Sketch it carefully.');
  });

  it('edits one task priority', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'setTaskPriority',
      index: 2,
      priority: 'urgent',
    });
    expect(next.tasks[2].priority).toBe('urgent');
    expect(next.tasks[0].priority).toBe('medium');
  });

  it('never mutates the input proposal', () => {
    const original = chainProposal();
    const snapshot = JSON.parse(JSON.stringify(original));
    reduceProposal(original, { type: 'setTaskTitle', index: 0, title: 'x' });
    expect(original).toEqual(snapshot);
  });

  it('removes a middle task and renumbers later blockedByIndices down', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'removeTask',
      index: 1, // remove "Implement"
    });
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[0].title).toBe('Design');
    expect(next.tasks[1].title).toBe('Ship');
    // "Ship" depended on "Implement" (index 1), which no longer exists —
    // that dependency is simply dropped, not remapped to something else.
    expect(next.tasks[1].blockedByIndices).toEqual([]);
  });

  it('removes the first task and shifts every remaining index down by one', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'removeTask',
      index: 0, // remove "Design"
    });
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[0].title).toBe('Implement');
    // "Implement" depended on "Design" (index 0, now gone) -> dropped.
    expect(next.tasks[0].blockedByIndices).toEqual([]);
    expect(next.tasks[1].title).toBe('Ship');
    // "Ship" depended on "Implement" at index 1; "Implement" is now at
    // index 0, so the dependency must follow it there.
    expect(next.tasks[1].blockedByIndices).toEqual([0]);
  });

  it('removes the last task, leaving earlier indices untouched', () => {
    const next = reduceProposal(chainProposal(), {
      type: 'removeTask',
      index: 2, // remove "Ship"
    });
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[0].blockedByIndices).toEqual([]);
    expect(next.tasks[1].blockedByIndices).toEqual([0]);
  });

  it('drops a dependency on itself-adjacent duplicates only once per removal', () => {
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
          blockedByIndices: [0],
          priority: 'none',
        },
        {
          title: 'C',
          description: '',
          acceptanceCriteria: [],
          // Depends on both A (removed) and B (shifts from 1 -> 0).
          blockedByIndices: [0, 1],
          priority: 'none',
        },
      ],
    };
    const next = reduceProposal(proposal, { type: 'removeTask', index: 0 });
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[0].title).toBe('B');
    expect(next.tasks[0].blockedByIndices).toEqual([]);
    expect(next.tasks[1].title).toBe('C');
    expect(next.tasks[1].blockedByIndices).toEqual([0]);
  });
});
