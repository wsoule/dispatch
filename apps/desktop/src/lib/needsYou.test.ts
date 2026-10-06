import { describe, expect, test } from 'bun:test';

import type { DecisionItem } from './decisionFeed';
import { askGroup, needsYou } from './needsYou';

const ME = 'human:wyat';

function item(
  over: Partial<DecisionItem> & Pick<DecisionItem, 'id' | 'kind'>
): DecisionItem {
  return {
    summary: over.id,
    since: '2026-10-06T09:00:00.000Z',
    ageMs: 0,
    state: 'open',
    disposition: 'blocking',
    ...over,
  };
}

describe('askGroup', () => {
  test.each([
    [{ kind: 'approval', reason: 'tool-approval', runId: 'r-1' }, 'work'],
    [{ kind: 'approval', reason: 'wake' }, 'work'],
    [{ kind: 'scope-request' }, 'work'],
    [{ kind: 'question', runId: 'r-1' }, 'work'],
    [{ kind: 'fix-loop-capped' }, 'work'],
    [{ kind: 'run-stalled', reason: 'orphan-commits' }, 'work'],
    [{ kind: 'doc' }, 'knowledge'],
    [{ kind: 'memory' }, 'knowledge'],
    [{ kind: 'question' }, 'people'],
    [{ kind: 'approval', reason: 'task-proposal' }, 'outside'],
    [
      { kind: 'approval', reason: 'overseer-action', conversation: 'c-1' },
      'agent',
    ],
    [
      { kind: 'approval', reason: 'tool-approval', conversation: 'c-1' },
      'agent',
    ],
    [{ kind: 'approval', reason: 'agent-registration' }, 'admin'],
  ] as const)('%o → %p', (over, group) => {
    expect(askGroup(item({ id: 'x', ...over }))).toBe(group);
  });

  test('a failed run is ✕, not an ask', () => {
    expect(
      askGroup(item({ id: 'x', kind: 'run-stalled', reason: 'failed' }))
    ).toBeNull();
  });
});

describe('needsYou', () => {
  test('counts open blocking items once each, mine and everyone’s', () => {
    const result = needsYou(
      [
        item({ id: 'a', kind: 'question', runId: 'r-1', owner: ME }),
        item({ id: 'b', kind: 'doc' }),
        item({ id: 'c', kind: 'memory', state: 'resolved' }),
        item({ id: 'd', kind: 'memory', disposition: 'recorded' }),
      ],
      ME
    );
    expect(result.count).toBe(2);
    expect(result.asks.map((a) => a.id)).toEqual(['a', 'b']);
  });

  test('another person’s ask goes to Teammates and is not counted', () => {
    const result = needsYou(
      [
        item({
          id: 'a',
          kind: 'approval',
          reason: 'tool-approval',
          runId: 'r-1',
          owner: 'human:priya',
        }),
        item({ id: 'b', kind: 'scope-request', owner: ME }),
      ],
      ME
    );
    expect(result.count).toBe(1);
    expect(result.teammates.map((a) => a.id)).toEqual(['a']);
  });

  test('without a known me, owned items still count (solo daemon)', () => {
    const result = needsYou(
      [item({ id: 'a', kind: 'scope-request', owner: 'human:solo' })],
      null
    );
    expect(result.count).toBe(1);
  });

  test('two items for one gate message count once', () => {
    const result = needsYou(
      [
        item({
          id: 'approval:m-1',
          kind: 'approval',
          reason: 'wake',
          messageId: 'm-1',
        }),
        item({ id: 'question:m-1', kind: 'question', messageId: 'm-1' }),
      ],
      ME
    );
    expect(result.count).toBe(1);
  });

  test('groups come in a fixed order, oldest first inside each, empty ones left out', () => {
    const result = needsYou(
      [
        item({ id: 'admin', kind: 'approval', reason: 'agent-registration' }),
        item({ id: 'k-new', kind: 'doc', since: '2026-10-06T09:05:00.000Z' }),
        item({ id: 'k-old', kind: 'doc', since: '2026-10-06T08:00:00.000Z' }),
        item({ id: 'w', kind: 'scope-request' }),
      ],
      ME
    );
    expect(
      result.groups.map((g) => [g.group, g.items.map((i) => i.id)])
    ).toEqual([
      ['work', ['w']],
      ['knowledge', ['k-old', 'k-new']],
      ['admin', ['admin']],
    ]);
    expect(result.asks.map((a) => a.id)).toEqual([
      'w',
      'k-old',
      'k-new',
      'admin',
    ]);
  });

  test('the count always equals the number of rows', () => {
    const result = needsYou(
      [
        item({ id: 'a', kind: 'doc', taskId: 't-1' }),
        item({ id: 'b', kind: 'question', runId: 'r', taskId: 't-1' }),
        item({ id: 'c', kind: 'run-stalled', reason: 'failed', taskId: 't-2' }),
        item({
          id: 'd',
          kind: 'approval',
          reason: 'overseer-action',
          conversation: 'c',
        }),
      ],
      ME
    );
    const rows = result.groups.reduce((n, g) => n + g.items.length, 0);
    expect(result.count).toBe(rows);
    expect(result.count).toBe(3);
  });

  test('asks per task and the tasks that need you', () => {
    const result = needsYou(
      [
        item({ id: 'a', kind: 'doc', taskId: 't-1' }),
        item({ id: 'b', kind: 'question', runId: 'r', taskId: 't-1' }),
        item({ id: 'c', kind: 'scope-request', taskId: 't-2' }),
        item({ id: 'd', kind: 'approval', reason: 'agent-registration' }),
      ],
      ME
    );
    expect(result.byTask.get('t-1')).toBe(2);
    expect(result.byTask.get('t-2')).toBe(1);
    expect([...result.taskIds].sort()).toEqual(['t-1', 't-2']);
  });
});
