import { parse } from 'acorn';
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DESKTOP_DIR = join(import.meta.dir, '..', '..');
const REPO_ROOT = join(DESKTOP_DIR, '..', '..');
const DIST_DIR = join(DESKTOP_DIR, 'dist');

// The supported floor is macOS 11 (Big Sur), whose WebKit is Safari 14. Three
// files have to agree on that, or the app installs somewhere it cannot run:
// the bundler target, the bundle's own Info.plist floor, and the Homebrew
// cask's constraint.
const EXPECTED_VITE_TARGET = 'safari14';
const EXPECTED_MINIMUM_SYSTEM_VERSION = '11.0';
// Bare symbol means "this release or newer" (Cask Cookbook: top-level
// depends_on macos: declares the minimum compatible release).
const EXPECTED_CASK_CONSTRAINT = 'depends_on macos: :big_sur';

// Safari 14.1 predates ES2022, so parsing at ES2021 is a deliberately
// conservative proxy: anything that parses here certainly parses there. It is
// the check that catches the class static blocks (`static { … }`, ES2022 and
// WebKit 16.4) that shipped in v0.13.0 — a *parse* error, so the entire bundle
// never evaluated and the window rendered blank.
const MAX_ECMA_VERSION = 2021;

function bundleFiles(): string[] {
  return readdirSync(DIST_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => join(DIST_DIR, entry));
}

describe('webkit floor declarations', () => {
  test('vite.config.ts pins the bundler target to the floor', () => {
    const config = readFileSync(join(DESKTOP_DIR, 'vite.config.ts'), 'utf8');
    expect(config).toContain(`const WEBKIT_TARGET = '${EXPECTED_VITE_TARGET}'`);
  });

  test('tauri.conf.json refuses to install below the floor', () => {
    const conf = JSON.parse(
      readFileSync(join(DESKTOP_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8')
    ) as { bundle?: { macOS?: { minimumSystemVersion?: string } } };
    expect(conf.bundle?.macOS?.minimumSystemVersion).toBe(
      EXPECTED_MINIMUM_SYSTEM_VERSION
    );
  });

  test('the generated Homebrew cask carries the same floor', () => {
    const workflow = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
      'utf8'
    );
    expect(workflow).toContain(EXPECTED_CASK_CONSTRAINT);
  });
});

describe('built bundle parses on the oldest supported WebKit', () => {
  // A missing dist/ must fail rather than skip: a silently-skipping check here
  // is exactly as useful as no check at all, and this suite runs in CI directly
  // after `moonx desktop:build`.
  test('dist/ exists (run `moonx desktop:build` first)', () => {
    expect(existsSync(DIST_DIR)).toBe(true);
  });

  test(`every emitted chunk parses as ES${MAX_ECMA_VERSION}`, () => {
    const files = bundleFiles();
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of files) {
      try {
        parse(readFileSync(file, 'utf8'), {
          ecmaVersion: MAX_ECMA_VERSION,
          sourceType: 'module',
        });
      } catch (err) {
        failures.push(
          `${file.slice(DIST_DIR.length)}: ${(err as Error).message}`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test('the polyfill banner leads both the entry chunk and the worker bundle', () => {
    // Matched on the shim's own defineProperty descriptor, which survives
    // minification, rather than on any identifier a minifier would rename.
    const marker = 'writable:!0,enumerable:!1';
    const assets = bundleFiles().filter((f) => f.includes('assets/'));
    const entry = assets.find((f) => f.includes('/index-'));
    const worker = assets.find((f) => f.includes('/worker-'));

    if (entry === undefined || worker === undefined) {
      throw new Error(
        'expected dist/assets to hold both an index-*.js entry chunk and a worker-*.js bundle'
      );
    }
    // A worker has its own global scope, so the main thread's shims never reach
    // it and it needs its own copy.
    expect(readFileSync(entry, 'utf8')).toContain(marker);
    expect(readFileSync(worker, 'utf8')).toContain(marker);
  });
});
