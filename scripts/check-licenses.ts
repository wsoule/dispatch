#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fails the process unless every workspace package declares the license the
 * hybrid open-core decision assigns it (`LICENSING.md`, commit 90c7db07). A
 * package passes when its package.json "license" field equals its mapped
 * value AND, for anything other than UNLICENSED, a sibling LICENSE or
 * LICENSE.md file carries the matching license text. An undiscovered package
 * or one missing from the map below fails loudly, so a newly added package
 * must declare intent instead of inheriting a default.
 */

// Expected license per workspace package; the CI guard for the hybrid
// open-core decision (2026-08-23). UNLICENSED packages need no LICENSE file.
const EXPECTED: Record<string, string> = {
  '@dispatch/core': 'MIT',
  '@dispatch/client': 'MIT',
  '@dispatch/cli': 'MIT',
  '@dispatch/mcp': 'MIT',
  '@dispatch/protocol': 'MIT',
  '@dispatch/memory': 'MIT',
  // The daemon is FSL, except its team features (see LICENSED_DIRS).
  '@dispatch/server': 'FSL-1.1-ALv2 AND Elastic-2.0',
  '@dispatch/tokens': 'FSL-1.1-ALv2',
  '@dispatch/ui': 'FSL-1.1-ALv2',
  '@dispatch/web': 'FSL-1.1-ALv2',
  '@dispatch/demo': 'FSL-1.1-ALv2',
  '@dispatch/sandbox': 'FSL-1.1-ALv2',
  '@dispatch/desktop': 'FSL-1.1-ALv2',
  '@dispatch/site': 'FSL-1.1-ALv2',
};

// Folders inside a package under a license of their own — the GitLab `ee/`
// pattern. Each needs its own LICENSE with that license's text, and its
// package's "license" expression must name it. Team features are Elastic
// License 2.0: free up to three people, a license key beyond (LICENSING.md).
const LICENSED_DIRS: Record<string, string> = {
  'packages/server/src/team': 'Elastic-2.0',
  'packages/server/test/team': 'Elastic-2.0',
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

// Mirrors the workspace globs in pnpm-workspace.yaml (packages/* and apps/*).
const workspaceGroups = ['packages', 'apps'];

// Every directory one level under packages/ or apps/ that contains a
// package.json. The repo root is intentionally excluded: it keeps its own
// "SEE LICENSE IN LICENSE" field and is not part of the per-package map.
function findPackageDirs(): string[] {
  const dirs: string[] = [];
  for (const group of workspaceGroups) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) {
      continue;
    }
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        existsSync(join(groupDir, entry.name, 'package.json'))
      ) {
        dirs.push(join(groupDir, entry.name));
      }
    }
  }
  return dirs;
}

// The parsed package.json for a directory.
function readPackageJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

// True when the text is the body of the MIT License.
function isMitLicense(text: string): boolean {
  return (
    text.includes('MIT License') &&
    text.includes('Permission is hereby granted')
  );
}

// True when the text is the body of the Functional Source License 1.1,
// Apache 2.0 Future License (the flavor the root LICENSE file uses).
function isFslLicense(text: string): boolean {
  return (
    text.includes('Functional Source License') && text.includes('FSL-1.1-ALv2')
  );
}

// True when the text is the Elastic License 2.0, license-key clause and all
// — the clause the seat limit rests on.
function isElasticLicense(text: string): boolean {
  return (
    text.includes('Elastic License 2.0') &&
    text.includes('circumvent the license key functionality')
  );
}

const LICENSE_VALIDATORS: Record<string, (text: string) => boolean> = {
  MIT: isMitLicense,
  'FSL-1.1-ALv2': isFslLicense,
  'Elastic-2.0': isElasticLicense,
};

const problems: string[] = [];

for (const dir of findPackageDirs()) {
  const label = dir.slice(repoRoot.length + 1);
  const pkg = readPackageJson(dir);
  const name = typeof pkg.name === 'string' ? pkg.name : undefined;

  if (name === undefined || !(name in EXPECTED)) {
    problems.push(
      `${label}: package "${name ?? '<unnamed>'}" is not declared in EXPECTED (scripts/check-licenses.ts). Add it with an intended license.`
    );
    continue;
  }

  const expected = EXPECTED[name];
  const license = typeof pkg.license === 'string' ? pkg.license : null;
  if (license !== expected) {
    problems.push(
      `${label}: package.json "license" is ${license ?? 'missing'}, expected "${expected}".`
    );
  }

  if (expected === 'UNLICENSED') {
    continue;
  }

  const licenseFile = ['LICENSE', 'LICENSE.md']
    .map((fileName) => join(dir, fileName))
    .find((path) => existsSync(path));
  if (licenseFile === undefined) {
    problems.push(`${label}: missing a LICENSE or LICENSE.md file.`);
    continue;
  }

  // A compound expression ("A AND B"): the package's own LICENSE carries the
  // first, and LICENSED_DIRS says where the others apply.
  const [packageLicense] = expected.split(' AND ');
  const validate = LICENSE_VALIDATORS[packageLicense];
  if (validate !== undefined && !validate(readFileSync(licenseFile, 'utf8'))) {
    problems.push(
      `${label}: LICENSE file does not match "${packageLicense}" text.`
    );
  }
}

for (const [dirLabel, license] of Object.entries(LICENSED_DIRS)) {
  const dir = join(repoRoot, dirLabel);
  const licenseFile = join(dir, 'LICENSE');
  if (!existsSync(licenseFile)) {
    problems.push(`${dirLabel}: missing its ${license} LICENSE file.`);
    continue;
  }
  const validate = LICENSE_VALIDATORS[license];
  if (validate !== undefined && !validate(readFileSync(licenseFile, 'utf8'))) {
    problems.push(
      `${dirLabel}: LICENSE file does not match "${license}" text.`
    );
  }
  const owner = findPackageDirs().find((pkgDir) =>
    dir.startsWith(`${pkgDir}/`)
  );
  const declared = owner === undefined ? null : readPackageJson(owner).license;
  if (
    typeof declared !== 'string' ||
    !declared.split(' AND ').includes(license)
  ) {
    problems.push(
      `${dirLabel}: its package's "license" must include "${license}" (e.g. "FSL-1.1-ALv2 AND ${license}").`
    );
  }
}

if (problems.length > 0) {
  console.error(
    'License check failed. Every workspace package must match the open-core map:\n'
  );
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    '\nSee LICENSING.md for the map and scripts/check-licenses.ts for the rules.'
  );
  process.exit(1);
}

console.log(
  'License check passed: every workspace package matches the open-core map.'
);
