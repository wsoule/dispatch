import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateDirs(env: NodeJS.ProcessEnv): string[] {
  const fromPath = (env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  return [...fromPath, ...BREW_BIN_DIRS];
}

// Locates `carto`, runs `--version`, and gates on the 2.x floor. Returns a
// result rather than throwing: every caller's correct response to an absent
// or too-old carto is to degrade, not to fail.
export function discoverCarto(
  env: NodeJS.ProcessEnv = process.env
): CartoDiscovery {
  let found: string | null = null;
  for (const dir of candidateDirs(env)) {
    const candidate = join(dir, 'carto');
    if (existsSync(candidate) && isExecutableFile(candidate)) {
      found = candidate;
      break;
    }
  }
  if (found === null) {
    return { ok: false, reason: 'not-found', detail: 'no `carto` on PATH' };
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
