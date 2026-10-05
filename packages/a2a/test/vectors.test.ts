import {
  compare,
  loadRegistry,
  loadVectors,
  prepareVector,
} from '@dispatch-foo/protocol-spec';
import { describe, expect, it } from 'bun:test';

import { A2A_HELLO, runA2AVector } from '../src/conformance/adapter.js';

const registry = loadRegistry();
const vectors = loadVectors().vectors.filter((v) => v.class === 'a2a-binding');

describe('a2a-binding vectors', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });
  for (const v of vectors) {
    it(`${v.id} (${v.level})`, async () => {
      const { vector, notApplicable } = prepareVector(v, A2A_HELLO, registry);
      if (notApplicable) return;
      expect(
        compare(vector, await runA2AVector(vector), A2A_HELLO).failures
      ).toEqual([]);
    });
  }
});
