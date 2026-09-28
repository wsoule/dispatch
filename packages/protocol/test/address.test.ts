import { describe, expect, it } from 'bun:test';

import { isAgentAuthored, SYSTEM_ADDRESS } from '../src/address.js';
import { isDecidingAuthor } from '../src/constants.js';

// Address parsing is tested by the kit's envelope vectors (vectors.test.ts).
describe('isAgentAuthored', () => {
  it('counts runs and agents but not humans or the system', () => {
    expect(isAgentAuthored('run:r-000001')).toBe(true);
    expect(isAgentAuthored('agent:wyat/claude')).toBe(true);
    expect(isAgentAuthored(SYSTEM_ADDRESS)).toBe(false);
    expect(isAgentAuthored('human:wyat')).toBe(false);
  });
});

describe('isDecidingAuthor', () => {
  it('lets a human or the system decide, never a run or another agent', () => {
    expect(isDecidingAuthor('human:wyat')).toBe(true);
    expect(isDecidingAuthor(SYSTEM_ADDRESS)).toBe(true);
    expect(isDecidingAuthor('agent:wyat/claude')).toBe(false);
    expect(isDecidingAuthor('run:r-000001')).toBe(false);
  });
});
