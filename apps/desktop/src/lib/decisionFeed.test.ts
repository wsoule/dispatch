import { describe, expect, test } from 'bun:test';

import {
  type DecisionItem,
  decisionTarget,
  fetchDecisions,
  isDecisionsChanged,
  pendingDecisionCount,
} from './decisionFeed';

function item(overrides: Partial<DecisionItem>): DecisionItem {
  return {
    id: 'question:q-1',
    kind: 'question',
    summary: 'Which backend should the export use?',
    runId: 'r-1',
    taskId: 't-1',
    taskTitle: 'Export pipeline',
    since: '2026-09-03T10:00:00.000Z',
    ageMs: 60_000,
    state: 'open',
    disposition: 'blocking',
    ...overrides,
  };
}

describe('fetchDecisions', () => {
  test('requests the feed with the resolved tail and the bearer token', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const items = [item({})];
    const fetchFn = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json({ items }));
    }) as unknown as typeof fetch;

    const result = await fetchDecisions(
      'http://127.0.0.1:4600',
      'tok',
      fetchFn
    );

    expect(result).toEqual(items);
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:4600/api/decisions?resolved=1'
    );
    const sentHeaders = calls[0]?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(sentHeaders?.authorization).toBe('Bearer tok');
  });

  test('sends no authorization header without a token, and throws on a non-OK status', async () => {
    let headers: Record<string, string> | undefined;
    const okFn = ((_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await fetchDecisions('http://x', undefined, okFn);
    expect(headers).toEqual({});

    const failFn = (() =>
      Promise.resolve(
        new Response('nope', { status: 500 })
      )) as unknown as typeof fetch;
    expect(fetchDecisions('http://x', 'tok', failFn)).rejects.toThrow('500');
  });
});

describe('isDecisionsChanged', () => {
  test('matches only the feed broadcast', () => {
    expect(isDecisionsChanged({ type: 'decisions.changed' })).toBe(true);
    expect(isDecisionsChanged({ type: 'task.changed' })).toBe(false);
  });
});

describe('pendingDecisionCount', () => {
  test('counts open blocking items only — resolved and recorded stay off the badge', () => {
    expect(
      pendingDecisionCount([
        item({ id: 'a' }),
        item({
          id: 'b',
          state: 'resolved',
          resolvedAt: '2026-09-03T10:05:00.000Z',
        }),
        item({ id: 'c', disposition: 'recorded' }),
        item({ id: 'd', kind: 'approval' }),
      ])
    ).toBe(2);
  });
});

describe('decisionTarget', () => {
  test('gates and prompts open the run chat, pinned to the run', () => {
    for (const kind of ['approval', 'scope-request', 'question'] as const) {
      expect(decisionTarget(item({ kind }))).toEqual({
        kind: 'task',
        taskId: 't-1',
        tab: 'chat',
        runId: 'r-1',
      });
    }
  });

  test('a capped fix loop opens the task details tab, where the ruling happens', () => {
    expect(
      decisionTarget(item({ kind: 'fix-loop-capped', runId: undefined }))
    ).toEqual({ kind: 'task', taskId: 't-1', tab: 'details', runId: null });
  });

  test('a stalled run opens its diff — the stranded work is the object', () => {
    expect(decisionTarget(item({ kind: 'run-stalled' }))).toEqual({
      kind: 'task',
      taskId: 't-1',
      tab: 'diff',
      runId: 'r-1',
    });
  });

  test('falls back to the bare run when the feed could not name a task, and to null with neither', () => {
    expect(decisionTarget(item({ taskId: undefined }))).toEqual({
      kind: 'run',
      runId: 'r-1',
    });
    expect(decisionTarget(item({ taskId: undefined, runId: undefined }))).toBe(
      null
    );
  });
});
