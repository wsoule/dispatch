import { describe, expect, it } from 'bun:test';

import { isAgentAuthored, SYSTEM_ADDRESS } from '../src/address.js';

// Address parsing is tested by the kit's envelope vectors (vectors.test.ts).
describe('isAgentAuthored', () => {
  it('counts runs and agents but not humans or the system', () => {
    expect(isAgentAuthored('run:r-000001')).toBe(true);
    expect(isAgentAuthored('agent:wyat/claude')).toBe(true);
    expect(isAgentAuthored(SYSTEM_ADDRESS)).toBe(false);
    expect(isAgentAuthored('human:wyat')).toBe(false);
  });
});
