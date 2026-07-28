import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirSizeBytes } from '../../src/orchestrator/dirSize.js';

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-dirsize-'));
  writeFileSync(join(root, 'a.txt'), 'x'.repeat(100));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'b.txt'), 'y'.repeat(250));
  return root;
}

describe('dirSizeBytes', () => {
  it('sums files recursively', () => {
    const result = dirSizeBytes(tree());
    expect(result.bytes).toBeGreaterThanOrEqual(350);
    expect(result.truncated).toBe(false);
  });

  it('returns zero for a directory that does not exist', () => {
    // A worktree removed while the branch listing polls must not throw — the
    // whole page would go down over one stale path.
    expect(dirSizeBytes('/nope/definitely/not/here')).toEqual({
      bytes: 0,
      truncated: false,
    });
  });

  it('does not follow a symlink that points back up the tree', () => {
    const root = tree();
    symlinkSync(root, join(root, 'loop'));
    // Without the symlink guard this recurses until it hits the entry cap, so
    // "finished, untruncated" is the assertion that proves it did not loop.
    const result = dirSizeBytes(root);
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBeGreaterThanOrEqual(350);
  });
});
