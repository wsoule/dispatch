#!/usr/bin/env bun
// Publish-time guard: the pnpm actually running must be the pnpm this repo
// pins. A publish performed with an unpinned pnpm can resolve `catalog:` and
// `workspace:*` specifiers differently from CI and ship a package whose
// dependency ranges nobody reviewed.
//
// The repo declares its pnpm twice, for two different consumers: `.prototools`
// (what proto installs and what the shims resolve) and package.json's
// `packageManager` (what corepack and pnpm's own self-check honour). This
// script asserts all three agree — the two declarations with each other, and
// the running binary with both — so there is no hardcoded fourth copy to
// forget when the version moves.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const protoToolsPath = resolve(repoRoot, '.prototools');
const packageJsonPath = resolve(repoRoot, 'package.json');

function fail(...lines: string[]): never {
  console.error(
    [
      ...lines,
      `Install or activate the pnpm version pinned in ${protoToolsPath} before publishing.`,
    ].join('\n')
  );
  process.exit(1);
}

const protoMatch = /^pnpm\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m.exec(
  readFileSync(protoToolsPath, 'utf8')
);
if (protoMatch === null) {
  fail(`Could not find a pinned pnpm version in ${protoToolsPath}.`);
}
const pinnedVersion = protoMatch[1];

const packageManager = (
  JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    packageManager?: unknown;
  }
).packageManager;
if (typeof packageManager !== 'string') {
  fail(`${packageJsonPath} has no "packageManager" field.`);
}
// `packageManager` is "<name>@<version>", optionally with a "+<hash>" suffix.
const packageManagerMatch = /^pnpm@([^+\s]+)/.exec(packageManager);
if (packageManagerMatch === null) {
  fail(
    `${packageJsonPath}'s "packageManager" is ${JSON.stringify(packageManager)}, expected a "pnpm@<version>" value.`
  );
}
const declaredVersion = packageManagerMatch[1];

if (declaredVersion !== pinnedVersion) {
  fail(
    `.prototools pins pnpm ${pinnedVersion} but package.json's "packageManager" says ${declaredVersion}.`,
    'These two must move together; bump both in the same commit.'
  );
}

const result = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
if (result.error != null) {
  fail(`Could not run pnpm --version: ${result.error.message}.`);
}
if (result.status !== 0) {
  fail(
    `pnpm --version exited with status ${result.status ?? 'unknown'}.`,
    result.stderr.trim()
  );
}

const actualVersion = result.stdout.trim();
if (actualVersion !== pinnedVersion) {
  fail(
    `Expected pnpm ${pinnedVersion}, but this command is running pnpm ${actualVersion || '(empty version output)'}.`
  );
}

console.log(`pnpm ${actualVersion} matches the pin in .prototools.`);
