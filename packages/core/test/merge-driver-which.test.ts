import { afterEach, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { whichOnPath } from '../src/mergeDriverSetup.js';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('finds an executable on PATH without Bun.which, and nothing else', () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'which-')));
  writeFileSync(join(dir, 'dispatch-merge'), '#!/bin/sh\n');
  chmodSync(join(dir, 'dispatch-merge'), 0o755);
  writeFileSync(join(dir, 'not-exec'), 'x');
  expect(whichOnPath('dispatch-merge', { PATH: `/nonexistent:${dir}` })).toBe(
    join(dir, 'dispatch-merge')
  );
  expect(whichOnPath('not-exec', { PATH: dir })).toBeNull();
  expect(whichOnPath('missing', { PATH: dir })).toBeNull();
  expect(whichOnPath(join(dir, 'dispatch-merge'), { PATH: '' })).toBe(
    join(dir, 'dispatch-merge')
  );
});
