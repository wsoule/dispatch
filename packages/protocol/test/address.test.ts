import { handleFromEmail, MAX_HANDLE_BYTES } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import {
  isAgentAuthored,
  parseAddress,
  SYSTEM_ADDRESS,
} from '../src/address.js';
import { isDecidingAuthor, MAX_SEGMENT_BYTES } from '../src/constants.js';

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

// core mints the handles people are addressed by; each must pass parseAddress.
describe('handles core mints', () => {
  it('fit the segment cap', () => {
    expect(MAX_HANDLE_BYTES).toBe(MAX_SEGMENT_BYTES);
    const longest = handleFromEmail(`${'a'.repeat(100)}@x.com`, new Set());
    expect(parseAddress(`human:${longest}`).kind).toBe('human');
  });
});
