import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { ACTORS, DEMO, runKey } from '../src/paths.js';

test('runKey is the first 12 hex of sha256 of the absolute root', () => {
  const root = '/tmp/example-root';
  const want = createHash('sha256').update(root).digest('hex').slice(0, 12);
  expect(runKey(root)).toBe(want);
});

test('runKey distinguishes the two clones', () => {
  expect(runKey(DEMO.root)).not.toBe(runKey(DEMO.teammateRoot));
});

test('every demo path is absolute and under .agents/ignore', () => {
  for (const p of [
    DEMO.root,
    DEMO.home,
    DEMO.teammateRoot,
    DEMO.teammateHome,
  ]) {
    expect(p.startsWith('/')).toBe(true);
    expect(p).toContain('/.agents/ignore/');
  }
});

test('actors are unique by handle and email', () => {
  expect(new Set(ACTORS.map((a) => a.handle)).size).toBe(ACTORS.length);
  expect(new Set(ACTORS.map((a) => a.email)).size).toBe(ACTORS.length);
  expect(ACTORS.length).toBe(3);
});
