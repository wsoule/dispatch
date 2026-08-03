import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCarto, openCartoReader } from '../src/carto.js';

// Writes an executable stub named `carto` that prints `version` for --version.
function writeFakeCarto(binDir: string, version: string): void {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'carto');
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(file, 0o755);
}

// Installs a `loadAnci()` that always throws `sentinel` at
// packages/core/node_modules/carto-md/src/anci/consumer.js — nearer on the
// require search path than any real carto-md install, so it wins
// deterministically whether or not carto-md happens to be installed
// elsewhere on the machine running the test. Returns a cleanup function.
function installFakeCartoConsumer(sentinel: string): () => void {
  const packageDir = join(
    import.meta.dirname,
    '..',
    'node_modules',
    'carto-md'
  );
  const consumerDir = join(packageDir, 'src', 'anci');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, 'consumer.js'),
    `exports.loadAnci = function loadAnci() { throw new Error(${JSON.stringify(sentinel)}); };\n`
  );
  return () => rmSync(packageDir, { recursive: true, force: true });
}

describe('discoverCarto', () => {
  it('finds carto on PATH and reports its version', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, '2.1.3');
      const result = discoverCarto({ PATH: binDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.binary.path).toBe(join(binDir, 'carto'));
        expect(result.binary.version).toBe('2.1.3');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not-found rather than throwing when carto is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const result = discoverCarto({ PATH: join(root, 'empty') }, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a version below the 2.x floor', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, '1.9.0');
      const result = discoverCarto({ PATH: binDir }, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported-version');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('openCartoReader', () => {
  it('reports no-container when .carto is absent, rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const result = openCartoReader(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('no-container');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports load-failed when .carto exists but is unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    const sentinel = 'SENTINEL: fake loadAnci threw';
    const uninstall = installFakeCartoConsumer(sentinel);
    try {
      mkdirSync(join(root, '.carto'), { recursive: true });
      writeFileSync(join(root, '.carto', 'carto.db'), 'not a database');
      const result = openCartoReader(root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('load-failed');
        // Pins that the failure is `loadAnci()`'s own throw, mapped through
        // by openCartoReader — not merely require() failing to resolve the
        // specifier, which would produce a different message here. A wrong
        // require specifier, or a loadAnci throw no longer mapped to
        // load-failed, would fail this assertion.
        expect(result.detail).toBe(sentinel);
      }
    } finally {
      uninstall();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
