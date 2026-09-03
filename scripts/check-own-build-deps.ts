#!/usr/bin/env bun
// Fails unless every project whose tests reach into that project's OWN build
// output declares a dependency on its own `build` task.
//
// This exists because of a CI failure that no amount of local testing could
// reproduce. The shared test task in .moon/tasks/bun-common.yml declares
// `deps: ['^:build']`, and `^:build` means "build my DEPENDENCY projects" — it
// never includes the project's own build. packages/cli's e2e tests spawn
// `node ../dist/cli.js` and packages/mcp's spawns `node ../dist/bin.js`, both
// produced only by that project's own build task, so `<p>:build` and `<p>:test`
// sat in the graph as unordered siblings that moon was free to run at the same
// time.
//
// Locally dist/ is always warm from an earlier build, so the missing edge is
// invisible. A cold CI checkout raced: cli:test started two seconds before
// cli:build and died on "Cannot find module .../dist/cli.js", while mcp:test
// spawned its binary midway through a `tsdown --clean` that had just deleted it
// and hung to the 15s timeout. Because it is a race and not a hard failure, the
// count of failing tests moved between runs — the artifact appeared partway
// through the suite, so whichever files were scheduled after that instant
// passed.
//
// apps/site and apps/desktop already carried the `deps: ['build']` override
// with a comment describing this trap. cli and mcp did not, and nothing
// connected the two facts. This guard is that connection.
//
// KNOWN BLIND SPOT: only relative string literals are matched, so a path built
// up in code is not seen. apps/desktop's webkitFloor.test.ts does exactly that
// (`join(DESKTOP_DIR, 'dist')`) and is therefore not covered here — it already
// declares the edge, and it asserts dist/ exists rather than skipping, so a
// regression there fails loudly on its own. Broadening the match to arbitrary
// path construction would cost more in false positives than it buys.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Only these are scanned for build-output references; the pattern this guard
// detects is a source literal handed to spawn/resolve/new URL.
const SCANNED_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;

type MoonTask = {
  deps?: { target: string }[];
  outputFiles?: Record<string, unknown>;
};

function queryTasks(): Record<string, Record<string, MoonTask>> {
  const res = spawnSync('moon', ['query', 'tasks'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    console.error(`\`moon query tasks\` failed:\n${res.stderr}`);
    process.exit(1);
  }
  const parsed = JSON.parse(res.stdout) as {
    tasks: Record<string, Record<string, MoonTask>>;
  };
  const projects = Object.keys(parsed.tasks ?? {});
  if (projects.length === 0) {
    console.error(
      'moon reported no projects at all. Either the query shape changed or the workspace is not being picked up; refusing to pass vacuously.'
    );
    process.exit(1);
  }
  return parsed.tasks;
}

// A build task's outputs are workspace-relative ('packages/cli/dist'); the
// project that owns them is the nearest ancestor holding a moon.yml.
function owningProjectDir(outputDir: string): string | null {
  let dir = resolve(repoRoot, outputDir);
  while (dir.startsWith(repoRoot) && dir !== repoRoot) {
    dir = dirname(dir);
    if (existsSync(join(dir, 'moon.yml'))) return dir;
  }
  return null;
}

function trackedFilesUnder(dir: string): string[] {
  const res = spawnSync('git', ['ls-files', '-z', '--', dir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    console.error(`\`git ls-files\` failed for ${dir}:\n${res.stderr}`);
    process.exit(1);
  }
  return res.stdout.split('\0').filter((f) => f.length > 0);
}

// Relative specifiers only ('./x', '../x'). A bare 'mcp/dist/index.js' is not a
// path this file resolves against itself, and './dist/index.js' inside a test
// fixture resolves beside the test file rather than into the real output dir —
// both must stay out, or the guard cries wolf on packages/server.
const RELATIVE_LITERAL = /['"`](\.\.?\/[^'"`\n]*)['"`]/g;

// Every reference from inside a project to a path under its own build output.
function ownBuildOutputReferences(
  projectDir: string,
  outputDirs: string[]
): { file: string; specifier: string }[] {
  const hits: { file: string; specifier: string }[] = [];
  for (const file of trackedFilesUnder(projectDir)) {
    if (!SCANNED_EXTENSIONS.test(file)) continue;
    const absoluteFile = resolve(repoRoot, file);
    if (outputDirs.some((out) => absoluteFile.startsWith(`${out}/`))) continue;
    const text = readFileSync(absoluteFile, 'utf8');
    for (const match of text.matchAll(RELATIVE_LITERAL)) {
      const target = resolve(dirname(absoluteFile), match[1]);
      if (
        !outputDirs.some(
          (out) => target === out || target.startsWith(`${out}/`)
        )
      )
        continue;
      hits.push({ file, specifier: match[1] });
    }
  }
  return hits;
}

const tasks = queryTasks();
const problems: string[] = [];
let projectsWithReferences = 0;

for (const [project, projectTasks] of Object.entries(tasks)) {
  const build = projectTasks.build;
  const test = projectTasks.test;
  if (build === undefined || test === undefined) continue;

  const outputDirs = Object.keys(build.outputFiles ?? {}).map((out) =>
    resolve(repoRoot, out)
  );
  if (outputDirs.length === 0) continue;

  const projectDir = owningProjectDir(relative(repoRoot, outputDirs[0]));
  if (projectDir === null) continue;

  const references = ownBuildOutputReferences(projectDir, outputDirs);
  if (references.length === 0) continue;
  projectsWithReferences += 1;

  const dependsOnOwnBuild = (test.deps ?? []).some(
    (dep) => dep.target === `${project}:build`
  );
  if (dependsOnOwnBuild) continue;

  const where = references
    .map((ref) => `${ref.file} -> ${ref.specifier}`)
    .join('\n      ');
  problems.push(
    `${project}:test reads ${project}'s own build output but does not depend on ${project}:build, so moon may run them concurrently:\n      ${where}\n    Add \`test: { deps: ['build'] }\` to ${relative(repoRoot, projectDir)}/moon.yml. The inherited \`^:build\` covers dependency projects only, never this one.`
  );
}

// The whole guard is a scan for a pattern, so a scan that matches nothing is
// indistinguishable from a scan that is broken. cli, mcp, site and desktop all
// reference their own dist today; if that count ever reaches zero, the file
// layout or the literal-matching has moved out from under this script.
if (projectsWithReferences === 0) {
  console.error(
    'Found no project referencing its own build output. This guard only ever passes by matching something, so an empty result means the scan is broken, not that the repo is clean.'
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error('Own-build dependency check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Own-build dependency check passed: all ${projectsWithReferences} projects whose tests use their own build output depend on it.`
);
