import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = readFileSync(
  resolve(import.meta.dir, '../../../pnpm-workspace.yaml'),
  'utf8'
);

it('pins @a2a-js/sdk at 1.2.0 in the catalog', () => {
  expect(workspace).toMatch(/^ {2}'@a2a-js\/sdk': '1\.2\.0'$/m);
});

it('never exempts the SDK from the release-age gate', () => {
  const exclude = workspace
    .split('minimumReleaseAgeExclude:')[1]
    .split(/\n[A-Za-z]/)[0];
  expect(exclude).not.toContain('@a2a-js');
});
