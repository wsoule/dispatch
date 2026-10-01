import { afterAll, beforeAll, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { fileFor } from '../serverPaths';

let root = '';
beforeAll(() => {
  root = `${realpathSync(mkdtempSync(join(tmpdir(), 'site-')))}${sep}`;
  mkdirSync(join(root, 'a2a/ext/envelope/v1'), { recursive: true });
  writeFileSync(join(root, 'a2a/ext/envelope/v1/index.html'), 'ok');
  writeFileSync(join(root, 'robots.txt'), 'ok');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('serves a file, and a directory through its index.html', async () => {
  expect(await fileFor(root, '/robots.txt')).toBe(join(root, 'robots.txt'));
  expect(await fileFor(root, '/a2a/ext/envelope/v1')).toBe(
    join(root, 'a2a/ext/envelope/v1/index.html')
  );
  expect(await fileFor(root, '/a2a/ext/envelope/v1/')).toBe(
    join(root, 'a2a/ext/envelope/v1/index.html')
  );
});

it('keeps the containment check', async () => {
  expect(await fileFor(root, '/file:///etc/hosts')).toBeNull();
  expect(await fileFor(root, '/%2e%2e/%2e%2e/etc/hosts')).toBeNull();
  expect(await fileFor(root, '/nul%00l')).toBeNull();
  expect(await fileFor(root, '/missing')).toBeNull();
});
