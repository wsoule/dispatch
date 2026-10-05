import { childEnv } from '@dispatch-foo/core';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';

import type { ApiContext } from '../api.js';
import { rankFuzzy } from '../fuzzy.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';
import {
  isDirectory,
  resolveWorkspaceBase,
  resolveWorkspacePath,
} from './workspacePaths.js';

/**
 * The routes under /api/files — browse a checkout, open a file, save it back,
 * serve its bytes for preview, and find one by name.
 *
 * Every path is resolved through `resolveWorkspacePath`, so nothing here can
 * read or write outside the project or the run's worktree it names.
 *
 * Reads sit on the request tier like the rest of the read surface; writes sit
 * on `decide`. Writing is the asymmetry that matters: a run's edits are meant
 * to go through the orchestrator, which holds them to the task's declared
 * `writes` and records what changed. A general-purpose write route on the
 * agent token would be a way around all of that, so it takes the app token the
 * human holds.
 */

type FileRouteContext = Pick<ApiContext, 'rootDir'>;

// Past this a file is not opened in the editor. Two megabytes is far more than
// any source file and far less than the point where holding it as a string in
// the renderer becomes a problem.
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

// How much of a file is sniffed for a NUL byte. A text file has none anywhere;
// a binary almost always has one early, and reading the whole thing to be sure
// would mean loading every file twice.
const SNIFF_BYTES = 8192;

// Directories a name search never descends into. Not a correctness measure —
// the traversal guard is — but a search that walks node_modules is useless.
const SEARCH_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
]);

// Extensions the preview pane can render natively. Anything not here is
// offered as a download rather than shown.
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

function mimeForPath(path: string): string {
  return (
    MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
  );
}

/** What the preview pane should do with a file, decided by extension. */
function previewKindForPath(
  path: string
): 'image' | 'pdf' | 'video' | 'audio' | 'none' {
  const mime = mimeForPath(path);
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'none';
}

/** A NUL byte in the first few kilobytes is the usual binary tell. */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

interface DirEntry {
  name: string;
  /** Relative to the scope's base, so a client never handles absolute paths. */
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: string | null;
}

// Directories first, then names — the ordering every file tree uses, and
// `localeCompare` so `Foo` and `foo` sort together rather than by byte value.
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function toRelative(base: string, path: string): string {
  const rel = relative(base, path);
  // Posix separators on the wire, so a path from a Windows daemon still keys
  // the same tree node as one from macOS.
  return rel.split(sep).join('/');
}

/** `GET /api/files/tree` — one directory's children, for a lazily expanded tree. */
export function listDirectory(
  ctx: FileRouteContext,
  params: URLSearchParams
): Response {
  const resolved = resolveWorkspacePath(ctx.rootDir, {
    runId: params.get('runId'),
    path: params.get('path'),
  });
  if (!resolved.ok) return errorResponse(400, resolved.message);
  if (!isDirectory(resolved.path)) {
    return errorResponse(
      404,
      `not a directory: ${toRelative(resolved.base, resolved.path)}`
    );
  }

  const entries: DirEntry[] = [];
  for (const dirent of readdirSync(resolved.path, { withFileTypes: true })) {
    const full = join(resolved.path, dirent.name);
    let size = 0;
    let modifiedAt: string | null = null;
    try {
      const stat = statSync(full);
      size = stat.size;
      modifiedAt = stat.mtime.toISOString();
    } catch {
      // A symlink to nowhere, or a file removed between readdir and stat.
      // Listing it without a size beats dropping it from the tree.
    }
    entries.push({
      name: dirent.name,
      path: toRelative(resolved.base, full),
      kind: dirent.isDirectory() ? 'directory' : 'file',
      size,
      modifiedAt,
    });
  }

  return jsonResponse({
    path: toRelative(resolved.base, resolved.path),
    runId: resolved.runId,
    entries: entries.sort(compareEntries),
  });
}

/** `GET /api/files/read` — a file's text, or a description of why it has none. */
export function readFile(
  ctx: FileRouteContext,
  params: URLSearchParams
): Response {
  const resolved = resolveWorkspacePath(ctx.rootDir, {
    runId: params.get('runId'),
    path: params.get('path'),
  });
  if (!resolved.ok) return errorResponse(400, resolved.message);
  if (!existsSync(resolved.path) || isDirectory(resolved.path)) {
    return errorResponse(404, 'no such file');
  }

  const stat = statSync(resolved.path);
  const relPath = toRelative(resolved.base, resolved.path);
  const preview = previewKindForPath(resolved.path);
  const base = {
    path: relPath,
    runId: resolved.runId,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    mime: mimeForPath(resolved.path),
    preview,
  };

  if (stat.size > MAX_EDITABLE_BYTES) {
    // Deliberately still a 200: "too big to edit" is a fact about the file the
    // UI renders, not a failed request.
    return jsonResponse({ ...base, kind: 'too-large', text: null });
  }

  const bytes = readFileSync(resolved.path);
  if (looksBinary(bytes)) {
    return jsonResponse({ ...base, kind: 'binary', text: null });
  }
  return jsonResponse({ ...base, kind: 'text', text: bytes.toString('utf8') });
}

/** `POST /api/files/write` — save an edited file. */
export async function writeFile(
  req: Request,
  ctx: FileRouteContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;

  if (typeof body.path !== 'string' || body.path === '') {
    return errorResponse(400, 'path is required');
  }
  if (typeof body.text !== 'string') {
    return errorResponse(400, 'text must be a string');
  }
  const resolved = resolveWorkspacePath(ctx.rootDir, {
    runId: body.runId,
    path: body.path,
  });
  if (!resolved.ok) return errorResponse(400, resolved.message);
  if (isDirectory(resolved.path)) {
    return errorResponse(400, 'path is a directory');
  }

  // A new file under a directory that does not exist yet is a normal save from
  // the editor, so the parents are created rather than 404'd.
  mkdirSync(dirname(resolved.path), { recursive: true });
  writeFileSync(resolved.path, body.text, 'utf8');
  const stat = statSync(resolved.path);
  return jsonResponse({
    path: toRelative(resolved.base, resolved.path),
    runId: resolved.runId,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  });
}

/** `GET /api/files/raw` — the bytes, for an image or PDF preview. */
export function rawFile(
  ctx: FileRouteContext,
  params: URLSearchParams
): Response {
  const resolved = resolveWorkspacePath(ctx.rootDir, {
    runId: params.get('runId'),
    path: params.get('path'),
  });
  if (!resolved.ok) return errorResponse(400, resolved.message);
  if (!existsSync(resolved.path) || isDirectory(resolved.path)) {
    return errorResponse(404, 'no such file');
  }
  return new Response(readFileSync(resolved.path), {
    headers: {
      'content-type': mimeForPath(resolved.path),
      // The bytes are served from the user's own checkout and can change under
      // an open preview, so nothing may cache them.
      'cache-control': 'no-store',
      // Belt and braces for the SVG case: an SVG is a document, and serving one
      // inline from the daemon's origin would let it script against the API.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Every file a name search should consider, in the given scope.
 *
 * `git ls-files -co --exclude-standard` rather than a directory walk: it is
 * one process instead of thousands of syscalls, and it already honours
 * `.gitignore`, so build output and dependencies are excluded by the same
 * rules the user already maintains. `-c` is the tracked set and `-o` the
 * untracked one, so a file created moments ago is findable.
 *
 * The walk below is the fallback for a directory that is not a git checkout at
 * all. It is bounded in both depth and count, because without `.gitignore` to
 * lean on there is nothing to stop it descending into a dependency tree.
 */
async function listSearchCandidates(base: string): Promise<string[]> {
  const proc = Bun.spawn(
    ['git', 'ls-files', '-c', '-o', '--exclude-standard', '-z'],
    { cwd: base, env: childEnv(), stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode === 0) {
    return stdout.split('\0').filter((path) => path !== '');
  }
  return walkForCandidates(base);
}

const WALK_MAX_ENTRIES = 20000;
const WALK_MAX_DEPTH = 12;

function walkForCandidates(base: string): string[] {
  const found: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    if (next.depth > WALK_MAX_DEPTH || found.length >= WALK_MAX_ENTRIES)
      continue;
    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped rather than failing the search.
      continue;
    }
    for (const entry of entries) {
      if (SEARCH_SKIP.has(entry.name)) continue;
      const full = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: next.depth + 1 });
      } else if (found.length < WALK_MAX_ENTRIES) {
        found.push(toRelative(base, full));
      }
    }
  }
  return found;
}

/**
 * `GET /api/files/search` — quick open.
 *
 * An empty query returns the first page of candidates rather than nothing, so
 * the picker has something to show before the user types.
 */
export async function searchFiles(
  ctx: FileRouteContext,
  params: URLSearchParams
): Promise<Response> {
  const scope = resolveWorkspaceBase(ctx.rootDir, params.get('runId'));
  if (!scope.ok) return errorResponse(400, scope.message);

  const query = params.get('q') ?? '';
  const rawLimit = Number(params.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 200)
      : 50;

  const candidates = await listSearchCandidates(scope.base);
  const ranked = rankFuzzy(query, candidates, (path) => path, limit);
  return jsonResponse({
    runId: scope.runId,
    query,
    total: candidates.length,
    results: ranked.map((entry) => ({
      path: entry.value,
      score: entry.score,
      positions: entry.positions,
    })),
  });
}
