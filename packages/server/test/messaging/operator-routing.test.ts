import { describe, expect, it } from 'bun:test';

import {
  operatorRouting,
  teamDeciders,
} from '../../src/messaging/operatorRouting.js';
import type { AuthTier } from '../../src/tiers.js';

const OWNER = 'human:wyat';

// Runs by id, each with the operator it acts for.
function routingFor(
  operators: Record<string, string | null>,
  deciders: string[] = [],
  revoked: string[] = []
) {
  return operatorRouting({
    owner: OWNER,
    operatorOf: (runId) => operators[runId],
    canDecide: (ref) => deciders.includes(ref),
    hasAccess: (ref) => !revoked.includes(ref),
  });
}

describe('operatorRouting (XH-R9)', () => {
  it("names a run's operator as its human", () => {
    const routing = routingFor({ r1: 'human:ana' });
    expect(routing.humanFor('r1')).toBe('human:ana');
  });

  it('names the owner for a run acting for no one, an unknown run, or no run', () => {
    const routing = routingFor({ r1: null });
    expect(routing.humanFor('r1')).toBe(OWNER);
    expect(routing.humanFor('gone')).toBe(OWNER);
    expect(routing.humanFor(null)).toBe(OWNER);
  });

  it('names the owner once the operator lost access', () => {
    const routing = routingFor({ r1: 'human:ana' }, [], ['human:ana']);
    expect(routing.humanFor('r1')).toBe(OWNER);
  });

  it('sends a gate to an operator who can decide, with no one else told', () => {
    const routing = routingFor({ r1: 'human:ana' }, ['human:ana']);
    expect(routing.gateFor('r1')).toEqual({ to: 'human:ana', tell: null });
  });

  it('sends a gate to the owner, telling an operator who cannot decide', () => {
    const routing = routingFor({ r1: 'human:ana' });
    expect(routing.gateFor('r1')).toEqual({ to: OWNER, tell: 'human:ana' });
  });

  it("keeps the owner's own run and a run for no one with the owner, telling no one", () => {
    const routing = routingFor({ r1: OWNER, r2: null });
    expect(routing.gateFor('r1')).toEqual({ to: OWNER, tell: null });
    expect(routing.gateFor('r2')).toEqual({ to: OWNER, tell: null });
    expect(routing.gateFor(null)).toEqual({ to: OWNER, tell: null });
  });

  it('tells no one about a revoked operator', () => {
    const routing = routingFor(
      { r1: 'human:ana' },
      ['human:ana'],
      ['human:ana']
    );
    expect(routing.gateFor('r1')).toEqual({ to: OWNER, tell: null });
  });
});

describe('teamDeciders', () => {
  const tiers: Record<string, AuthTier> = { ana: 'decide', bo: 'request' };
  const deciders = teamDeciders({
    issuedTier: (handle) => tiers[handle] ?? null,
    hasAccess: (handle) => handle !== 'cy' && handle in tiers,
  });

  it('lets a teammate at decide tier or above decide', () => {
    expect(deciders.canDecide('human:ana')).toBe(true);
    expect(deciders.canDecide('human:bo')).toBe(false);
    expect(deciders.canDecide('human:nobody')).toBe(false);
    expect(deciders.canDecide('agent:ana/x')).toBe(false);
  });

  it('reads access from the issued tokens', () => {
    expect(deciders.hasAccess('human:bo')).toBe(true);
    expect(deciders.hasAccess('human:cy')).toBe(false);
  });
});
