import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newStream, readStream } from '../../../src/team/boardSync/safeFs.js';

// FW-R29(1): a file is read line by line from a resume offset, a line past
// the cap is skipped, and a bloated file never hides the lines in it.
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-stream-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const collect = (file: string, budget: number, state = newStream()) => {
  const lines: string[] = [];
  const read = readStream(file, state, budget, 1024 * 1024, (l) =>
    lines.push(l)
  );
  return { lines, read, state };
};

describe('readStream', () => {
  it('reads the lines after a junk line far over the line cap', () => {
    const file = join(dir, 'prepended.jsonl');
    writeFileSync(file, `${'x'.repeat(3 * 1024 * 1024)}\n{"a":1}\n{"b":2}\n`);
    const { lines } = collect(file, 16 * 1024 * 1024);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reports each skipped line over the cap with its offset and length', () => {
    const file = join(dir, 'skipped.jsonl');
    const big = 'x'.repeat(3 * 1024 * 1024);
    const mid = 'y'.repeat(1024 * 1024 + 10);
    writeFileSync(file, `{"a":1}\n${big}\n{"b":2}\n${mid}\n{"c":3}\n`);
    const skipped: Array<[number, number]> = [];
    const state = newStream();
    // Small budgets, so the 3 MiB line spans passes.
    for (let n = 0; n < 40 && !state.done; n++)
      readStream(
        file,
        state,
        256 * 1024,
        1024 * 1024,
        () => undefined,
        (at, length) => skipped.push([at, length])
      );
    expect(skipped).toEqual([
      [8, big.length],
      [8 + big.length + 1 + 8, mid.length],
    ]);
  });

  it('reads the lines before appended bloat, and resumes over passes within a budget', () => {
    const file = join(dir, 'appended.jsonl');
    writeFileSync(
      file,
      `{"a":1}\n${`${'y'.repeat(1000)}\n`.repeat(6000)}{"z":9}\n`
    );
    const state = newStream();
    const seen: string[] = [];
    for (let pass = 0; pass < 20 && !state.done; pass++) {
      const { lines, read } = collect(file, 1024 * 1024, state);
      expect(read).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
      seen.push(...lines);
    }
    expect(seen[0]).toBe('{"a":1}');
    expect(seen.at(-1)).toBe('{"z":9}');
    expect(state.done).toBe(true);
  });

  it('carries on after an append, and leaves a torn last line for later', () => {
    const file = join(dir, 'grows.jsonl');
    writeFileSync(file, '{"a":1}\n{"b":');
    const state = newStream();
    expect(collect(file, 1024, state).lines).toEqual(['{"a":1}']);
    appendFileSync(file, '2}\n{"c":3}\n');
    expect(collect(file, 1024, state).lines).toEqual(['{"b":2}', '{"c":3}']);
  });
});
