import { credentialsPath, normalizeProjectPath } from '@dispatch/core';
import type { CredentialsFile } from '@dispatch/core';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { git } from './git.js';
import { DEMO } from './paths.js';
import { findSuspiciousStagedFiles } from './repo.js';
import { TERMINAL_STATES } from './runs.js';

// One preflight assertion's outcome. `ok: false` always carries a concrete,
// human-readable reason in `detail` — a check that cannot even run (missing
// directory, missing binary, no git upstream) reports itself as failed
// rather than throwing or silently passing.
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

type Outcome = { ok: boolean; detail: string };

// Runs `fn` and turns any thrown error into a failing Check instead of
// letting it escape — the demo has often never been generated when this
// runs, so "directory does not exist" must read as ok:false, not a crash.
function runCheck(name: string, fn: () => Outcome): Check {
  try {
    const { ok, detail } = fn();
    return { name, ok, detail };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// A stored value only counts when it has content after trimming, so an
// empty string in the credentials file reads as "no key" rather than a key.
function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// Recursively collects every `*.jsonl` transcript under `dir`, at any depth
// — callers pass the unkeyed `.dispatch/runs` root, which nests one
// subdirectory per clone (see runsDir in paths.ts).
function walkJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkJsonlFiles(full));
    } else if (entry.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

// Replays a transcript's `state` lines the same way
// packages/server/src/orchestrator/transcript.ts's replayTranscript does:
// later state lines override earlier ones, so the last one wins.
function lastRunState(path: string): { id: string; state: string } {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(
      (l) =>
        JSON.parse(l) as {
          type: string;
          meta?: { id?: string };
          state?: string;
        }
    );
  const header = lines.find((l) => l.type === 'header');
  const id = header?.meta?.id ?? basename(path, '.jsonl');
  let state = 'provisioning';
  for (const line of lines) {
    if (line.type === 'state' && line.state !== undefined) state = line.state;
  }
  return { id, state };
}

const TERMINAL_STATE_NAMES: readonly string[] = TERMINAL_STATES;

/**
 * Asserts every seeded run under a `.dispatch/runs` root ended in a terminal
 * state. `reconcileOnBoot` force-fails anything left non-terminal, so a
 * static fixture with a non-terminal run would silently render as "stuck"
 * the moment the daemon starts — this catches that before it ships.
 */
export function checkRunsTerminal(runsDir: string): Check {
  const name = `run history terminal (${runsDir})`;
  if (!existsSync(runsDir)) {
    return { name, ok: false, detail: `${runsDir} does not exist` };
  }
  const files = walkJsonlFiles(runsDir);
  const nonTerminal = files
    .map(lastRunState)
    .filter((r) => !TERMINAL_STATE_NAMES.includes(r.state));
  if (nonTerminal.length > 0) {
    return {
      name,
      ok: false,
      detail: `non-terminal runs: ${nonTerminal
        .map((r) => `${r.id} (${r.state})`)
        .join(', ')}`,
    };
  }
  return { name, ok: true, detail: `${files.length} run(s), all terminal` };
}

/**
 * Asserts none of `stagedFiles` looks like a credentials file — the demo
 * repo is public, so a Linear API key committed into it can never be
 * un-leaked by a later force-push. Shares its matcher (findSuspiciousStagedFiles
 * in repo.ts) with `assertNoCredentialsStaged`, which runs this same check
 * mid-`buildRepo`/`reset`, before either ever pushes.
 */
export function checkNoCredentialsStaged(stagedFiles: string[]): Check {
  const name = 'no credentials staged for commit';
  const suspicious = findSuspiciousStagedFiles(stagedFiles);
  if (suspicious.length > 0) {
    return {
      name,
      ok: false,
      detail: `staged files that look like credentials: ${suspicious.join(', ')}`,
    };
  }
  return { name, ok: true, detail: 'no staged file name matches "credential"' };
}

// carto degrades silently to a built-in scanner when its binary is missing
// (see the doc comment on carto.enabled in config.ts), so a demo step that
// shows a real dependency graph would render as if nothing were wrong.
function checkCartoAvailable(): Outcome {
  const result = spawnSync('carto', ['--version'], { encoding: 'utf8' });
  if (result.error !== undefined) {
    return {
      ok: false,
      detail: `carto is not on PATH (${result.error.message}) — dependency-graph steps will silently fall back to the built-in scanner`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `carto --version exited ${String(result.status)}: ${result.stderr.trim()}`,
    };
  }
  const version = result.stdout.trim();
  return {
    ok: true,
    detail: version !== '' ? version : 'carto --version exited 0',
  };
}

// A Linear API key must exist in the credentials file for the Linear-sync
// steps of the demo to have anything real to show, and it must live there
// (not in the repo, not only in an env var) since the demo repo is public.
function checkLinearCredentialFile(): Outcome {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return { ok: false, detail: `${path} does not exist` };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CredentialsFile;
  const projectKey =
    parsed.projects?.[normalizeProjectPath(DEMO.root)]?.linear?.apiKey;
  const globalKey = parsed.linear?.apiKey;
  const apiKey = nonEmpty(projectKey) ?? nonEmpty(globalKey);
  if (apiKey === null) {
    return {
      ok: false,
      detail: `${path} has no linear.apiKey set for the demo project or globally`,
    };
  }
  return { ok: true, detail: `linear.apiKey present in ${path}` };
}

// Every git-backed check below assumes `root` is a real clone. Failing this
// early with a plain message beats letting spawnSync's cwd-not-found error
// (which git() surfaces as a bare "...: null") stand in for "run reset first".
function assertCloneExists(root: string): void {
  if (!existsSync(root)) {
    throw new Error(`${root} does not exist — run "demo reset" first`);
  }
}

function stagedFilesFor(root: string): string[] {
  assertCloneExists(root);
  return git(root, 'diff', '--cached', '--name-only')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

function checkCleanWorkingTree(root: string): Outcome {
  assertCloneExists(root);
  const status = git(root, 'status', '--porcelain').trim();
  if (status !== '') {
    return {
      ok: false,
      detail: `git status --porcelain is non-empty:\n${status}`,
    };
  }
  return { ok: true, detail: 'clean' };
}

function checkNoUnpushedCommits(root: string): Outcome {
  assertCloneExists(root);
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const count = git(root, 'rev-list', '--count', '@{u}..HEAD').trim();
  if (count !== '0') {
    return {
      ok: false,
      detail: `${branch} is ${count} commit(s) ahead of its upstream`,
    };
  }
  return { ok: true, detail: `${branch} matches its upstream` };
}

function runsRootFor(home: string): string {
  return join(home, '.dispatch', 'runs');
}

// Prints every check as a table and sets a non-zero exit code if any failed
// — never throws, and never exits 0 while a check is failing.
export function runPreflight(): Check[] {
  const checks: Check[] = [
    runCheck('carto binary available', checkCartoAvailable),
    runCheck(
      'linear api key present (not committed)',
      checkLinearCredentialFile
    ),
    runCheck('owner clone: no credentials staged', () =>
      checkNoCredentialsStaged(stagedFilesFor(DEMO.root))
    ),
    runCheck('teammate clone: no credentials staged', () =>
      checkNoCredentialsStaged(stagedFilesFor(DEMO.teammateRoot))
    ),
    runCheck('teammate clone has no unpushed commits', () =>
      checkNoUnpushedCommits(DEMO.teammateRoot)
    ),
    runCheck('owner clone working tree is clean', () =>
      checkCleanWorkingTree(DEMO.root)
    ),
    runCheck('teammate clone working tree is clean', () =>
      checkCleanWorkingTree(DEMO.teammateRoot)
    ),
    runCheck('owner run history is all terminal', () =>
      checkRunsTerminal(runsRootFor(DEMO.home))
    ),
    runCheck('teammate run history is all terminal', () =>
      checkRunsTerminal(runsRootFor(DEMO.teammateHome))
    ),
  ];

  console.table(checks);
  if (checks.some((c) => !c.ok)) {
    process.exitCode = 1;
  }
  return checks;
}
