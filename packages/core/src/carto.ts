import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';

/** The carto binary Dispatch found, and the version it reported. */
export interface CartoBinary {
  path: string;
  version: string;
}

export type CartoDiscovery =
  | { ok: true; binary: CartoBinary }
  | {
      ok: false;
      reason: 'not-found' | 'unsupported-version' | 'unreadable';
      detail: string;
    };

// The ANCI container layout and the `output` config key this integration
// depends on both landed in carto 2.x.
const MIN_MAJOR = 2;

// Homebrew's two standard prefixes, searched after PATH so an explicitly
// installed carto always wins over a brew one.
const BREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateDirs(
  env: NodeJS.ProcessEnv,
  extraDirs: readonly string[]
): string[] {
  const fromPath = (env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  return [...fromPath, ...extraDirs];
}

// Locates `carto`, runs `--version`, and gates on the 2.x floor. Returns a
// result rather than throwing.
export function discoverCarto(
  env: NodeJS.ProcessEnv = process.env,
  extraDirs: readonly string[] = BREW_BIN_DIRS
): CartoDiscovery {
  let found: string | null = null;
  for (const dir of candidateDirs(env, extraDirs)) {
    const candidate = join(dir, 'carto');
    if (existsSync(candidate) && isRegularFile(candidate)) {
      found = candidate;
      break;
    }
  }
  if (found === null) {
    return {
      ok: false,
      reason: 'not-found',
      detail: 'no `carto` found on PATH or in the fallback directories',
    };
  }

  const probe = spawnSync(found, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `\`carto --version\` exited ${String(probe.status)}`,
    };
  }
  const version = (probe.stdout ?? '').trim();
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isNaN(major) || major < MIN_MAJOR) {
    return {
      ok: false,
      reason: 'unsupported-version',
      detail: `carto ${version} is below the required ${String(MIN_MAJOR)}.x`,
    };
  }
  return { ok: true, binary: { path: found, version } };
}

/** One `blastRadius()` response. Key names are pinned by the recorded
 *  fixture in packages/server/test/fixtures/carto-blast-radius.json. */
export interface CartoBlastRadius {
  count: number;
  hops: number;
  files: unknown[];
}

export interface CartoReader {
  blastRadius(file: string): CartoBlastRadius;
}

export type CartoReaderResult =
  | { ok: true; reader: CartoReader }
  | { ok: false; reason: 'no-container' | 'load-failed'; detail: string };

// Opens the ANCI container as a library, which reads it "without running
// Carto's engine" — no binary spawn per query. Wrapped in a result because a
// half-written container during a sync is a normal, recoverable state.
export function openCartoReader(projectRoot: string): CartoReaderResult {
  const dir = join(projectRoot, '.carto');
  if (!existsSync(dir)) {
    return { ok: false, reason: 'no-container', detail: `${dir} not found` };
  }
  try {
    // Resolved lazily: importing it at module load would make every consumer
    // of this file depend on carto-md being installed.
    const require_ = createRequire(import.meta.url);
    const { loadAnci } = require_('carto-md/src/anci/consumer') as {
      loadAnci: (dir: string) => CartoReader;
    };
    return { ok: true, reader: loadAnci(dir) };
  } catch (err) {
    return { ok: false, reason: 'load-failed', detail: (err as Error).message };
  }
}

const CARTO_HOOKS = [
  'pre-commit',
  'post-checkout',
  'post-merge',
  'post-rewrite',
];

// Worktrees share the common git dir, so carto's own hook line runs with cwd
// set to the worktree, where .carto/ does not exist. `--git-common-dir`
// resolves to the main repo's .git from inside any linked worktree, so its
// parent is always the project root.
const PINNED_SYNC_LINE =
  '(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && carto sync) >/dev/null 2>&1 || true';

const BARE_SYNC_RE = /^\s*carto sync\b.*$/gm;

// Rewrites carto's inserted `carto sync` line in each installed hook to pin
// its working directory. Idempotent: a line already containing
// --git-common-dir is left alone, and carto's own installer skips any hook
// whose contents already mention `carto sync`, so re-running `carto init`
// will not undo this.
export function pinHookWorkingDirs(projectRoot: string): string[] {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  if (!existsSync(hooksDir)) return [];
  const rewritten: string[] = [];
  const present = new Set(readdirSync(hooksDir));
  for (const name of CARTO_HOOKS) {
    if (!present.has(name)) continue;
    const path = join(hooksDir, name);
    const body = readFileSync(path, 'utf8');
    if (body.includes('--git-common-dir')) continue;
    if (!BARE_SYNC_RE.test(body)) continue;
    BARE_SYNC_RE.lastIndex = 0;
    writeFileSync(path, body.replace(BARE_SYNC_RE, PINNED_SYNC_LINE));
    rewritten.push(path);
  }
  return rewritten;
}

export interface CartoRunResult {
  ok: boolean;
  detail: string;
}

// carto writes .carto/config.json with `output: 'AGENTS.md'`, and every later
// `carto sync` resolves its destination from that key. Repointing it once
// makes AGENTS.md permanently safe.
export function redirectCartoOutput(projectRoot: string): void {
  const path = join(projectRoot, '.carto', 'config.json');
  if (!existsSync(path)) return;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  config.output = '.carto/CONTEXT.md';
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

// Builds the container, containing carto init's two side effects on files
// Dispatch owns: AGENTS.md is snapshotted and restored across the single init
// call, then permanently protected by repointing config.output; the four
// installed hooks get their working directory pinned.
export function cartoInit(
  projectRoot: string,
  binary: CartoBinary
): CartoRunResult {
  const agents = join(projectRoot, 'AGENTS.md');
  const backup = join(projectRoot, '.carto-agents-backup');
  const hadAgents = existsSync(agents);
  if (hadAgents) copyFileSync(agents, backup);

  const run = spawnSync(binary.path, ['init'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (hadAgents) {
    copyFileSync(backup, agents);
    unlinkSync(backup);
  } else if (existsSync(agents)) {
    unlinkSync(agents);
  }
  redirectCartoOutput(projectRoot);
  pinHookWorkingDirs(projectRoot);

  // Exit status alone is NOT trustworthy: carto 2.1.3 prints
  // "Fatal error: Could not locate the bindings file" and still exits 0,
  // leaving .carto/ with only config.json. Measured in Task 0. The container
  // existing is the only honest success signal.
  if (!existsSync(join(projectRoot, '.carto', 'carto.db'))) {
    const stderr = (run.stderr ?? '').trim();
    return {
      ok: false,
      detail: stderr !== '' ? stderr : 'carto init produced no container',
    };
  }
  if (run.status === 0) {
    return { ok: true, detail: `indexed with carto ${binary.version}` };
  }
  const stderr = (run.stderr ?? '').trim();
  return { ok: false, detail: stderr !== '' ? stderr : 'carto init failed' };
}

// Incremental re-index. cwd is pinned to the project root because .carto/
// only ever exists there, never in a run's worktree.
export function cartoSync(
  projectRoot: string,
  binary: CartoBinary
): CartoRunResult {
  const run = spawnSync(binary.path, ['sync'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (run.status === 0) return { ok: true, detail: 'synced' };
  const stderr = (run.stderr ?? '').trim();
  return { ok: false, detail: stderr !== '' ? stderr : 'carto sync failed' };
}
