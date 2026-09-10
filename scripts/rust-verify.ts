#!/usr/bin/env bun
// Runs the desktop app's Rust tests (`cargo test` in apps/desktop/src-tauri),
// but only when the branch being verified actually touched that directory.
//
// The merge queue runs this as a verifySteps entry in the run's worktree after
// the branch has been rebased onto its base. CI runs `cargo test` on every
// push, verify did not, so a Rust change could pass the queue and fail main.
// It is conditional because a cold cargo build of the Tauri app is 5-10
// minutes and Rust changes are rare: paying that on every merge to catch the
// occasional one is the wrong trade, and skipping the check entirely is how
// main went red. The diff is against the merge base with the branch's
// upstream when it has one, else with main — an epic branch's own Rust
// changes show up in that diff too, which only ever means an extra run, never
// a missed one.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rustDir = 'apps/desktop/src-tauri';

// tauri-build's build script errors if a declared bundle resource is missing.
// The sidecars are gitignored build products that cargo test never runs, so
// empty placeholders satisfy it — the same trick ci.yml uses.
const placeholderResources = ['dispatchd', 'dispatch-mcp', 'dispatch-cli'];

function git(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (res.error) {
    console.error(`rust-verify: could not run git: ${res.error.message}`);
    process.exit(1);
  }
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

// The commit the branch grew from: merge-base with the first ref that
// resolves, preferring the branch's own upstream over a bare `main`.
function findBase(): { ref: string; sha: string } {
  for (const ref of ['@{upstream}', 'main', 'origin/main']) {
    const res = git(['merge-base', 'HEAD', ref]);
    if (res.status === 0 && res.stdout !== '') return { ref, sha: res.stdout };
  }
  console.error(
    'rust-verify: no merge base found — HEAD has no upstream and neither main nor origin/main resolves.'
  );
  process.exit(1);
}

const base = findBase();
const diff = git(['diff', '--quiet', base.sha, 'HEAD', '--', rustDir]);
if (diff.status === 0) {
  console.log(
    `rust-verify: ${rustDir} unchanged since ${base.ref} (${base.sha.slice(0, 10)}); skipping cargo test.`
  );
  process.exit(0);
}
if (diff.status !== 1) {
  // `git diff --quiet` is 0 for identical, 1 for different, anything else
  // is an error we must not read as "unchanged".
  console.error(
    `rust-verify: git diff failed (exit ${diff.status}):\n${diff.stderr}`
  );
  process.exit(1);
}

console.log(
  `rust-verify: ${rustDir} changed since ${base.ref} (${base.sha.slice(0, 10)}); running cargo test.`
);
const resourcesDir = resolve(repoRoot, rustDir, 'resources');
mkdirSync(resourcesDir, { recursive: true });
for (const name of placeholderResources) {
  const path = resolve(resourcesDir, name);
  if (!existsSync(path)) closeSync(openSync(path, 'a'));
}
const cargo = spawnSync('cargo', ['test'], {
  cwd: resolve(repoRoot, rustDir),
  stdio: 'inherit',
});
if (cargo.error) {
  console.error(`rust-verify: could not run cargo: ${cargo.error.message}`);
  process.exit(1);
}
process.exit(cargo.status ?? 1);
