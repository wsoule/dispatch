import { spawn, spawnSync } from 'node:child_process';
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

// Set by test suites that must never touch a real carto install. PATH alone
// cannot express that: discovery also searches the Homebrew prefixes.
const DISABLE_ENV_VAR = 'DISPATCH_CARTO_DISABLED';

// Locates `carto`, runs `--version`, and gates on the 2.x floor. Returns a
// result rather than throwing.
export function discoverCarto(
  env: NodeJS.ProcessEnv = process.env,
  extraDirs: readonly string[] = BREW_BIN_DIRS
): CartoDiscovery {
  if (env[DISABLE_ENV_VAR] === '1') {
    return {
      ok: false,
      reason: 'not-found',
      detail: `carto discovery disabled by ${DISABLE_ENV_VAR}=1`,
    };
  }
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
  // The real CLI prints `${pkg.name} ${pkg.version}` ("carto-md 2.1.3"), not
  // a bare number, so the version is pulled out of the trailing dotted-digit
  // group rather than assumed to be the whole line.
  const rawOutput = (probe.stdout ?? '').trim();
  const versionMatch = /(\d+(?:\.\d+)*)\s*$/.exec(rawOutput);
  const version = versionMatch?.[1] ?? rawOutput;
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

// Worktrees share the common git dir; `--git-common-dir` resolves to the
// project root from any linked worktree.
const PINNED_SYNC_LINE =
  '(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && carto sync) >/dev/null 2>&1 || true';

const BARE_SYNC_RE = /^\s*carto sync\b.*$/gm;

// Rewrites each hook's `carto sync` line to pin its working directory.
// Idempotent, and skips rather than throws on any hook it can't read/write.
export function pinHookWorkingDirs(projectRoot: string): string[] {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  if (!existsSync(hooksDir)) return [];
  let present: Set<string>;
  try {
    present = new Set(readdirSync(hooksDir));
  } catch {
    return [];
  }
  const rewritten: string[] = [];
  for (const name of CARTO_HOOKS) {
    if (!present.has(name)) continue;
    const path = join(hooksDir, name);
    let body: string;
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (body.includes('--git-common-dir')) continue;
    if (!BARE_SYNC_RE.test(body)) continue;
    BARE_SYNC_RE.lastIndex = 0;
    try {
      writeFileSync(path, body.replace(BARE_SYNC_RE, PINNED_SYNC_LINE));
      rewritten.push(path);
    } catch {
      // leave this hook unpinned; not fatal
    }
  }
  return rewritten;
}

export interface CartoRunResult {
  ok: boolean;
  detail: string;
}

// carto sync resolves its output destination from config.json's `output`
// key; repointing it once keeps AGENTS.md permanently safe.
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
  try {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // Best-effort: a read-only config leaves carto pointed at AGENTS.md,
    // which the snapshot/restore in cartoInit still covers.
  }
}

// Appends a `.carto/` ignore entry to .gitignore (creating it if needed);
// no-op if a `.carto` line is already there. carto's index is per-machine.
function ensureCartoIgnored(projectRoot: string): void {
  const path = join(projectRoot, '.gitignore');
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (/^\.carto\/?\s*$/m.test(existing)) return;
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(path, `${existing}${prefix}.carto/\n`);
  } catch {
    // Best-effort: an unignorable .carto/ shows up as untracked, which is
    // noise, not a failure.
  }
}

// Runs carto init, containing its side effects on files Dispatch owns:
// AGENTS.md is snapshotted/restored around the call, then hooks are pinned.
export function cartoInit(
  projectRoot: string,
  binary: CartoBinary
): CartoRunResult {
  const agents = join(projectRoot, 'AGENTS.md');
  const backup = join(projectRoot, '.carto-agents-backup');
  const hadAgents = existsSync(agents);
  if (hadAgents) {
    try {
      copyFileSync(agents, backup);
    } catch (err) {
      return {
        ok: false,
        detail: `could not snapshot AGENTS.md before carto init: ${(err as Error).message}`,
      };
    }
  }

  const run = spawnSync(binary.path, ['init'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (hadAgents) {
    try {
      copyFileSync(backup, agents);
    } catch (err) {
      try {
        unlinkSync(backup);
      } catch {
        // best-effort; the restore failure below is what the caller needs
      }
      return {
        ok: false,
        detail: `could not restore AGENTS.md after carto init: ${(err as Error).message}`,
      };
    }
    try {
      unlinkSync(backup);
    } catch {
      // best-effort; AGENTS.md itself was already restored successfully
    }
  } else if (existsSync(agents)) {
    try {
      unlinkSync(agents);
    } catch {
      // best-effort; leaves the file carto created, not the original
    }
  }
  redirectCartoOutput(projectRoot);
  pinHookWorkingDirs(projectRoot);
  // Ignored here rather than at `dispatch init` time so every builder is
  // covered: a failed init still leaves .carto/config.json behind, and the
  // daemon can build a container in a project that was initialized long ago.
  if (existsSync(join(projectRoot, '.carto'))) ensureCartoIgnored(projectRoot);

  // Exit status alone isn't trustworthy: carto can exit 0 after a fatal
  // error, so the container's existence is the real success signal.
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

// The same re-index off the event loop, for callers (the daemon's watcher)
// that cannot block for the seconds a sync takes. Never rejects.
export function cartoSyncAsync(
  projectRoot: string,
  binary: CartoBinary
): Promise<CartoRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary.path, ['sync'], { cwd: projectRoot });
    } catch (err) {
      resolve({ ok: false, detail: (err as Error).message });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, detail: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, detail: 'synced' });
        return;
      }
      const detail = stderr.trim();
      resolve({
        ok: false,
        detail: detail !== '' ? detail : 'carto sync failed',
      });
    });
  });
}
