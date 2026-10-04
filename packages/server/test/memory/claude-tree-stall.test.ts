import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readMemoryTree } from '../../src/memory/claudeExport.js';

// A run controls its Claude memory dir: crafted YAML must not stall the daemon.

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

it('reads a directory of pathological frontmatter files quickly', () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-stall-'));
  const text = `---\ndescription: ${'[a'.repeat(30_000)}\n---\nbody\n`;
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, `note-${i}.md`), text);
  const started = performance.now();
  const scan = readMemoryTree(dir);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(scan.files).toHaveLength(40);
  expect(scan.files[0].parsed.title).toBe('body');
});
