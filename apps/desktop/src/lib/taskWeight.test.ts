import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, it } from 'bun:test';

import { computeTaskWeights, describeWeight } from './taskWeight';

const NOW = new Date('2026-08-23T00:00:00.000Z');

function makeTask(
  id: string,
  overrides: Partial<TaskDoc['meta']> = {}
): TaskDoc {
  return {
    meta: {
      id,
      title: `Task ${id}`,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: NOW.toISOString(),
      updated: NOW.toISOString(),
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...overrides,
    },
    body: '',
  };
}

describe('computeTaskWeights', () => {
  it('scores urgency from priority', () => {
    const weights = computeTaskWeights(
      [makeTask('a', { priority: 'urgent' }), makeTask('b')],
      NOW
    );
    expect(weights.get('a')?.factors.urgency).toBe(8);
    expect(weights.get('b')?.factors.urgency).toBe(0);
    expect(weights.get('a')?.score).toBeGreaterThan(
      weights.get('b')?.score ?? Infinity
    );
  });

  it('adds unblocking value per open dependent only', () => {
    const weights = computeTaskWeights(
      [
        makeTask('blocker'),
        makeTask('open1', { blockedBy: ['blocker'] }),
        makeTask('open2', { blockedBy: ['blocker'] }),
        makeTask('done', { blockedBy: ['blocker'], status: 'landed' }),
      ],
      NOW
    );
    const blocker = weights.get('blocker');
    expect(blocker?.unblocksCount).toBe(2);
    expect(blocker?.factors.unblocks).toBe(4);
  });

  it('age saturates at 30 days', () => {
    const old = makeTask('old', {
      created: '2026-01-01T00:00:00.000Z',
    });
    const fresh = makeTask('fresh');
    const weights = computeTaskWeights([old, fresh], NOW);
    expect(weights.get('old')?.factors.age).toBe(3);
    expect(weights.get('fresh')?.factors.age).toBe(0);
  });

  it('terminal tasks score zero and are not counted as waiting dependents', () => {
    const weights = computeTaskWeights(
      [
        makeTask('landed', { status: 'landed', priority: 'urgent' }),
        makeTask('blocker'),
        makeTask('dropped', { status: 'dropped', blockedBy: ['blocker'] }),
      ],
      NOW
    );
    expect(weights.get('landed')?.score).toBe(0);
    expect(weights.get('blocker')?.unblocksCount).toBe(0);
  });

  it('canonicalizes nothing itself — legacy statuses arrive canonical from the store', () => {
    // Guard: a task with an unknown custom status is treated as open, not terminal.
    const weights = computeTaskWeights(
      [makeTask('custom', { status: 'triage', priority: 'high' })],
      NOW
    );
    expect(weights.get('custom')?.score).toBe(5);
  });
});

// Map.get narrowed for the assertions below — throws instead of asserting non-null.
function weightOf(weights: ReturnType<typeof computeTaskWeights>, id: string) {
  const weight = weights.get(id);
  if (weight === undefined) throw new Error(`no weight computed for ${id}`);
  return weight;
}

describe('describeWeight', () => {
  it('names every factor', () => {
    const weights = computeTaskWeights(
      [
        makeTask('blocker', { priority: 'high' }),
        makeTask('dep', { blockedBy: ['blocker'] }),
      ],
      NOW
    );
    const text = describeWeight(weightOf(weights, 'blocker'));
    expect(text).toContain('Urgency 5');
    expect(text).toContain('Unblocks 1 task +2');
    expect(text).toContain('Age +0.0');
  });

  it('says so when a task unblocks nothing', () => {
    const weights = computeTaskWeights([makeTask('a')], NOW);
    expect(describeWeight(weightOf(weights, 'a'))).toContain(
      'Unblocks nothing'
    );
  });
});
