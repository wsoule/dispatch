import type { TaskDoc } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskAuthorship } from '../../src/orchestrator/taskAuthorship.js';

function doc(title: string, body: string): TaskDoc {
  return { meta: { id: 't-1', title }, body } as TaskDoc;
}

describe('TaskAuthorship', () => {
  it('acts for the creator until someone else rewrites the title or body', () => {
    const a = new TaskAuthorship(null);
    const v1 = doc('T', '## Description\n\nx\n');
    a.created(v1, 'human:owner');
    expect(a.actsFor(v1, 'human:owner')).toBe('human:owner');
    expect(a.actsFor(v1, 'human:ada')).toBeNull();

    const v2 = doc('T', '## Description\n\ny\n');
    a.edited(v1, v2, 'human:ada');
    expect(a.actsFor(v2, 'human:owner')).toBeNull();
    a.edited(v2, v1, 'human:owner');
    expect(a.actsFor(v1, 'human:owner')).toBe('human:owner');
  });

  it('ignores Activity lines but not an untracked body change', () => {
    const a = new TaskAuthorship(null);
    const v1 = doc('T', '## Description\n\nx\n\n## Activity\n\n- one\n');
    a.created(v1, 'human:owner');
    const commented = doc('T', `${v1.body}- two\n`);
    expect(a.actsFor(commented, 'human:owner')).toBe('human:owner');
    const rewritten = doc('T', '## Description\n\nz\n');
    expect(a.actsFor(rewritten, 'human:owner')).toBeNull();
  });

  it('a task created for no one never acts for anyone, and records survive a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-authorship-'));
    try {
      const path = join(dir, 'task-authorship.json');
      const v1 = doc('T', 'b');
      new TaskAuthorship(path).created(v1, 'human:owner');
      expect(new TaskAuthorship(path).actsFor(v1, 'human:owner')).toBe(
        'human:owner'
      );
      const reborn = new TaskAuthorship(path);
      reborn.created(v1, null);
      expect(new TaskAuthorship(path).actsFor(v1, 'human:owner')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
