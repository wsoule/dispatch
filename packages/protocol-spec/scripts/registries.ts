#!/usr/bin/env bun
// Regenerates spec/11-registries.md from registries/registries.json and runs
// oxfmt on it, so the committed file is exactly what format-check expects.
// With --check, exits 1 when the committed file differs and writes nothing.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadRegistry, renderRegistries } from '../src/registries.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };
const target = fileURLToPath(
  new URL('../spec/11-registries.md', import.meta.url)
);
const scratch = fileURLToPath(
  new URL('../spec/.registries-candidate.md', import.meta.url)
);
const oxfmt = fileURLToPath(
  new URL('../../../node_modules/.bin/oxfmt', import.meta.url)
);

writeFileSync(scratch, renderRegistries(loadRegistry(), pkg.version));
try {
  const fmt = spawnSync(oxfmt, [scratch], { encoding: 'utf8' });
  if (fmt.status !== 0) throw new Error(`oxfmt failed: ${fmt.stderr}`);
  const next = readFileSync(scratch, 'utf8');
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== next) {
      console.error(
        'spec/11-registries.md is stale; run `moonx protocol-spec:registries`'
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(target, next);
  }
} finally {
  rmSync(scratch, { force: true });
}
