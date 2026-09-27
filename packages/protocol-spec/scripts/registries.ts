#!/usr/bin/env bun
// Regenerates spec/11-registries.md from registries.json, formatted by oxfmt
// over stdin; with --check it writes nothing and exits 1 if the file is stale.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadRegistry, renderRegistries } from '../src/registries.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };
const target = fileURLToPath(
  new URL('../spec/11-registries.md', import.meta.url)
);

const fmt = spawnSync(
  'pnpm',
  ['exec', 'oxfmt', '--stdin-filepath=spec/11-registries.md'],
  {
    cwd: pkgDir,
    input: renderRegistries(loadRegistry(), pkg.version),
    encoding: 'utf8',
  }
);
if (fmt.status !== 0)
  throw new Error(`oxfmt failed: ${fmt.error?.message ?? fmt.stderr}`);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== fmt.stdout) {
    console.error(
      'spec/11-registries.md is stale; run `moonx protocol-spec:registries`'
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(target, fmt.stdout);
}
