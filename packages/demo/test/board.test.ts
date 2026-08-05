import { parseTaskFile } from '@dispatch/core';
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TASKS, writeBoard } from '../src/board.js';
import { ACTORS } from '../src/paths.js';

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-board-'));
  writeBoard(root);
  return root;
}

test('every task lands as a file with matching frontmatter id', () => {
  const root = build();
  const files = readdirSync(join(root, '.dispatch/tasks'));
  expect(files.length).toBe(TASKS.length);
  for (const task of TASKS) {
    const file = files.find((f) => f.startsWith(task.id));
    expect(file).toBeDefined();
    const contents = readFileSync(join(root, '.dispatch/tasks', file!), 'utf8');
    expect(contents).toContain(`id: ${task.id}`);
    // Frontmatter carries the actor's wire-format ref (`human:<handle>`), not
    // the bare handle — parseTaskFile below rejects anything else.
    expect(contents).toContain(`assignee: human:${task.assignee}`);
  }
});

test('team.yml lists every actor', () => {
  const team = readFileSync(join(build(), '.dispatch/team.yml'), 'utf8');
  for (const actor of ACTORS) expect(team).toContain(`handle: ${actor.handle}`);
});

test('config sets every new field away from its default', () => {
  const config = readFileSync(join(build(), '.dispatch/config.yml'), 'utf8');
  for (const key of [
    'verifySteps',
    'fixLoop',
    'carto',
    'models',
    'verify',
    'linear',
  ]) {
    expect(config).toContain(`${key}:`);
  }
});

test('gitattributes registers the task and team merge drivers', () => {
  const attrs = readFileSync(join(build(), '.gitattributes'), 'utf8');
  expect(attrs).toContain('merge=dispatch-task');
  expect(attrs).toContain('merge=dispatch-team');
});

test('work is spread across all three actors', () => {
  const assigned = new Set(TASKS.map((t) => t.assignee));
  for (const actor of ACTORS) expect(assigned.has(actor.handle)).toBe(true);
});

test('the real parser accepts every generated task file', () => {
  const root = build();
  const dir = join(root, '.dispatch/tasks');
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    expect(() => parseTaskFile(readFileSync(path, 'utf8'), path)).not.toThrow();
  }
});
