import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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
