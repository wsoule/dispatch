import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScopeRequestRegistry } from '../src/orchestrator/scopeRequests.js';

// The restart half of the registry: what a second process reads back from the
// file the first one wrote, how a resume moves a request onto its successor,
// and how boot withdraws what nobody can act on any more.
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-scope-persist-'));
  path = join(dir, 'runs', 'scope-requests.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ScopeRequestRegistry persistence', () => {
  it('reloads an undecided request in a fresh registry, exactly as it was', () => {
    const first = new ScopeRequestRegistry({ path });
    const asked = first.request('r-1', ['a.ts', 'b.ts'], 'needs both');

    const second = new ScopeRequestRegistry({ path });
    expect(second.listOpen()).toEqual([asked]);
    expect(second.get(asked.id)?.runId).toBe('r-1');
  });

  it('reloads a decided request too, so a ruling made before the restart is not lost', () => {
    const first = new ScopeRequestRegistry({ path });
    const asked = first.request('r-1', ['a.ts'], 'needs it');
    first.decide(asked.id, true, 'go ahead', 'app');

    const second = new ScopeRequestRegistry({ path });
    expect(second.listOpen()).toEqual([]);
    const reloaded = second.get(asked.id);
    expect(reloaded?.granted).toBe(true);
    expect(reloaded?.decisionReason).toBe('go ahead');
    expect(reloaded?.decidedBy).toBe('app');
  });

  it('forgets a withdrawn request on disk as well as in memory', () => {
    const first = new ScopeRequestRegistry({ path });
    const asked = first.request('r-1', ['a.ts'], 'needs it');
    const kept = first.request('r-2', ['b.ts'], 'needs it too');
    first.closeRun('r-1');

    const second = new ScopeRequestRegistry({ path });
    expect(second.get(asked.id)).toBeUndefined();
    expect(second.listOpen()).toEqual([kept]);
  });

  it('is memory-only when no path is given', () => {
    const registry = new ScopeRequestRegistry();
    registry.request('r-1', ['a.ts'], 'needs it');
    expect(() => readFileSync(path)).toThrow();
  });

  it('starts empty on a corrupt file rather than failing boot', () => {
    writeFileSync(join(dir, 'scope-requests.json'), '{not json');
    const registry = new ScopeRequestRegistry({
      path: join(dir, 'scope-requests.json'),
    });
    expect(registry.listOpen()).toEqual([]);
    // And still works from there: the next write replaces the bad file.
    const asked = registry.request('r-1', ['a.ts'], 'needs it');
    expect(
      new ScopeRequestRegistry({
        path: join(dir, 'scope-requests.json'),
      }).listOpen()
    ).toEqual([asked]);
  });

  it('skips a malformed record without dropping the well-formed ones beside it', () => {
    const good = {
      id: 'sr-aaaaaa',
      runId: 'r-1',
      paths: ['a.ts'],
      reason: 'needs it',
      requestedAt: '2026-08-23T00:00:00.000Z',
      granted: null,
      decisionReason: null,
      decidedAt: null,
      decidedBy: null,
    };
    writeFileSync(
      join(dir, 'scope-requests.json'),
      JSON.stringify({
        requests: [
          { id: 'sr-nopath', runId: 'r-1', reason: 'x', requestedAt: 'y' },
          { ...good, id: 'sr-badgrant', granted: 'yes' },
          'not even an object',
          good,
        ],
      })
    );
    const registry = new ScopeRequestRegistry({
      path: join(dir, 'scope-requests.json'),
    });
    expect(registry.listOpen()).toEqual([good]);
    expect(registry.get('sr-badgrant')).toBeUndefined();
  });
});

describe('ScopeRequestRegistry.carry', () => {
  it('moves every request of the dead run onto its successor, open and decided alike', () => {
    const registry = new ScopeRequestRegistry({ path });
    const open = registry.request('r-old', ['a.ts'], 'needs it');
    const decided = registry.request('r-old', ['b.ts'], 'needs that');
    registry.decide(decided.id, false, 'no');
    const unrelated = registry.request('r-other', ['c.ts'], 'elsewhere');

    const carried = registry.carry('r-old', 'r-new');
    expect(carried.map((r) => r.id).sort()).toEqual(
      [open.id, decided.id].sort()
    );
    expect(registry.get(open.id)?.runId).toBe('r-new');
    expect(registry.get(decided.id)?.runId).toBe('r-new');
    expect(registry.get(unrelated.id)?.runId).toBe('r-other');
    expect(registry.listOpen('r-old')).toEqual([]);
    expect(registry.listOpen('r-new')).toEqual([open]);
    // The move is durable: the next process sees the new owner.
    expect(new ScopeRequestRegistry({ path }).get(open.id)?.runId).toBe(
      'r-new'
    );
  });

  it('keeps a parked waiter alive across the move and resolves it with the decision', async () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-old', ['a.ts'], 'needs it');
    const waiting = registry.waitForDecision(asked.id, 5000);

    registry.carry('r-old', 'r-new');
    registry.decide(asked.id, true);

    expect((await waiting).granted).toBe(true);
  });

  it('returns nothing and writes nothing when the run held no requests', () => {
    const registry = new ScopeRequestRegistry({ path });
    expect(registry.carry('r-none', 'r-new')).toEqual([]);
    expect(() => readFileSync(path)).toThrow();
  });
});

describe('ScopeRequestRegistry.reconcile', () => {
  it('withdraws the requests of runs the verdict rejects and keeps the rest', () => {
    const registry = new ScopeRequestRegistry({ path });
    const kept = registry.request('r-live', ['a.ts'], 'needs it');
    const gone = registry.request('r-dead', ['b.ts'], 'needs that');
    const alsoGone = registry.request('r-dead', ['c.ts'], 'and this');

    const withdrawn = registry.reconcile((runId) => runId === 'r-live');

    expect(withdrawn.sort()).toEqual([gone.id, alsoGone.id].sort());
    expect(registry.listOpen()).toEqual([kept]);
    expect(new ScopeRequestRegistry({ path }).listOpen()).toEqual([kept]);
  });

  it('asks the verdict once per run, not once per request', () => {
    const registry = new ScopeRequestRegistry();
    registry.request('r-1', ['a.ts'], 'one');
    registry.request('r-1', ['b.ts'], 'two');
    registry.request('r-2', ['c.ts'], 'three');

    const asked: string[] = [];
    registry.reconcile((runId) => {
      asked.push(runId);
      return true;
    });
    expect(asked.sort()).toEqual(['r-1', 'r-2']);
  });

  it('wakes a waiter parked on a withdrawn request with the undecided record', async () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-dead', ['a.ts'], 'needs it');
    const waiting = registry.waitForDecision(asked.id, 5000);

    registry.reconcile(() => false);

    expect((await waiting).granted).toBeNull();
    expect(registry.get(asked.id)).toBeUndefined();
  });
});

describe('ScopeRequestRegistry.findOpen', () => {
  it('matches the same path set in any order, on the same run only', () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-1', ['b.ts', 'a.ts'], 'needs both');

    expect(registry.findOpen('r-1', ['a.ts', 'b.ts'])).toEqual(asked);
    expect(registry.findOpen('r-1', ['a.ts'])).toBeNull();
    expect(registry.findOpen('r-2', ['a.ts', 'b.ts'])).toBeNull();
  });

  it('ignores a decided request for the same paths', () => {
    const registry = new ScopeRequestRegistry();
    const asked = registry.request('r-1', ['a.ts'], 'needs it');
    registry.decide(asked.id, true);

    expect(registry.findOpen('r-1', ['a.ts'])).toBeNull();
  });
});
