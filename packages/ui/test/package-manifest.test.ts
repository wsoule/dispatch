import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The manifest as Dispatch consumes it: a private workspace package the
// desktop app's Vite compiles from source (no dist), under the product's
// FSL licence, with React only as a peer so the host has one React. Every
// export must point at a real file, and the scripts moon's tasks mirror
// (AGENTS.md "Toolchain": knip keys its entry points off them) must stay.

interface Manifest {
  name: string;
  license?: string;
  private?: boolean;
  exports: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const root = path.join(import.meta.dir, '..');
const manifest = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8')
) as Manifest;

describe('the package manifest', () => {
  test('is @dispatch/ui under FSL-1.1-ALv2, private, with its LICENSE', () => {
    expect(manifest.name).toBe('@dispatch/ui');
    expect(manifest.license).toBe('FSL-1.1-ALv2');
    expect(manifest.private).toBe(true);
    const licence = readFileSync(path.join(root, 'LICENSE'), 'utf8');
    expect(licence).toContain('Functional Source License');
    expect(licence).toContain('FSL-1.1-ALv2');
  });

  test.each(
    Object.entries(manifest.exports).filter(([name]) => name !== './*')
  )('export %s points at a file in src', (_name, target) => {
    expect(target.startsWith('./src/')).toBe(true);
    expect(existsSync(path.join(root, target))).toBe(true);
  });

  test('the wildcard export is the source tree', () => {
    expect(manifest.exports['./*']).toBe('./src/*');
  });

  test('depends on no workspace package, and on React only as a peer', () => {
    const dependencies = Object.entries(manifest.dependencies ?? {});
    expect(
      dependencies.filter(
        ([name, spec]) =>
          name.startsWith('@dispatch') || spec.startsWith('workspace:')
      )
    ).toEqual([]);
    expect(manifest.dependencies?.['react']).toBeUndefined();
    expect(manifest.dependencies?.['react-dom']).toBeUndefined();
    expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
      'react',
      'react-dom',
    ]);
    // The tests render with them, so they are dev dependencies as well.
    expect(manifest.devDependencies?.['react']).toBe('catalog:');
    expect(manifest.devDependencies?.['react-dom']).toBe('catalog:');
  });

  test('every version comes from the catalog', () => {
    for (const group of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, spec] of Object.entries(group ?? {})) {
        expect(spec, name).toBe('catalog:');
      }
    }
  });

  test('keeps the scripts moon mirrors', () => {
    expect(manifest.scripts).toEqual({
      test: 'bun test',
      tsc: 'tsgo --noEmit --pretty',
      'typecheck-host': 'tsc -p tsconfig.host.json --noEmit --pretty',
    });
  });
});
