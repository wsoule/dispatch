#!/usr/bin/env bun
// Fails unless every Worker module a sidecar's source spawns is listed as an
// extra `bun build --compile` entry for that sidecar in
// apps/desktop/scripts/build-sidecars.ts.
//
// A compiled Bun binary embeds only the modules reachable from its build
// entrypoints, and `new Worker(new URL('./x', import.meta.url))` is a runtime
// path, not an import — the bundler never follows it. So a worker module that
// is not ALSO named as an entrypoint is simply absent from the binary, and
// `new Worker` fails at runtime with ModuleNotFound. For the daemon's event
// loop watchdog (packages/server/src/watchdog.ts) that failure is a single
// stderr line at boot and then a daemon that runs with no watchdog — which is
// exactly the shape of the 2026-08-23 incident it exists to instrument, and
// nothing else would notice.
//
// The worker list is derived from the source, never hard-coded: any file under
// a sidecar entry's directory that constructs a Worker from a `./`-relative
// `import.meta.url` URL names a module that must be an extra entry.
//
// KNOWN BLIND SPOT: only workers whose URL is a `./`-relative literal beside
// `import.meta.url` in the same file as the `new Worker(` are seen, and only
// under the sidecar's own source tree — a worker spawned from a dependency
// package the sidecar bundles is not. Both are the only shapes the repo uses.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildSidecarsPath = 'apps/desktop/scripts/build-sidecars.ts';

export interface Sidecar {
  /** Repo-relative path of the sidecar's main entry. */
  entry: string;
  /** Repo-relative paths of the extra compile entries it declares. */
  extraEntries: string[];
}

export interface MissingEntry {
  sidecar: string;
  worker: string;
}

const WORKER_CTOR = /\bnew Worker\s*\(/;
const RELATIVE_META_URL =
  /new URL\(\s*[`'"](\.\/[^`'"\n]+?)[`'"]\s*,\s*import\.meta\.url\s*\)/g;

// `./watchdogWorker.${extension}` and `./watchdogWorker.js` both name the
// `.ts` source the compile entry has to be.
function toSourcePath(fileDir: string, specifier: string): string {
  const bare = specifier
    .replace(/\.\$\{[^}]*\}$/, '')
    .replace(/\.[cm]?[jt]s$/, '');
  return normalize(join(fileDir, `${bare}.ts`));
}

/**
 * Every worker module the given files spawn, as repo-relative `.ts` paths.
 * Files are already read so the scan stays testable without disk IO.
 */
export function workerModulesIn(
  files: ReadonlyArray<{ path: string; text: string }>
): string[] {
  const found = new Set<string>();
  for (const file of files) {
    if (!WORKER_CTOR.test(file.text)) continue;
    for (const match of file.text.matchAll(RELATIVE_META_URL)) {
      found.add(toSourcePath(dirname(file.path), match[1]));
    }
  }
  return [...found].sort();
}

// `join(repoRoot, 'packages', 'server', 'src', 'bin.ts')` -> the
// repo-relative path it builds. Only single-quoted literal segments count.
const JOIN_CALL = /join\(\s*repoRoot\s*,((?:\s*'[^']*'\s*,?)+)\)/g;

function joinedPaths(text: string): string[] {
  return [...text.matchAll(JOIN_CALL)].map((m) =>
    [...m[1].matchAll(/'([^']*)'/g)].map((s) => s[1]).join('/')
  );
}

// The object literals directly inside `const SIDECARS = [ ... ]`, found by
// brace depth so a nested array (`extraEntries: [...]`) stays with its object.
function sidecarObjectTexts(text: string): string[] {
  const start = text.indexOf('const SIDECARS = [');
  if (start === -1) return [];
  const objects: string[] = [];
  let depth = 0;
  let objectStart = -1;
  for (let i = text.indexOf('[', start) + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) objects.push(text.slice(objectStart, i + 1));
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return objects;
}

/** The sidecars build-sidecars.ts compiles, with their declared entries. */
export function parseSidecars(buildSidecarsText: string): Sidecar[] {
  const sidecars: Sidecar[] = [];
  for (const object of sidecarObjectTexts(buildSidecarsText)) {
    const entryMatch = /\bentry:\s*(join\([\s\S]*?\))/.exec(object);
    if (entryMatch === null) continue;
    const [entry] = joinedPaths(entryMatch[1]);
    if (entry === undefined) continue;
    const extra = /\bextraEntries:\s*\[([\s\S]*?)\]/.exec(object);
    sidecars.push({
      entry,
      extraEntries: extra === null ? [] : joinedPaths(extra[1]),
    });
  }
  return sidecars;
}

/**
 * Workers spawned from under a sidecar entry's directory that the sidecar
 * does not list as an extra compile entry.
 */
export function missingWorkerEntries(
  sidecars: ReadonlyArray<Sidecar>,
  workerModules: ReadonlyArray<string>
): MissingEntry[] {
  const missing: MissingEntry[] = [];
  for (const sidecar of sidecars) {
    const sourceDir = `${dirname(sidecar.entry)}/`;
    for (const worker of workerModules) {
      if (!worker.startsWith(sourceDir)) continue;
      if (sidecar.extraEntries.includes(worker)) continue;
      missing.push({ sidecar: sidecar.entry, worker });
    }
  }
  return missing;
}

function trackedSourcesUnder(dir: string): { path: string; text: string }[] {
  const res = spawnSync('git', ['ls-files', '-z', '--', dir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    console.error(`\`git ls-files\` failed for ${dir}:\n${res.stderr}`);
    process.exit(1);
  }
  return res.stdout
    .split('\0')
    .filter((f) => /\.[cm]?ts$/.test(f))
    .map((path) => ({
      path,
      text: readFileSync(resolve(repoRoot, path), 'utf8'),
    }));
}

if (import.meta.main) {
  const sidecars = parseSidecars(
    readFileSync(resolve(repoRoot, buildSidecarsPath), 'utf8')
  );
  if (sidecars.length === 0) {
    console.error(
      `Parsed no sidecars out of ${buildSidecarsPath}. The parser is out of step with the file; refusing to pass vacuously.`
    );
    process.exit(1);
  }

  const files = sidecars.flatMap((s) => trackedSourcesUnder(dirname(s.entry)));
  const workers = workerModulesIn(files);
  // A scan that matches nothing is indistinguishable from a broken scan: the
  // server's watchdog worker exists today, so an empty result means the
  // matching has moved out from under this script, not that there is nothing
  // to guard.
  if (workers.length === 0) {
    console.error(
      'Found no Worker modules under any sidecar source tree. This guard only ever passes by matching something, so an empty result means the scan is broken.'
    );
    process.exit(1);
  }

  const missing = missingWorkerEntries(sidecars, workers);
  if (missing.length > 0) {
    console.error('Worker compile-entry check failed:\n');
    for (const { sidecar, worker } of missing) {
      console.error(
        `  - ${worker} is spawned as a Worker but is not an extra compile entry of the sidecar built from ${sidecar}. The compiled binary will fail at \`new Worker\` with ModuleNotFound. Add it to that sidecar's \`extraEntries\` in ${buildSidecarsPath}.`
      );
    }
    process.exit(1);
  }

  console.log(
    `Worker compile-entry check passed: all ${workers.length} Worker module(s) are compile entries of their sidecar.`
  );
}
