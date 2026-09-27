import {
  compare,
  loadRegistry,
  loadVectors,
  prepareVector,
} from '@dispatch/protocol-spec';
import { describe, expect, it } from 'bun:test';

import { REFERENCE_HELLO, runVector } from '../src/conformance/adapter.js';

const registry = loadRegistry();
const { vectors } = loadVectors();

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
        const { vector, notApplicable } = prepareVector(
          v,
          REFERENCE_HELLO,
          registry
        );
        if (notApplicable) return;
        expect(
          compare(vector, await runVector(vector), REFERENCE_HELLO).failures
        ).toEqual([]);
      });
    }
  });
}
