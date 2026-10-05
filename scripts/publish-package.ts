#!/usr/bin/env bun
// The publish pipeline's steps as testable functions: map a tag to a package,
// check its workspace dependencies are public, pack with pnpm, refuse a
// manifest that still names the workspace, strip scripts, and smoke-install.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  repository?: { url?: string; directory?: string };
  publishConfig?: { access?: string };
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Project name → directory of every package the pipeline may publish. */
export const PUBLISHABLE: Readonly<Record<string, string>> = {
  core: 'packages/core',
  protocol: 'packages/protocol',
  a2a: 'packages/a2a',
  'protocol-spec': 'packages/protocol-spec',
  federation: 'packages/federation',
};

const SCOPE = '@dispatch-foo/';
// The npm scope @dispatch belongs to someone else; nothing may depend on it.
const FOREIGN_SCOPE = '@dispatch/';
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const RUNTIME = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const ALL = [...RUNTIME, 'devDependencies'] as const;

// Every reason a packed manifest must not be staged; empty when it may.
export function checkPackedManifest(pkg: PackageJson): string[] {
  const problems: string[] = [];
  for (const field of ALL) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (spec.startsWith('workspace:') || spec.startsWith('catalog:'))
        problems.push(`${field}.${name} is still ${spec}`);
      else if (!(RUNTIME as readonly string[]).includes(field)) continue;
      else if (name.startsWith(FOREIGN_SCOPE))
        problems.push(
          `${field}.${name} names the foreign ${FOREIGN_SCOPE} scope`
        );
      else if (name.startsWith(SCOPE) && !EXACT.test(spec))
        problems.push(`${field}.${name} must be an exact version, got ${spec}`);
    }
  }
  if (pkg.private === true) problems.push('"private" is still true');
  if (pkg.publishConfig?.access !== 'public')
    problems.push('publishConfig.access is not "public"');
  if (!(pkg.repository?.url ?? '').includes('github.com/wsoule/dispatch'))
    problems.push(
      'repository does not name the public repo (provenance would not verify)'
    );
  return problems;
}

export function stripScripts(pkg: PackageJson): PackageJson {
  return Object.fromEntries(
    Object.entries(pkg).filter(([key]) => key !== 'scripts')
  ) as unknown as PackageJson;
}

// A tag (`protocol@0.2.0`) or a bare project name, checked against the
// package's own version.
export function resolvePackage(
  ref: string,
  read: (dir: string) => PackageJson
): { project: string; dir: string; name: string; version: string } {
  const at = ref.lastIndexOf('@');
  const project = at > 0 ? ref.slice(0, at) : ref;
  if (at <= 0 && !(project in PUBLISHABLE))
    throw new Error(`${ref} is not a package tag`);
  const dir = PUBLISHABLE[project];
  if (dir === undefined) throw new Error(`${project} is not publishable`);
  const pkg = read(dir);
  if (at > 0 && ref.slice(at + 1) !== pkg.version)
    throw new Error(
      `tag version ${ref.slice(at + 1)} differs from ${dir}/package.json version ${pkg.version}`
    );
  return { project, dir, name: pkg.name, version: pkg.version };
}

// Drafts go on `latest` until a stable release exists, then on `next`.
export function distTagFor(
  version: string,
  published: readonly string[]
): 'latest' | 'next' {
  const stable = published.some((v) => !v.includes('-') && v !== '0.0.0');
  return version.includes('-') && stable ? 'next' : 'latest';
}

const DTS_SPECIFIER =
  /(?:from\s+|import\(\s*)['"](@dispatch(?:-foo)?\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;

// A packed .d.ts may name a workspace package only if the consumer gets it at
// runtime; a devDependency's types must be bundled in.
export function checkPackedTypes(
  pkg: PackageJson,
  dts: readonly { path: string; text: string }[]
): string[] {
  const runtime = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const problems: string[] = [];
  for (const { path, text } of dts) {
    for (const m of text.matchAll(DTS_SPECIFIER)) {
      const name = m[1] ?? '';
      if (!runtime.has(name))
        problems.push(
          `${path} imports ${name}, which is not a runtime dependency; bundle its types`
        );
    }
  }
  return problems;
}

// npm install argv for the smoke test: every packed workspace package (direct
// or transitive) from its local tarball, so the package installs before its
// dependencies are public. `pkg` is kept for the call shape the stage job uses.
export function smokeInstallArgs(
  _pkg: PackageJson,
  packageTgz: string,
  depTarballs: Readonly<Record<string, string>>
): string[] {
  const deps = Object.keys(depTarballs)
    .sort()
    .map((name) => `${name}@file:${depTarballs[name] ?? ''}`);
  return ['install', '--no-audit', '--no-fund', ...deps, packageTgz];
}

const root = resolve(import.meta.dir, '..');

function readPackage(dir: string): PackageJson {
  return JSON.parse(
    readFileSync(join(resolve(root, dir), 'package.json'), 'utf8')
  ) as PackageJson;
}

function run(command: string, args: string[], cwd: string): string {
  const out = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (out.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}:\n${out.stderr}${out.stdout}`
    );
  return out.stdout;
}

// The published versions of `name`; empty when only a placeholder or nothing exists.
function publishedVersions(name: string): string[] {
  const out = spawnSync('npm', ['view', name, 'versions', '--json'], {
    encoding: 'utf8',
  });
  if (out.status !== 0) return [];
  const parsed = JSON.parse(out.stdout || '[]') as string[] | string;
  return Array.isArray(parsed) ? parsed : [parsed];
}

// The workspace packages a package depends on at runtime, by name → directory;
// with `transitive`, theirs too.
function workspaceDeps(
  dir: string,
  transitive = false
): Record<string, string> {
  const byName = new Map(
    Object.values(PUBLISHABLE).map((d) => [readPackage(d).name, d])
  );
  const out: Record<string, string> = {};
  const visit = (from: string): void => {
    const pkg = readPackage(from);
    for (const field of RUNTIME)
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        const depDir = byName.get(name);
        if (!spec.startsWith('workspace:') || depDir === undefined) continue;
        if (name in out) continue;
        out[name] = depDir;
        if (transitive) visit(depDir);
      }
  };
  visit(dir);
  return out;
}

// pnpm pack into a fresh directory; returns the tarball's path.
function pnpmPack(dir: string, into: string): string {
  mkdirSync(into, { recursive: true });
  const before = new Set(readdirSync(into));
  run('pnpm', ['pack', '--pack-destination', into], resolve(root, dir));
  const made = readdirSync(into).find(
    (f) => f.endsWith('.tgz') && !before.has(f)
  );
  if (made === undefined) throw new Error(`pnpm pack wrote nothing for ${dir}`);
  return join(into, made);
}

function dtsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    if (statSync(path).isDirectory())
      return f === 'node_modules' ? [] : dtsFiles(path);
    return /\.d\.m?ts$/.test(f) ? [path] : [];
  });
}

function main(argv: string[]): number {
  const [command, a, b, c] = argv;
  if (command === 'resolve' && a !== undefined) {
    const r = resolvePackage(a, readPackage);
    const distTag = distTagFor(r.version, publishedVersions(r.name));
    console.log(
      `project=${r.project}\ndir=${r.dir}\nname=${r.name}\nversion=${r.version}\ndistTag=${distTag}`
    );
    return 0;
  }
  if (command === 'check-deps' && a !== undefined) {
    const deps = workspaceDeps(a);
    if (b === '--public') {
      const missing = Object.entries(deps).flatMap(([name, dir]) => {
        const { version } = readPackage(dir);
        return publishedVersions(name).includes(version)
          ? []
          : [`${name}@${version}`];
      });
      if (missing.length > 0) {
        console.error(`not public yet: ${missing.join(', ')}`);
        return 1;
      }
      return 0;
    }
    if (b === '--local' && c !== undefined) {
      // The dry run installs the whole local chain, so pack it transitively.
      for (const dir of Object.values(workspaceDeps(a, true))) pnpmPack(dir, c);
      return 0;
    }
  }
  if (command === 'pack' && a !== undefined && b !== undefined) {
    const tgz = pnpmPack(a, mkdtempSync(join(tmpdir(), 'dmp-pack-')));
    rmSync(b, { recursive: true, force: true });
    mkdirSync(b, { recursive: true });
    run('tar', ['-xzf', tgz, '-C', b, '--strip-components=1'], root);
    const pkg = JSON.parse(
      readFileSync(join(b, 'package.json'), 'utf8')
    ) as PackageJson;
    const dts = dtsFiles(b).map((path) => ({
      path: path.slice(b.length + 1),
      text: readFileSync(path, 'utf8'),
    }));
    const problems = [
      ...checkPackedManifest(pkg),
      ...checkPackedTypes(pkg, dts),
    ];
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      return 1;
    }
    // The staged tarball is the extracted package without its scripts.
    run('npm', ['pkg', 'delete', 'scripts'], b);
    const packed = mkdtempSync(join(tmpdir(), 'dmp-staged-'));
    run('npm', ['pack', '--pack-destination', packed], b);
    const staged = readdirSync(packed).find((f) => f.endsWith('.tgz'));
    if (staged === undefined)
      throw new Error(`npm pack wrote nothing for ${b}`);
    copyFileSync(join(packed, staged), `${b}.tgz`);
    return 0;
  }
  if (command === 'smoke' && a !== undefined) {
    const pkg = JSON.parse(
      readFileSync(join(a, 'package.json'), 'utf8')
    ) as PackageJson;
    const tarballs: Record<string, string> = {};
    // A package with no workspace dependencies packs none, so `b` may not exist.
    if (b !== undefined && existsSync(b))
      for (const f of readdirSync(b).filter((n) => n.endsWith('.tgz'))) {
        const manifest = JSON.parse(
          run('tar', ['-xOzf', join(b, f), 'package/package.json'], root)
        ) as PackageJson;
        tarballs[manifest.name] = join(b, f);
      }
    const dir = mkdtempSync(join(tmpdir(), 'dmp-smoke-'));
    run('npm', ['init', '-y'], dir);
    run('npm', smokeInstallArgs(pkg, `${a}.tgz`, tarballs), dir);
    for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
      const js = JSON.stringify(target).match(/"(\.\/[^"]+\.js)"/);
      if (js === null) continue;
      const spec = `${pkg.name}${subpath === '.' ? '' : subpath.slice(1)}`;
      run(
        'node',
        ['--input-type=module', '-e', `await import(${JSON.stringify(spec)})`],
        dir
      );
      console.log(`smoke: imported ${spec}`);
    }
    rmSync(dir, { recursive: true, force: true });
    return 0;
  }
  console.error(
    'usage: publish-package.ts resolve <tag|project> | check-deps <dir> --public|--local <out> | pack <dir> <out> | smoke <package-dir> [deps-dir]'
  );
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
