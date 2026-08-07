import { parseTaskFile } from '@dispatch/core';
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { TASKS, writeBoard } from '../src/board.js';
import { ACTORS, DEMO } from '../src/paths.js';
import { skipInstallArtifacts } from '../src/repo.js';

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-board-'));
  writeBoard(root);
  return root;
}

// Recursively lists every file `buildRepo` would actually commit from the
// storefront template — same filter (skipInstallArtifacts) it applies to
// cpSync — so a `writes` glob is checked against the same file set the
// generated repo's blast-radius view resolves against, not the whole
// on-disk template (which may carry install artifacts locally).
function templateFiles(dir: string = DEMO.template): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!skipInstallArtifacts(full)) continue;
    if (statSync(full).isDirectory()) {
      out.push(...templateFiles(full));
    } else {
      out.push(relative(DEMO.template, full).split(sep).join('/'));
    }
  }
  return out;
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

test('the real parser accepts every generated task file and round-trips writes', () => {
  const root = build();
  const dir = join(root, '.dispatch/tasks');
  for (const task of TASKS) {
    const file = readdirSync(dir).find((f) => f.startsWith(task.id))!;
    const path = join(dir, file);
    let doc: ReturnType<typeof parseTaskFile> | undefined;
    expect(() => {
      doc = parseTaskFile(readFileSync(path, 'utf8'), path);
    }).not.toThrow();
    // parseTaskFile defaults a missing `writes` key to [], so this also
    // confirms the frontmatter line round-trips rather than being dropped.
    expect(doc!.meta.writes).toEqual(task.writes);
  }
});

// One task (t-9b2d14) is deliberately left with no declared writes so the
// Impact view's honest "declares no writes" state stays demonstrable — every
// other task must have at least one, or the demo's task-subject beat is dead.
test('exactly one seeded task has no declared writes', () => {
  const bare = TASKS.filter((t) => t.writes.length === 0);
  expect(bare.map((t) => t.id)).toEqual(['t-9b2d14']);
});

// The whole point of declaring writes is a real blast radius on screen — a
// glob that matches nothing reproduces the dead "no writes" beat with extra
// steps. This mirrors the matcher the Impact view itself uses
// (matchesDeclaredWrites in packages/server/src/orchestrator/review.ts):
// Bun.Glob against the repo-relative path.
test('every declared write glob matches at least one file in the storefront template', () => {
  const files = templateFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const task of TASKS) {
    for (const pattern of task.writes) {
      const matched = files.some((file) => new Bun.Glob(pattern).match(file));
      expect(matched).toBe(true);
    }
  }
});
