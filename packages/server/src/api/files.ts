import { childEnv } from '@dispatch-foo/core';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

import type { ApiContext } from '../api.js';
import { rankFuzzy } from '../fuzzy.js';
import type { DownloadTickets } from './downloadTickets.js';
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

// Headers every response carrying a file's bytes gets, preview or download.
// The bytes are served from the user's own checkout and can change under an
// open preview, so nothing may cache them. The CSP is belt and braces for the
// SVG case: an SVG is a document, and serving one from the daemon's origin
// would otherwise let it script against the API.
function rawFileHeaders(path: string): Record<string, string> {
  return {
    'content-type': mimeForPath(path),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  };
}

// The raw route's not-found answer, for a path that is missing or not a
// regular file, whether that is found before or after the route answers.
function noSuchFile(): Response {
  return errorResponse(404, 'no such file');
}

// How long after the raw route hands Bun a file body an ENOENT from opening
// that path is still taken to be that body's. Bun opens the file as it starts
// writing the response, a few milliseconds after the route returns; the
// margin covers a daemon starved of CPU in between.
const FILE_BODY_OPEN_GRACE_MS = 30_000;
// The most file bodies remembered at once, so a burst of previews cannot grow
// the list without bound. Past it the oldest are forgotten, and a deletion
// racing one of them gets the opaque 500 again.
const MAX_PENDING_FILE_BODIES = 1024;

interface PendingFileBody {
  path: string;
  // The headers object of the response the body went out on. index.ts adds
  // the CORS headers to it in place after the route returns, so the 404 that
  // replaces the response can carry the same ones.
  headers: Headers;
  // performance.now() when the route answered: tests move Date, not this.
  at: number;
}

// File bodies the raw route handed to Bun.serve, oldest first. Bun opens a
// `Bun.file` body by path only once it starts sending it, and if the file was
// deleted after the route's stat it throws ENOENT into the server's error
// handler, which cannot see the request. This list is how that handler knows
// the ENOENT is a raw-route file that vanished (see goneFileBodyResponse).
const pendingFileBodies: PendingFileBody[] = [];

// Forgets the bodies past the grace period, and the oldest past the cap.
function forgetStaleFileBodies(now: number): void {
  while (
    pendingFileBodies.length > 0 &&
    (pendingFileBodies.length > MAX_PENDING_FILE_BODIES ||
      now - pendingFileBodies[0].at > FILE_BODY_OPEN_GRACE_MS)
  ) {
    pendingFileBodies.shift();
  }
}

// The CORS headers (access-control-* and vary) a response carries, in header
// order: what a gone-file 404 may copy from the body it replaces.
function corsHeaders(headers: Headers): [string, string][] {
  const cors: [string, string][] = [];
  for (const [name, value] of headers) {
    if (name.startsWith('access-control-') || name === 'vary') {
      cors.push([name, value]);
    }
  }
  return cors;
}

/**
 * The raw route's 404 for an error Bun.serve raised while opening a file body
 * the route handed it, or null for any other error. index.ts's error handler
 * asks this first.
 *
 * The route stats the file, then returns a `Bun.file` that Bun opens later,
 * when it starts the response. A file deleted in between (a checkout switching
 * branches, an agent cleaning up) makes that open fail with ENOENT, which Bun
 * hands to the server's error handler instead of to the route; without this
 * the client got an opaque 500 for what is a plain not-found.
 *
 * The error names only the path, not the request, and a body stays listed
 * after Bun has sent it, so several bodies for one path can be waiting. The
 * newest one is forgotten, since it is the one Bun opens next. The 404 keeps
 * the CORS headers only when every waiting body for that path carries the
 * same ones, so the desktop webview can read it; when they differ (two
 * origins, or a browser tab and the webview) it has none, as the 500 had,
 * since one request's CORS grant must never answer another's.
 */
export function goneFileBodyResponse(err: unknown): Response | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, syscall, path } = err as {
    code?: unknown;
    syscall?: unknown;
    path?: unknown;
  };
  if (code !== 'ENOENT' || syscall !== 'open' || typeof path !== 'string') {
    return null;
  }
  forgetStaleFileBodies(performance.now());
  const newest = pendingFileBodies.findLastIndex((body) => body.path === path);
  if (newest === -1) return null;
  const grants = pendingFileBodies
    .filter((body) => body.path === path)
    .map((body) => JSON.stringify(corsHeaders(body.headers)));
  const [body] = pendingFileBodies.splice(newest, 1);
  const res = noSuchFile();
  if (grants.every((grant) => grant === grants[0])) {
    for (const [name, value] of corsHeaders(body.headers)) {
      res.headers.set(name, value);
    }
  }
  return res;
}

/**
 * A 200 carrying the file at `path` with the raw route's headers plus
 * `extra`, or a 404 when it is gone or not a regular file.
 *
 * The body is a `Bun.file`, which Bun.serve streams from disk (sendfile on a
 * plain socket, chunked reads under TLS) rather than holding the file in the
 * daemon's memory. Content-Length is stated here from a fresh stat so that
 * compressForNetwork can tell a file from an API reply; Bun sends the size it
 * actually streams, so a file that changes in between is never mislabelled.
 *
 * Opening the file here and serving the descriptor would close the window
 * before Bun's own open, but Bun never closes a descriptor it was given and
 * says nothing when it is done with one, and a JS stream over it loses both
 * sendfile and the Content-Length (Bun sends any JS stream chunked). So the
 * body stays a path, and a file deleted before Bun opens it is answered by
 * goneFileBodyResponse instead.
 */
function streamedFileResponse(
  path: string,
  extra: Record<string, string> = {}
): Response {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return noSuchFile();
    size = stat.size;
  } catch {
    return noSuchFile();
  }
  const res = new Response(Bun.file(path), {
    headers: {
      ...rawFileHeaders(path),
      'content-length': String(size),
      ...extra,
    },
  });
  const now = performance.now();
  pendingFileBodies.push({ path, headers: res.headers, at: now });
  forgetStaleFileBodies(now);
  return res;
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
  return streamedFileResponse(resolved.path);
}

// RFC 5987 percent-encoding for `filename*`: encodeURIComponent leaves
// `'()*` alone, and those are not attr-chars, so they are escaped too.
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * The Content-Disposition for downloading `path`: always an attachment, named
 * after the file. The quoted `filename` is printable ASCII only, with quotes,
 * backslashes and anything else that could end the header value or the
 * parameter turned into `_`; the exact name travels in `filename*`.
 */
export function attachmentDisposition(path: string): string {
  const name = basename(path);
  const ascii = name.replace(/[^\x20-\x7e]|["\\;%]/g, '_').trim();
  const fallback = ascii === '' ? 'download' : ascii;
  let exact: string;
  try {
    exact = rfc5987(name);
  } catch {
    // A name with an unpaired surrogate cannot be UTF-8 encoded; the ASCII
    // fallback alone still names the download.
    return `attachment; filename="${fallback}"`;
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
}

/**
 * `POST /api/files/download-ticket` — a one-time URL for downloading a file.
 *
 * Body `{ path, runId? }`, checked by the same resolver, against the same
 * project or run worktree, as `GET /api/files/raw`. Answers
 * `{ ticket, expiresAt }`; `GET /api/files/raw?ticket=<ticket>` then serves
 * the file once without a bearer header (see downloadTickets.ts).
 * `stillAuthorized` re-checks the caller's credential when the ticket is used.
 */
export async function issueDownloadTicket(
  req: Request,
  ctx: FileRouteContext,
  tickets: DownloadTickets,
  stillAuthorized: () => boolean
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;
  if (typeof body.path !== 'string' || body.path === '') {
    return errorResponse(400, 'path is required');
  }
  if (
    body.runId !== undefined &&
    body.runId !== null &&
    typeof body.runId !== 'string'
  ) {
    return errorResponse(400, 'runId must be a string');
  }
  const resolved = resolveWorkspacePath(ctx.rootDir, {
    runId: body.runId,
    path: body.path,
  });
  if (!resolved.ok) return errorResponse(400, resolved.message);
  if (!existsSync(resolved.path) || isDirectory(resolved.path)) {
    return errorResponse(404, 'no such file');
  }
  const issued = tickets.issue({
    runId: resolved.runId,
    path: body.path,
    resolvedPath: resolved.path,
    stillAuthorized,
  });
  return jsonResponse(issued, 201);
}

// Why a ticket was not honoured. One message for every way a ticket can be
// dead, so a caller learns nothing about which tickets exist.
const DEAD_TICKET = 'download ticket is unknown, already used or expired';

function ticketRefused(message: string, code: string): Response {
  return jsonResponse({ error: message, code }, 403);
}

/**
 * `GET /api/files/raw?ticket=<ticket>` — the file a download ticket names,
 * streamed once as an attachment. No bearer header: the ticket is the
 * credential, and it dies here whether or not the download succeeds.
 *
 * The path is resolved again, through the same resolver, from what the ticket
 * was issued for, so it stays inside the project or the run's worktree: a
 * symlink swapped in meanwhile that points outside is refused. The comparison
 * with the path resolved at issue is textual (the resolver does not follow
 * links), so a link swapped in to another file inside the same root is
 * served, which the holder could have asked a ticket for anyway. A `path` or
 * `runId` on the URL must name that same file.
 */
export function downloadWithTicket(
  ctx: FileRouteContext,
  tickets: DownloadTickets,
  params: URLSearchParams
): Response {
  const grant = tickets.take(params.get('ticket') ?? '');
  if (grant === null) return ticketRefused(DEAD_TICKET, 'download_ticket_dead');
  if (!grant.stillAuthorized()) {
    return ticketRefused(
      'the credential this download ticket was issued to no longer reaches this file',
      'download_ticket_revoked'
    );
  }
  if (params.has('path') || params.has('runId')) {
    const named = resolveWorkspacePath(ctx.rootDir, {
      runId: params.get('runId'),
      path: params.get('path'),
    });
    if (!named.ok || named.path !== grant.resolvedPath) {
      return ticketRefused(
        'this download ticket is for a different file',
        'download_ticket_wrong_path'
      );
    }
  }
  const resolved = resolveWorkspacePath(ctx.rootDir, {
    runId: grant.runId,
    path: grant.path,
  });
  if (!resolved.ok) return errorResponse(400, resolved.message);
  if (resolved.path !== grant.resolvedPath) {
    return ticketRefused(
      'this download ticket is for a different file',
      'download_ticket_wrong_path'
    );
  }
  return streamedFileResponse(resolved.path, {
    'content-disposition': attachmentDisposition(resolved.path),
    // The URL carries the ticket; a dead one, but no page needs to see it.
    'referrer-policy': 'no-referrer',
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
