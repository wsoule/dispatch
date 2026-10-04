import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { A2ALineage } from '../../src/a2a/lineage.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a2a-lineage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('A2ALineage', () => {
  it('remembers a marked task across a reopen', () => {
    const file = join(dir, 'runs', 'a2a-lineage.log');
    const first = new A2ALineage(file);
    expect(first.has('t-abc123')).toBe(false);
    first.mark('t-abc123');
    first.mark('t-abc123');
    expect(first.has('t-abc123')).toBe(true);
    const reopened = new A2ALineage(file);
    expect(reopened.has('t-abc123')).toBe(true);
    expect(reopened.has('t-other1')).toBe(false);
  });

  it('skips a line that is not a task id', () => {
    const file = join(dir, 'a2a-lineage.log');
    appendFileSync(file, 't-aaa111\n{garbage\nt-bbb222\n');
    const lineage = new A2ALineage(file);
    expect(lineage.has('t-aaa111')).toBe(true);
    expect(lineage.has('t-bbb222')).toBe(true);
    expect(lineage.has('{garbage')).toBe(false);
  });
});
