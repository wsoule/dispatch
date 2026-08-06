import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkNoCredentialsStaged,
  checkRunsTerminal,
} from '../src/preflight.js';

test('a non-terminal run is reported, not ignored', () => {
  const home = mkdtempSync(join(tmpdir(), 'demo-pf-'));
  const dir = join(home, '.dispatch/runs', 'deadbeefcafe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'r-bad.jsonl'),
    `${JSON.stringify({ type: 'header', meta: { id: 'r-bad', taskId: 't-1' } })}\n` +
      `${JSON.stringify({ type: 'state', state: 'running' })}\n`
  );
  const check = checkRunsTerminal(join(home, '.dispatch/runs'));
  expect(check.ok).toBe(false);
  expect(check.detail).toContain('r-bad');
});

test('a credentials file staged for commit fails preflight', () => {
  const check = checkNoCredentialsStaged([
    '.dispatch/config.yml',
    'credentials.json',
  ]);
  expect(check.ok).toBe(false);
  expect(check.detail).toContain('credentials.json');
});

test('a clean stage passes', () => {
  expect(checkNoCredentialsStaged(['.dispatch/config.yml']).ok).toBe(true);
});
