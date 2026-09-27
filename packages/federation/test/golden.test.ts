import { canonicalize } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import {
  CHAIN_VECTORS_DIR,
  makeChainVectors,
} from '../scripts/chain-vectors.js';
import type { ChainVector } from '../scripts/chain-vectors.js';
import { verifyLog } from '../src/verify.js';

// The files the relay also runs: each log, verified from an empty cursor,
// must accept exactly the seqs and halt exactly where the file says.

const files = readdirSync(CHAIN_VECTORS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

function read(file: string): string {
  return readFileSync(new URL(file, CHAIN_VECTORS_DIR), 'utf8');
}

describe('chain vectors', () => {
  it('has the committed files', () => {
    expect(files).toEqual(['basic.json', 'fork.json', 'halted-stub.json']);
  });

  for (const file of files) {
    it(`${file} verifies as it expects`, () => {
      const v = JSON.parse(read(file)) as ChainVector;
      const r = verifyLog(
        v.replica,
        v.entries,
        { head: null, halted: null },
        null
      );
      expect({
        accepted: r.accepted.map((a) => a.entry.seq),
        halted: r.cursor.halted,
      }).toEqual(v.expect);
    });
  }

  // Canonical JSON, byte for byte; the formatter owns the files' whitespace.
  it('regenerates every committed file exactly', () => {
    const made = makeChainVectors();
    expect(made.map((v) => `${v.name}.json`).sort()).toEqual(files);
    for (const v of made) {
      const committed = JSON.parse(read(`${v.name}.json`)) as ChainVector;
      expect(canonicalize(committed)).toBe(canonicalize(v));
    }
  });
});
