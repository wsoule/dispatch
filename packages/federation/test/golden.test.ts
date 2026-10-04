import { canonicalize } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import {
  CHAIN_VECTORS_DIR,
  makeChainVectors,
} from '../scripts/chain-vectors.js';
import type { ChainVector } from '../scripts/chain-vectors.js';
import {
  fromVector,
  makeRosterVectors,
  normalize,
  ROSTER_VECTORS_DIR,
} from '../scripts/roster-vectors.js';
import type { RosterVector } from '../scripts/roster-vectors.js';
import { foldRoster } from '../src/roster.js';
import { verifyLog } from '../src/verify.js';

// The files the relay also runs: each log, verified from an empty cursor,
// must accept exactly the seqs and halt exactly where the file says, and each
// roster, folded, must give exactly the view the file says.

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

describe('roster vectors', () => {
  const rosterFiles = readdirSync(ROSTER_VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const readRoster = (file: string) =>
    JSON.parse(
      readFileSync(new URL(file, ROSTER_VECTORS_DIR), 'utf8')
    ) as RosterVector;

  for (const file of rosterFiles) {
    it(`${file} folds as it expects`, () => {
      const v = readRoster(file);
      expect(normalize(foldRoster(fromVector(v.input)))).toEqual(v.expect);
    });
  }

  // The relay folds the roster a daemon pauses on, and never pauses.
  it('folds for the relay what it folds for a daemon, without the pause', () => {
    const daemon = readRoster('unknown-rv.json');
    const relay = readRoster('relay-unknown-rv.json');
    const { unknown, ...rest } = daemon.expect as Record<string, unknown>;
    expect(unknown).not.toBeNull();
    expect(relay.input.ops).toEqual(daemon.input.ops);
    expect(relay.expect).toEqual({ ...rest, unknown: null });
  });

  it('regenerates every committed file exactly', () => {
    const made = makeRosterVectors();
    expect(made.map((v) => `${v.name}.json`).sort()).toEqual(rosterFiles);
    for (const v of made) {
      expect(canonicalize(readRoster(`${v.name}.json`))).toBe(canonicalize(v));
    }
  });
});
