import { parseTaskFile } from '@dispatch/core';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../src/git.js';
import { addTaskIn, claimIn, conflictIn } from '../src/teammate.js';

// Builds a bare remote with one board, plus two clones of it.
function twoClones(): { mine: string; theirs: string } {
  const bare = mkdtempSync(join(tmpdir(), 'demo-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(tmpdir(), 'demo-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'task.md'), 'status: todo\nassignee: none\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  const mine = mkdtempSync(join(tmpdir(), 'demo-mine-'));
  const theirs = mkdtempSync(join(tmpdir(), 'demo-theirs-'));
  git(mine, 'clone', '-q', bare, '.');
  git(theirs, 'clone', '-q', bare, '.');
  return { mine, theirs };
}

test('claim pushes a change the other clone can pull', () => {
  const { mine, theirs } = twoClones();
  claimIn(theirs, 'task.md', 'pmirand');
  git(mine, 'pull', '-q', '--rebase');
  // Written as `human:<handle>` (not a bare handle): parseActorRef in
  // packages/core/src/actor.ts rejects a bare handle, and board.ts writes
  // the same wire format for every seeded task's assignee.
  expect(readFileSync(join(mine, 'task.md'), 'utf8')).toContain(
    'assignee: human:pmirand'
  );
});

test('conflict edits a different field than the local side', () => {
  const { theirs } = twoClones();
  conflictIn(theirs, 'task.md');
  const theirText = readFileSync(join(theirs, 'task.md'), 'utf8');
  expect(theirText).toContain('status: in-progress');
  expect(theirText).toContain('assignee: none');
});

test('conflict leaves the assignee line byte-identical', () => {
  const { theirs } = twoClones();
  const before = readFileSync(join(theirs, 'task.md'), 'utf8');
  const beforeAssignee = before
    .split('\n')
    .find((line) => line.startsWith('assignee:'));
  conflictIn(theirs, 'task.md');
  const after = readFileSync(join(theirs, 'task.md'), 'utf8');
  const afterAssignee = after
    .split('\n')
    .find((line) => line.startsWith('assignee:'));
  expect(afterAssignee).toBe(beforeAssignee);
});

test('claim leaves every other line byte-identical', () => {
  const { theirs } = twoClones();
  const before = readFileSync(join(theirs, 'task.md'), 'utf8');
  const beforeStatus = before
    .split('\n')
    .find((line) => line.startsWith('status:'));
  claimIn(theirs, 'task.md', 'pmirand');
  const after = readFileSync(join(theirs, 'task.md'), 'utf8');
  const afterStatus = after
    .split('\n')
    .find((line) => line.startsWith('status:'));
  expect(afterStatus).toBe(beforeStatus);
});

test('claim pushes onto a real task file with wire-format frontmatter', () => {
  const bare = mkdtempSync(join(tmpdir(), 'demo-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(tmpdir(), 'demo-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  const taskPath = join(seed, 'task.md');
  const contents = [
    '---',
    'id: t-abc123',
    'title: Example task',
    'status: todo',
    'kind: task',
    'parent: null',
    'milestone: null',
    'blocked-by: []',
    'labels: []',
    'priority: medium',
    'assignee: none',
    'created: 2026-07-01T00:00:00.000Z',
    'updated: 2026-07-01T00:00:00.000Z',
    'external: null',
    '---',
    '',
    '## Description',
    '',
    'An example.',
    '',
  ].join('\n');
  writeFileSync(taskPath, contents);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  const theirs = mkdtempSync(join(tmpdir(), 'demo-theirs-'));
  git(theirs, 'clone', '-q', bare, '.');

  claimIn(theirs, 'task.md', 'pmirand');
  const updated = readFileSync(join(theirs, 'task.md'), 'utf8');
  expect(updated).toContain('assignee: human:pmirand');
  // The rewritten file must still parse — claimIn must not corrupt the
  // surrounding frontmatter or body while rewriting one line.
  expect(() => parseTaskFile(updated, taskPath)).not.toThrow();
});

test('addTaskIn writes a task the real parser accepts and pushes it', () => {
  const { mine, theirs } = twoClones();
  const id = addTaskIn(theirs);
  expect(id).toMatch(/^t-[0-9a-f]{6}$/);
  const file = join(
    theirs,
    '.dispatch',
    'tasks',
    `${id}-add-a-loyalty-points-badge-to-checkout.md`
  );
  const contents = readFileSync(file, 'utf8');
  expect(() => parseTaskFile(contents, file)).not.toThrow();
  expect(contents).toContain('assignee: human:pmirand');

  git(mine, 'pull', '-q', '--rebase');
  expect(
    readFileSync(
      join(
        mine,
        '.dispatch',
        'tasks',
        `${id}-add-a-loyalty-points-badge-to-checkout.md`
      ),
      'utf8'
    )
  ).toBe(contents);
});
