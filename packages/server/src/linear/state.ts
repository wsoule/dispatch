import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One issue this sync wrote, and the `updatedAt` the mutation returned for it. */
export interface EchoRecord {
  issueId: string;
  updatedAt: string;
  recordedAt: string;
}

export interface LinearSyncState {
  /** High-water mark for the pull filter; null until the first successful pull. */
  cursor: string | null;
  /** Set once the first sync has established the link, gating automatic issue creation. */
  bootstrappedAt: string | null;
  /** Stamped at the end of each push; a task edited before this is not re-pushed. */
  lastPushAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  echoes: EchoRecord[];
}

// Sync state is user-level, not project-level: `.dispatch/` is committed to the
// user's repo, so a cursor there would land in their git history.
function stateHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

/** `~/.dispatch/linear/<hash of rootDir>.json`, keyed the same way daemon files are. */
export function linearStatePath(rootDir: string): string {
  const key = createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
  return join(stateHome(), '.dispatch', 'linear', `${key}.json`);
}

export function emptyLinearState(): LinearSyncState {
  return {
    cursor: null,
    bootstrappedAt: null,
    lastPushAt: null,
    lastSyncAt: null,
    lastError: null,
    echoes: [],
  };
}

// A missing or corrupt file reads as a fresh state — the worst case is one
// redundant full pull, which is idempotent.
export function readLinearState(rootDir: string): LinearSyncState {
  const path = linearStatePath(rootDir);
  if (!existsSync(path)) return emptyLinearState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as
      | Partial<LinearSyncState>
      | undefined;
    return { ...emptyLinearState(), ...(parsed ?? {}) };
  } catch {
    return emptyLinearState();
  }
}

export function writeLinearState(
  rootDir: string,
  state: LinearSyncState
): void {
  const path = linearStatePath(rootDir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

const ECHO_TTL_MS = 60 * 60 * 1000;

// Echo records only matter until the pull that would have re-applied them, so an
// hour is generous; dropping the rest keeps the file from growing without bound.
export function pruneEchoes(echoes: EchoRecord[], now: number): EchoRecord[] {
  return echoes
    .filter((e) => now - Date.parse(e.recordedAt) < ECHO_TTL_MS)
    .slice(-500);
}
