import type { Address } from '@dispatch/protocol';

import { MemoryError } from './errors.js';
import type {
  MemoryProposal,
  Operator,
  Principal,
  SharedScope,
} from './types.js';

export interface Viewer {
  principal: Principal;
  operator: Operator | null;
  a2aRun: boolean;
}

const A2A_AGENT = /^agent:[^/]+\/a2a\./;

export function isA2AAgent(address: Address): boolean {
  return address.startsWith('a2a:') || A2A_AGENT.test(address);
}

export function refuseA2A(principal: Principal): void {
  if (isA2AAgent(principal.address))
    throw new MemoryError(
      'forbidden',
      'A2A clients have no access to Dispatch memory',
      'principal'
    );
}

// Project scope never leaves the machine, and an A2A run's output may.
export function sharedScopesFor(viewer: Viewer): SharedScope[] {
  return viewer.a2aRun ? ['team'] : ['project', 'team'];
}

export function personalIdentityFor(viewer: Viewer): string | null {
  return viewer.a2aRun ? null : (viewer.operator?.identity ?? null);
}

// Deciders see every proposal; other humans see open ones they or their runs
// wrote and decided ones they wrote; a run or agent sees only its own open ones.
export function proposalVisible(viewer: Viewer, p: MemoryProposal): boolean {
  const { principal } = viewer;
  if (principal.kind === 'human' && principal.canDecide) return true;
  if (principal.kind === 'human') {
    if (p.author === principal.address) return true;
    return p.state === 'open' && p.operator === principal.address;
  }
  return p.state === 'open' && p.author === principal.address;
}
