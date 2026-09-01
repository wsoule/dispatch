import { git } from '@dispatch/demo/git';
import { seedSession } from '@dispatch/demo/seed';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conflictOn, TIMELINE } from '../src/teammateScript.js';

describe('teammate actions', () => {
  test('timeline actions land on the origin', () => {
    const paths = seedSession(mkdtempSync(join(tmpdir(), 'demo-tm-')));
    for (const action of TIMELINE) action.run(paths);
    const log = git(paths.origin, 'log', '--oneline', 'main');
    expect(log).toContain('claim'); // claim commit message: "claim <file> as <handle>"
    expect(log).toContain('add task'); // addTaskIn's commit message
  });

  test('conflictOn moves the task to working on origin', () => {
    const paths = seedSession(mkdtempSync(join(tmpdir(), 'demo-tm2-')));
    conflictOn(paths, 't-58cc03');
    const show = git(
      paths.origin,
      'show',
      'main:.dispatch/tasks/t-58cc03-rank-exact-sku-matches-above-fuzzy.md'
    );
    expect(show).toContain('status: working');
  });
});
