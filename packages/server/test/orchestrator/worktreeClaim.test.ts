import { describe, expect, it } from 'bun:test';

import { Orchestrator } from '../../src/orchestrator/orchestrator.js';

interface Probe {
  worktreeClaims: ((path: string) => boolean)[];
  registry: { get: (id: string) => unknown; list: () => unknown[] };
  worktreeIsBusy: (id: string) => boolean;
  worktreeIsNeeded: (id: string) => boolean;
  onWorktreeClaim: (claims: (path: string) => boolean) => void;
}

/** A bare Orchestrator with just the two fields these methods touch. */
function probe(): Probe {
  const o = Object.create(Orchestrator.prototype) as Probe;
  o.worktreeClaims = [];
  o.registry = {
    get: () => ({ id: 'r-1', worktreePath: '/wt/a', state: 'finished' }),
    // Every run on this worktree is terminal — nothing is live.
    list: () => [{ id: 'r-1', worktreePath: '/wt/a', state: 'finished' }],
  };
  return o;
}

describe('worktree liveness vs need', () => {
  it('a claim makes the worktree needed without making it busy', () => {
    const o = probe();
    o.onWorktreeClaim((path) => path === '/wt/a');

    // The distinction that matters: restacking asks isBusy and must still be
    // allowed, while deletion asks isNeeded and must be refused.
    expect(o.worktreeIsBusy('r-1')).toBe(false);
    expect(o.worktreeIsNeeded('r-1')).toBe(true);
  });

  it('is not needed when nothing is live and nothing claims it', () => {
    const o = probe();
    expect(o.worktreeIsNeeded('r-1')).toBe(false);
  });

  it('a claim on another directory does not protect this one', () => {
    const o = probe();
    o.onWorktreeClaim((path) => path === '/wt/elsewhere');
    expect(o.worktreeIsNeeded('r-1')).toBe(false);
  });
});
