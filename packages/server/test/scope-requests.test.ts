import { describe, expect, it } from 'bun:test';

import { ScopeRequestRegistry } from '../src/orchestrator/scopeRequests.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../src/orchestrator/types.js';

describe('ScopeRequestRegistry', () => {
  it('lists a freshly requested scope change as open, with its paths and reason', () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request(
      'r-1',
      ['packages/core/src/browser.ts'],
      'browser.ts never re-exports FooType, which my scoped code needs'
    );

    expect(asked.id).toMatch(/^sr-[0-9a-f]{6}$/);
    expect(asked.granted).toBeNull();
    expect(asked.decidedAt).toBeNull();
    expect(registry.listOpen()).toEqual([asked]);
    expect(registry.get(asked.id)).toEqual(asked);
    expect(asked.paths).toEqual(['packages/core/src/browser.ts']);
  });

  it('resolves a parked waitForDecision with the decision once one is recorded', async () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-1', ['a.ts'], 'needs it');

    const waiting = registry.waitForDecision(asked.id, 5000);
    registry.decide(asked.id, true, 'fine, go ahead');

    const resolved = await waiting;
    expect(resolved.granted).toBe(true);
    expect(resolved.decisionReason).toBe('fine, go ahead');
    expect(resolved.decidedAt).not.toBeNull();
    expect(registry.listOpen()).toEqual([]);
  });

  it('resolves immediately when the request was already decided', async () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-1', ['a.ts'], 'needs it');
    registry.decide(asked.id, false);

    expect((await registry.waitForDecision(asked.id, 5000)).granted).toBe(
      false
    );
  });

  it('rejects a second decision on the same request', () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-1', ['a.ts'], 'needs it');
    registry.decide(asked.id, true);

    expect(() => registry.decide(asked.id, false)).toThrow(
      OrchestratorConflictError
    );
    expect(registry.get(asked.id)?.granted).toBe(true);
  });

  it('rejects deciding or waiting on an unknown id', async () => {
    const registry = new ScopeRequestRegistry();

    expect(() => registry.decide('sr-nope1', true)).toThrow(
      OrchestratorNotFoundError
    );
    await expect(registry.waitForDecision('sr-nope1', 5000)).rejects.toThrow(
      OrchestratorNotFoundError
    );
  });

  it('resolves with the still-undecided record at the timeout — a timeout is not a decision', async () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-1', ['a.ts'], 'needs it');

    const timedOut = await registry.waitForDecision(asked.id, 20);
    expect(timedOut.id).toBe(asked.id);
    expect(timedOut.granted).toBeNull();
    expect(registry.listOpen()).toEqual([asked]);
  });

  it('scopes requests per run', () => {
    const registry = new ScopeRequestRegistry();
    const first = registry.request('r-1', ['a.ts'], 'needs it');
    const second = registry.request('r-2', ['b.ts'], 'needs it too');

    expect(registry.listOpen('r-1')).toEqual([first]);
    expect(registry.listOpen('r-2')).toEqual([second]);
    expect(registry.listOpen()).toHaveLength(2);
    expect(registry.get(second.id)?.runId).toBe('r-2');

    registry.decide(first.id, true);
    expect(registry.listOpen()).toEqual([second]);
  });

  it("drops a run's requests and wakes its waiters when the run closes", async () => {
    const registry = new ScopeRequestRegistry();
    const mine = registry.request('r-1', ['a.ts'], 'needs it');
    const other = registry.request('r-2', ['b.ts'], 'needs it too');

    const waiting = registry.waitForDecision(mine.id, 5000);
    registry.closeRun('r-1');

    expect((await waiting).granted).toBeNull();
    expect(registry.get(mine.id)).toBeUndefined();
    expect(registry.listOpen()).toEqual([other]);
  });
});
