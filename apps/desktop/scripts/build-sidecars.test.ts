import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sidecarExecutableName, SIDECARS } from './build-sidecars.ts';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  exports?: unknown;
}

// Every workspace package by name, with its directory relative to the root.
function workspaceManifests(): Map<string, { dir: string; pkg: Manifest }> {
  const byName = new Map<string, { dir: string; pkg: Manifest }>();
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(repoRoot, group))) {
      const file = join(repoRoot, group, name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      byName.set(pkg.name, { dir: `${group}/${name}`, pkg });
    }
  }
  return byName;
}

// The directories of the packages the sidecars compile from source, and of
// every workspace package they import at runtime through a dist/ export,
// which `bun build --compile` cannot resolve until that package is built.
function sidecarPackages(): { sources: string[]; dist: string[] } {
  const byName = workspaceManifests();
  const sources = SIDECARS.map((s) =>
    relative(repoRoot, s.entry).split('/').slice(0, 2).join('/')
  );
  const seen = new Set<string>();
  const queue = [...byName.values()].filter((w) => sources.includes(w.dir));
  const dist: string[] = [];
  for (let w = queue.shift(); w !== undefined; w = queue.shift()) {
    for (const [dep, range] of Object.entries(w.pkg.dependencies ?? {})) {
      const next = byName.get(dep);
      if (!range.startsWith('workspace:') || next === undefined) continue;
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(next);
      if (JSON.stringify(next.pkg.exports ?? null).includes('./dist/'))
        dist.push(next.dir);
    }
  }
  return { sources, dist: dist.sort() };
}

const projectOf = (dir: string) => dir.split('/')[1];

describe('sidecarExecutableName', () => {
  test('adds .exe to every Windows sidecar and leaves Unix names unchanged', () => {
    const names = ['dispatchd', 'dispatch-mcp', 'dispatch-cli'];
    expect(names.map((name) => sidecarExecutableName(name, 'win32'))).toEqual([
      'dispatchd.exe',
      'dispatch-mcp.exe',
      'dispatch-cli.exe',
    ]);
    expect(names.map((name) => sidecarExecutableName(name, 'linux'))).toEqual(
      names
    );
    expect(names.map((name) => sidecarExecutableName(name, 'darwin'))).toEqual(
      names
    );
  });
});

test('Tauri keeps Unix resources in the base config and overrides them on Windows', () => {
  const base = JSON.parse(
    readFileSync(resolve(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8')
  ) as { bundle: { resources: string[] } };
  const windows = JSON.parse(
    readFileSync(
      resolve(desktopDir, 'src-tauri', 'tauri.windows.conf.json'),
      'utf8'
    )
  ) as { bundle: { resources: string[] } };

  expect(base.bundle.resources).toEqual([
    'resources/dispatchd',
    'resources/dispatch-mcp',
    'resources/dispatch-cli',
  ]);
  expect(windows.bundle.resources).toEqual([
    'resources/dispatchd.exe',
    'resources/dispatch-mcp.exe',
    'resources/dispatch-cli.exe',
  ]);
});

test('desktop:tauri-dev depends on the cacheable sidecar build outputs', () => {
  // Read the task graph structurally rather than by regex over the file, so a
  // reworded comment or a new task between the two cannot break this test.
  const { tasks } = Bun.YAML.parse(
    readFileSync(resolve(desktopDir, 'moon.yml'), 'utf8')
  ) as {
    tasks: Record<
      string,
      {
        deps?: string[];
        inputs?: string[];
        outputs?: string[];
        options?: { cache?: boolean };
      }
    >;
  };
  const sidecars = tasks['build-sidecars'];
  const tauriDev = tasks['tauri-dev'];

  expect(sidecars.outputs).toEqual([
    'src-tauri/resources/dispatchd*',
    'src-tauri/resources/dispatch-mcp*',
    'src-tauri/resources/dispatch-cli*',
  ]);
  // The two inputs that change the binaries without touching any source: the
  // signing identity and the entitlements the sidecars are signed with.
  expect(sidecars.inputs).toContain('$APPLE_SIGNING_IDENTITY');
  expect(sidecars.inputs).toContain('src-tauri/entitlements/sidecar.plist');
  expect(sidecars.options?.cache).not.toBe(false);
  expect(tauriDev.deps).toContain('build-sidecars');
});

test('the release builds every package the sidecars import through dist/', () => {
  const release = Bun.YAML.parse(
    readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  ) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> };
  const step = Object.values(release.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((s) => s.name === 'Build workspace packages');
  const targets = (step?.run ?? '').split(/\s+/);

  const { dist } = sidecarPackages();
  expect(dist.length).toBeGreaterThan(0);
  for (const dir of dist) expect(targets).toContain(`${projectOf(dir)}:build`);
});

test('desktop:build-sidecars builds and hashes every package it compiles', () => {
  const { tasks } = Bun.YAML.parse(
    readFileSync(resolve(desktopDir, 'moon.yml'), 'utf8')
  ) as { tasks: Record<string, { deps?: string[]; inputs?: string[] }> };
  const sidecars = tasks['build-sidecars'];

  const { sources, dist } = sidecarPackages();
  for (const dir of dist)
    expect(sidecars.deps).toContain(`${projectOf(dir)}:build`);
  for (const dir of [...sources, ...dist])
    expect(sidecars.inputs).toContain(`/${dir}/src/**/*`);
});
