import { MEMORY_GATE_KINDS } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';

import { MEMORY_KINDS } from '../src/types.js';

describe('memory kinds', () => {
  it('match the kinds a memory gate may carry', () => {
    expect([...MEMORY_KINDS]).toEqual([...MEMORY_GATE_KINDS]);
  });
});
