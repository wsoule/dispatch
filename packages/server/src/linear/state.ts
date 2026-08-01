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

/** Display-only data for a linked issue. The UUID stays the join key; this is what a chip shows. */
export interface LinearIssueLink {
  identifier: string;
  url: string;
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
  /** Task ids a push could not send; re-included next pass so the cursor can still advance. */
  pushRetry: string[];
  echoes: EchoRecord[];
  /** Issue UUID -> its display identifier and URL, for clients that only hold `external`. */
  links: Record<string, LinearIssueLink>;
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
    pushRetry: [],
    echoes: [],
    links: {},
  };
}

// A missing or corrupt file reads as a fresh state, which re-establishes the link from
// scratch — a pass that reconciles nothing and pushes nothing.
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

const MIN_ECHO_TTL_MS = 60 * 60 * 1000;

// An echo only has to survive until the pull that would re-apply it, so the TTL
// tracks the poll interval — a floor of an hour, and never fewer than 3 polls.
export function echoTtlMs(intervalSec: number): number {
  return Math.max(MIN_ECHO_TTL_MS, intervalSec * 3 * 1000);
}

// Drops records past the TTL so the file cannot grow without bound, keeping the
// most recent ones when a single pass writes an unusual number of issues.
export function pruneEchoes(
  echoes: EchoRecord[],
  now: number,
  ttlMs: number = MIN_ECHO_TTL_MS
): EchoRecord[] {
  return echoes
    .filter((e) => now - Date.parse(e.recordedAt) < ttlMs)
    .slice(-2000);
}
