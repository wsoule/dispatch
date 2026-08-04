import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { runsDir } from './paths.js';
import { Transcript } from './transcript.js';

/** One file that independent runs keep going back to. */
export interface FileHotspot {
  /** Repo-relative path, e.g. `packages/server/src/api.ts`. */
  path: string;
  /** How many distinct runs touched it. */
  runs: number;
}

export interface HotspotOptions {
  /** A file has to appear in at least this many distinct runs to count. */
  minRuns?: number;
  /** How many hotspots to keep, highest run count first. */
  limit?: number;
  /** How many transcripts to scan, newest first. */
  scanLimit?: number;
}

const DEFAULT_MIN_RUNS = 3;
const DEFAULT_LIMIT = 12;
const DEFAULT_SCAN_LIMIT = 40;

// A transcript is one run's whole log, and Transcript.read() loads and
// JSON-parses the whole file. This runs on the dispatch path, where the cost is
// paid before the run starts, so the two bounds are picked to keep the absolute
// worst case (SCAN_LIMIT files all at the ceiling) tolerable rather than to fit
// any real transcript — this project's largest is ~45KB. A run long enough to
// blow past 2MB is skipped rather than truncated: its file paths are already
// well represented by the other runs that touched the same shared ground.
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

// Tool inputs that name a file the agent opened or changed. `Bash` is
// deliberately absent: its commands mention paths in prose that can't be
// distinguished from arguments without parsing a shell grammar.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

// Paths that say nothing an orientation section doesn't already say better.
// `.agents/` is the skills index (rendered from frontmatter instead) and the
// gitignored scratch dir; the rest are build output and vendored code.
function isNoise(path: string): boolean {
  return (
    path.startsWith('.agents/') ||
    path.includes('node_modules/') ||
    path.startsWith('dist/') ||
    path.includes('/dist/')
  );
}

// Tool inputs are `unknown` on NormalizedEntry, so the file path is dug out
// defensively — a shape we don't recognise contributes nothing rather than
// throwing on the dispatch path.
function filePathFrom(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>).file_path;
  return typeof value === 'string' && value !== '' ? value : null;
}

// Absolute worktree paths are meaningless to the next run (its worktree lives
// somewhere else), so they're rebased onto the repo root using the worktree
// path the transcript's own header recorded.
function toRepoRelative(
  absolute: string,
  worktreePath: string | undefined
): string | null {
  if (worktreePath === undefined || worktreePath === '') return null;
  const prefix = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`;
  if (!absolute.startsWith(prefix)) return null;
  return absolute.slice(prefix.length);
}

// The transcripts to scan, newest first — a project accumulates them forever
// and the oldest ones describe a repo layout that has since moved.
function recentTranscripts(dir: string, scanLimit: number): string[] {
  if (!existsSync(dir)) return [];
  const files: { path: string; mtimeMs: number; size: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      files.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // A transcript removed between readdir and stat is simply not scanned.
    }
  }
  return files
    .filter((f) => f.size <= MAX_TRANSCRIPT_BYTES)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, scanLimit)
    .map((f) => f.path);
}

// Every repo-relative file one run opened or edited, deduped — a run that reads
// api.ts thirty times is still one run's worth of evidence that api.ts matters.
function filesTouchedByRun(path: string): Set<string> {
  const touched = new Set<string>();
  let worktreePath: string | undefined;
  for (const line of new Transcript(path).read()) {
    if (line.type === 'header') {
      worktreePath = line.meta.worktreePath;
      continue;
    }
    if (line.type !== 'entry') continue;
    const { kind, toolName, toolInput } = line.entry;
    if (kind !== 'tool' || toolName === undefined) continue;
    if (!FILE_TOOLS.has(toolName)) continue;
    const absolute = filePathFrom(toolInput);
    if (absolute === null) continue;
    const relative = toRepoRelative(absolute, worktreePath);
    if (relative === null || isNoise(relative)) continue;
    touched.add(relative);
  }
  return touched;
}

/**
 * Mines this project's own run transcripts for the files independent runs keep
 * re-reading, so the next run is told about them instead of rediscovering them.
 *
 * The signal is *how many distinct runs* touched a file, never how often —
 * counting raw touches would just rank whatever the longest run happened to
 * grind on. Reading is best-effort throughout: an unreadable transcript costs
 * its own evidence and nothing else, because this feeds prompt construction and
 * a throw there strands the run in `provisioning`.
 */
export function collectHotspots(
  rootDir: string,
  options: HotspotOptions = {}
): FileHotspot[] {
  const minRuns = options.minRuns ?? DEFAULT_MIN_RUNS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;

  const runsPerFile = new Map<string, number>();
  for (const path of recentTranscripts(runsDir(rootDir), scanLimit)) {
    let touched: Set<string>;
    try {
      touched = filesTouchedByRun(path);
    } catch {
      continue;
    }
    for (const file of touched) {
      runsPerFile.set(file, (runsPerFile.get(file) ?? 0) + 1);
    }
  }

  return (
    [...runsPerFile]
      .filter(([, runs]) => runs >= minRuns)
      .map(([path, runs]) => ({ path, runs }))
      // Ties broken by path so the rendered list — and its snapshot — is stable.
      .sort((a, b) =>
        b.runs === a.runs ? a.path.localeCompare(b.path) : b.runs - a.runs
      )
      .slice(0, limit)
  );
}
