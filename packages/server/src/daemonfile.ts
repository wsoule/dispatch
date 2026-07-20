import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One JSON file per project root, so `dispatch serve`/`ui` invocations against
// the same rootDir find (or overwrite) the same daemon record without a
// central registry process.
export interface DaemonFileInfo {
  port: number;
  pid: number;
  rootDir: string;
  startedAt: string;
}

// `DISPATCH_HOME` lets tests (and anything else) redirect daemon files away
// from the real home directory; production use always falls back to it. An
// empty string is treated the same as unset — kept in sync with this exact
// function's mirrors in packages/cli/src/commands/daemon.ts and
// apps/desktop/src-tauri/src/sidecar.rs's `daemon_home`; update all three
// together if this scheme ever changes.
function daemonHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

function daemonsDir(): string {
  return join(daemonHome(), '.dispatch', 'daemons');
}

// Daemon files are keyed by a short hash of the absolute rootDir rather than
// the path itself, so filenames stay short and filesystem-safe regardless of
// where a project lives.
export function daemonFileKey(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

export function daemonFilePath(rootDir: string): string {
  return join(daemonsDir(), `${daemonFileKey(rootDir)}.json`);
}

export function writeDaemonFile(info: DaemonFileInfo): void {
  mkdirSync(daemonsDir(), { recursive: true });
  writeFileSync(daemonFilePath(info.rootDir), JSON.stringify(info, null, 2));
}

export function readDaemonFile(rootDir: string): DaemonFileInfo | null {
  const path = daemonFilePath(rootDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as DaemonFileInfo;
}

// Removing on shutdown is what lets `dispatch ui` distinguish "no daemon" from
// "daemon crashed without cleanup" (the latter still leaves a stale file whose
// /api/health will simply fail to respond — a later slice's concern).
export function removeDaemonFile(rootDir: string): void {
  const path = daemonFilePath(rootDir);
  if (existsSync(path)) rmSync(path);
}
