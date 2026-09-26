import { describe, expect, it } from 'bun:test';

import { newProposal } from '../src/records.js';
import {
  isA2AAgent,
  personalIdentityFor,
  proposalVisible,
  sharedScopesFor,
} from '../src/visibility.js';
import type { Viewer } from '../src/visibility.js';

const run: Viewer = {
  principal: { address: 'run:r-1', canDecide: false, kind: 'run' },
  operator: { human: 'human:ada', identity: 'pid-A' },
  a2aRun: false,
};
const decider: Viewer = {
  principal: { address: 'human:wyat', canDecide: true, kind: 'human' },
  operator: { human: 'human:wyat', identity: 'self' },
  a2aRun: false,
};
const ada: Viewer = {
  principal: { address: 'human:ada', canDecide: false, kind: 'human' },
  operator: { human: 'human:ada', identity: 'pid-A' },
  a2aRun: false,
};

describe('visibility', () => {
  it('recognises A2A agents', () => {
    expect(isA2AAgent('agent:wyat/a2a.acme')).toBe(true);
    expect(isA2AAgent('a2a:acme')).toBe(true);
    expect(isA2AAgent('agent:wyat/claude-code.macbook')).toBe(false);
  });

  it('shows A2A-provenance runs team entries only, and no personal store', () => {
    const a2a = { ...run, a2aRun: true };
    expect(sharedScopesFor(a2a)).toEqual(['team']);
    expect(personalIdentityFor(a2a)).toBeNull();
    expect(sharedScopesFor(run)).toEqual(['project', 'team']);
    expect(personalIdentityFor(run)).toBe('pid-A');
  });

  it('follows the proposal rows of Who sees what', () => {
    const p = newProposal(
      {
        action: 'add',
        scope: 'team',
        author: 'run:r-1',
        authorTrust: 'agent',
        operator: 'human:ada',
      },
      'mp-1',
      '2026-09-25T00:00:00.000Z'
    );
    expect(proposalVisible(run, p)).toBe(true);
    expect(
      proposalVisible(
        { ...run, principal: { ...run.principal, address: 'run:r-2' } },
        p
      )
    ).toBe(false);
    expect(proposalVisible(ada, p)).toBe(true);
    expect(proposalVisible(decider, p)).toBe(true);
    const decided = { ...p, state: 'rejected' as const };
    expect(proposalVisible(run, decided)).toBe(false);
    // Decided: a human below the decide tier sees only proposals they wrote.
    expect(proposalVisible(ada, decided)).toBe(false);
    expect(proposalVisible(ada, { ...decided, author: 'human:ada' })).toBe(
      true
    );
    expect(proposalVisible(decider, decided)).toBe(true);
  });
});
