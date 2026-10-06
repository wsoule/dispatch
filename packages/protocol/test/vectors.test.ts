import {
  compare,
  loadRegistry,
  loadVectors,
  prepareVector,
} from '@dispatch-foo/protocol-spec';
import { describe, expect, it } from 'bun:test';

import { REFERENCE_HELLO, runVector } from '../src/conformance/adapter.js';
import { GATE_TYPES } from '../src/constants.js';

const registry = loadRegistry();
const { vectors } = loadVectors();
// The reference implements every registered gate type, so the fail-closed
// vectors run against an engine and a hello that leave the last one out.
const NARROWED = GATE_TYPES.slice(0, -1);
const NARROWED_HELLO = { ...REFERENCE_HELLO, gateTypes: [...NARROWED] };

// Every envelope and host-core vector of both profiles runs here as one Bun
// test, so fixing a test means fixing a vector.
for (const cls of ['envelope', 'host-core'] as const) {
  describe(`${cls} vectors`, () => {
    it('has vectors', () => {
      expect(vectors.filter((v) => v.class === cls).length).toBeGreaterThan(0);
    });
    for (const v of vectors.filter((x) => x.class === cls)) {
      it(`${v.id} (${v.level}, ${v.profile})`, async () => {
        if (
          v.level === 'MAY' &&
          !REFERENCE_HELLO.capabilities.includes(v.capability ?? '')
        )
          return;
        const narrowed = JSON.stringify(v).includes('$unimplementedGateType');
        const hello = narrowed ? NARROWED_HELLO : REFERENCE_HELLO;
        const { vector, notApplicable } = prepareVector(v, hello, registry);
        expect(notApplicable).toBe(false);
        const options = narrowed ? { gateTypes: NARROWED } : {};
        expect(
          compare(vector, await runVector(vector, options), hello).failures
        ).toEqual([]);
      });
    }
  });
}
