import { parseTaskFile } from '@dispatch/core';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { git } from './git.js';
import { DEMO, TEAMMATE } from './paths.js';

// Rewrites a single top-level `key: value` frontmatter line, leaving every
// other line byte-identical. The task merge driver only resolves a 3-way
// conflict field-by-field when each side's commit touches exactly one field,
// so a whole-file rewrite here would defeat the point of the demo.
function rewriteField(text: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}:.*$`, 'm');
  if (!pattern.test(text)) {
    throw new Error(`no "${key}:" line in task file`);
  }
  return text.replace(pattern, `${key}: ${value}`);
}

/** Rewrites `file`'s `assignee:` line to `human:<handle>`, commits, and pushes from `cwd`. */
export function claimIn(cwd: string, file: string, handle: string): void {
  const path = join(cwd, file);
  const updated = rewriteField(
    readFileSync(path, 'utf8'),
    'assignee',
    `human:${handle}`
  );
  writeFileSync(path, updated);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', `claim ${file} as ${handle}`);
  git(cwd, 'push', '-q', 'origin', 'HEAD');
}

/**
 * Rewrites `file`'s `status:` line to `in-progress`, commits, and pushes from
 * `cwd`. Leaves `assignee:` untouched so a local edit to `assignee:` and this
 * remote edit to `status:` land on different fields, letting the task merge
 * driver resolve the two sides instead of conflicting.
 */
export function conflictIn(cwd: string, file: string): void {
  const path = join(cwd, file);
  const updated = rewriteField(
    readFileSync(path, 'utf8'),
    'status',
    'in-progress'
  );
  writeFileSync(path, updated);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', `move ${file} to in-progress`);
  git(cwd, 'push', '-q', 'origin', 'HEAD');
}

// Task files are named `<id>-<slug>.md` (see board.ts's writeTasks); a caller
// only knows the id, so resolve the actual filename before editing it.
function findTaskFile(cwd: string, taskId: string): string {
  const dir = join(cwd, '.dispatch', 'tasks');
  const file = readdirSync(dir).find((f) => f.startsWith(`${taskId}-`));
  if (file === undefined) {
    throw new Error(`no task file for ${taskId} in ${dir}`);
  }
  return join('.dispatch', 'tasks', file);
}

/** Claims `taskId` for the teammate: rewrites `assignee:`, commits, and pushes from DEMO.teammateRoot. */
export function claim(taskId: string): void {
  const file = findTaskFile(DEMO.teammateRoot, taskId);
  claimIn(DEMO.teammateRoot, file, TEAMMATE.handle);
  console.log(`teammate: claimed ${taskId} as ${TEAMMATE.handle}`);
}

/** Moves `taskId` to in-progress without touching `assignee:`, commits, and pushes from DEMO.teammateRoot. */
export function conflict(taskId: string): void {
  const file = findTaskFile(DEMO.teammateRoot, taskId);
  conflictIn(DEMO.teammateRoot, file);
  console.log(`teammate: moved ${taskId} to in-progress`);
}

// The task the teammate files mid-demo, parented under the checkout epic so
// it shows up alongside the rest of that epic's work on the board.
const NEW_TASK_TITLE = 'Add a loyalty points badge to checkout';
const NEW_TASK_PARENT = 'e-4a19c2';

// Builds a valid task file's contents for `addTask`: the same frontmatter
// shape board.ts's writeTasks uses, so the file reads like the rest of the
// seeded board rather than a stripped-down stub.
function newTaskContents(id: string): string {
  const now = new Date().toISOString();
  return [
    '---',
    `id: ${id}`,
    `title: ${NEW_TASK_TITLE}`,
    'status: todo',
    'kind: task',
    `parent: ${NEW_TASK_PARENT}`,
    'milestone: null',
    'blocked-by: []',
    'labels: []',
    'priority: medium',
    `assignee: human:${TEAMMATE.handle}`,
    `created: ${now}`,
    `updated: ${now}`,
    'external: null',
    '---',
    '',
    '## Description',
    '',
    'Surface a small badge near the order total once a customer crosses a loyalty points threshold.',
    '',
  ].join('\n');
}

/** Writes a new task file into `cwd`'s board, commits, and pushes; returns the new task's id. */
export function addTaskIn(cwd: string): string {
  const id = `t-${randomBytes(3).toString('hex')}`;
  const contents = newTaskContents(id);
  const dir = join(cwd, '.dispatch', 'tasks');
  mkdirSync(dir, { recursive: true });
  const relFile = join(
    '.dispatch',
    'tasks',
    `${id}-add-a-loyalty-points-badge-to-checkout.md`
  );
  const path = join(cwd, relFile);
  // Fails fast if the hand-built frontmatter above ever drifts from what the
  // real parser accepts, instead of committing a task the board would drop.
  parseTaskFile(contents, path);
  writeFileSync(path, contents);

  git(cwd, 'add', relFile);
  git(cwd, 'commit', '-qm', `add task ${id}`);
  git(cwd, 'push', '-q', 'origin', 'HEAD');
  return id;
}

/** Files a new task on DEMO.teammateRoot's board, commits, and pushes; returns the new task's id. */
export function addTask(): string {
  const id = addTaskIn(DEMO.teammateRoot);
  console.log(`teammate: added ${id} (${NEW_TASK_TITLE})`);
  return id;
}
