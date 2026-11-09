import { describe, expect, it } from 'bun:test';

import type { OverseerMessage } from '../src/api';
import {
  overseerActionInputs,
  overseerCard,
  overseerCardIds,
  overseerCardWaves,
} from '../src/overseerCards';

const PLAN = {
  milestone: { title: 'Ship search', description: 'End to end.' },
  tasks: [
    { title: 'Schema', priority: 'high' },
    { title: 'Indexer', blockedBy: ['#1'] },
    { title: 'API', blockedBy: ['#1'] },
    { title: 'UI', blockedBy: ['#2', '#3', 't-old'], description: 'The box.' },
  ],
};

describe('overseerCard', () => {
  it('previews a plan with its milestone, priorities and dependency waves', () => {
    const card = overseerCard('create_plan', PLAN);
    expect(card?.milestone).toEqual({
      title: 'Ship search',
      description: 'End to end.',
    });
    expect(card?.sends).toBe(true);
    expect(card?.rows.map((r) => [r.title, r.wave])).toEqual([
      ['Schema', 1],
      ['Indexer', 2],
      ['API', 2],
      ['UI', 3],
    ]);
    expect(card?.rows[0].priority).toBe('high');
    expect(card?.rows[3].description).toBe('The box.');
    expect(card === null ? 0 : overseerCardWaves(card)).toBe(3);
    // Nothing exists yet, so there is nothing to look up.
    expect(card === null ? [] : overseerCardIds(card)).toEqual([]);
  });

  it('pins the real ids onto an applied plan, blockers included', () => {
    const card = overseerCard('create_plan', PLAN, [
      'm-1',
      't-1',
      't-2',
      't-3',
      't-4',
    ]);
    expect(card?.milestone?.id).toBe('m-1');
    expect(card?.rows.map((r) => r.id)).toEqual(['t-1', 't-2', 't-3', 't-4']);
    expect(card?.rows[3].blockedBy).toEqual(['t-2', 't-3', 't-old']);
    expect(card === null ? [] : overseerCardIds(card)).toEqual([
      'm-1',
      't-1',
      't-2',
      't-3',
      't-4',
    ]);
  });

  it('leaves ids off when the applied count does not match the rows', () => {
    const card = overseerCard('create_plan', PLAN, ['t-1']);
    expect(card?.rows.every((r) => r.id === undefined)).toBe(true);
    expect(card?.rows[1].blockedBy).toEqual(['#1']);
  });

  it('reads a plan into an existing milestone, which starts nothing', () => {
    const card = overseerCard('create_plan', {
      parent: 'm-9',
      send: true,
      tasks: [{ title: 'One' }],
    });
    expect(card?.parent).toBe('m-9');
    expect(card?.milestone).toBeUndefined();
    expect(card?.sends).toBe(false);
  });

  it('reads one created task, with its id once applied', () => {
    const input = {
      title: 'Fix login',
      parent: 'm-2',
      priority: 'urgent',
      blockedBy: ['t-7'],
    };
    const proposed = overseerCard('create_task', input);
    expect(proposed?.parent).toBe('m-2');
    expect(proposed?.rows).toEqual([
      {
        title: 'Fix login',
        priority: 'urgent',
        blockedBy: ['t-7'],
        wave: 1,
      },
    ]);
    expect(overseerCard('create_task', input, ['t-8'])?.rows[0].id).toBe('t-8');
  });

  it("lists an update's changes against the task it names", () => {
    const card = overseerCard('update_task', {
      taskId: 't-3',
      status: 'review',
      priority: 'low',
      blockedBy: [],
    });
    expect(card?.rows[0].id).toBe('t-3');
    expect(card?.changes).toEqual([
      { field: 'status', to: 'review' },
      { field: 'priority', to: 'low' },
      { field: 'blockers', to: 'none' },
    ]);
  });

  it('names the dispatched task', () => {
    expect(overseerCard('dispatch_task', { taskId: 't-5' })?.rows[0].id).toBe(
      't-5'
    );
  });

  it('is null for other tools and for shapes it cannot read', () => {
    expect(overseerCard('cancel_run', { runId: 'r-1' })).toBeNull();
    expect(overseerCard('create_plan', { tasks: 'nope' })).toBeNull();
    expect(overseerCard('update_task', {})).toBeNull();
    expect(overseerCard('create_task', null)).toBeNull();
  });
});

describe('overseerActionInputs', () => {
  it("keeps each action's queued input, ignoring rows without one", () => {
    const messages: OverseerMessage[] = [
      {
        role: 'action',
        actionId: 'a-1',
        outcome: 'pending',
        text: 'Create task',
        at: '2026-01-01T00:00:00Z',
        input: { title: 'X' },
      },
      {
        role: 'action',
        actionId: 'a-1',
        outcome: 'applied',
        text: 'Applied',
        at: '2026-01-01T00:00:01Z',
      },
      { role: 'user', text: 'hi', at: '2026-01-01T00:00:02Z' },
    ];
    expect([...overseerActionInputs(messages)]).toEqual([
      ['a-1', { title: 'X' }],
    ]);
  });
});
