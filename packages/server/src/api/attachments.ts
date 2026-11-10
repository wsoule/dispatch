import {
  ATTACHMENT_MAX_BYTES,
  attachmentRelativePath,
  attachmentsDir,
  ensureProjectGitignore,
  sanitizeAttachmentName,
} from '@dispatch-foo/core';
import type { TaskAttachment, TaskDoc } from '@dispatch-foo/core';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import type { ApiContext } from '../api.js';
import {
  OVERSEER_ATTACHMENTS_DIR,
  type OverseerAttachment,
} from '../orchestrator/overseer.js';
import { errorResponse, jsonResponse } from './http.js';

// The four attachment routes under /api/tasks/:id/attachments. The bytes live
// under `.dispatch/attachments/<taskId>/` on this machine; the task's
// frontmatter (or row) carries the list, so every write ends with the same
// cache refresh and `task.changed` broadcast a PATCH performs.

// The slice of ApiContext these routes touch, so a test can drive them with
// a store and a fake event bus.
type AttachmentRouteContext = Pick<
  ApiContext,
  'rootDir' | 'store' | 'cache' | 'events'
>;

// Resolves `name` inside the task's attachments directory, or null when the
// name is unusable or the resolved path escapes the directory. Every route
// goes through this before a name touches the filesystem.
function attachmentTarget(
  ctx: AttachmentRouteContext,
  id: string,
  rawName: string
): { name: string; dir: string; path: string } | null {
  const name = sanitizeAttachmentName(rawName);
  if (name === null) return null;
  const dir = resolve(attachmentsDir(ctx.rootDir, id));
  const path = resolve(dir, name);
  if (!path.startsWith(dir + sep)) return null;
  return { name, dir, path };
}

// A path segment as the URL carried it; a malformed escape is just a name
// nothing will match.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// A multipart request may carry several files, each under the per-file cap;
// this is the ceiling on the request as a whole, a guard against a runaway
// body rather than a limit the desktop (one request per file) ever meets.
const UPLOAD_REQUEST_MAX_BYTES = ATTACHMENT_MAX_BYTES * 4;

// `spec.png` already taken becomes `spec (2).png`, then `spec (3).png`. The
// comparison folds case: APFS and NTFS would let `Spec.png` overwrite
// `spec.png` on disk while the list carried both.
function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// RFC 5987 content-disposition: header values are Latin-1, so a Cyrillic or
// emoji name goes in `filename*` UTF-8 encoded, next to an ASCII fallback.
function contentDisposition(name: string): string {
  const ascii = name
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Nothing but an extension left (a non-Latin stem such as Cyrillic, `.png` after sanitizing) gets a stem.
  const fallback =
    ascii === '' || ascii.startsWith('.') ? `attachment${ascii}` : ascii;
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function persistList(
  ctx: AttachmentRouteContext,
  id: string,
  attachments: TaskAttachment[]
): TaskDoc {
  const doc = ctx.store.update(id, { attachments });
  ctx.cache.refresh(ctx.store, [id]);
  ctx.events.broadcast({ type: 'task.changed', ids: [id] });
  return doc;
}

// POST /api/tasks/:id/attachments — multipart upload of one or more files
// under the `files` field. Names are sanitized, de-duplicated against the
// task's list and written before the list is patched, so a failed write never
// leaves a dangling entry.
export async function uploadTaskAttachments(
  req: Request,
  ctx: AttachmentRouteContext,
  id: string
): Promise<Response> {
  const task = ctx.store.get(id);
  if (task === null) return errorResponse(404, `task not found: ${id}`);
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > UPLOAD_REQUEST_MAX_BYTES) {
    return errorResponse(413, 'upload exceeds the 100 MB request limit');
  }
  let entries: unknown[];
  try {
    entries = (await req.formData()).getAll('files');
  } catch {
    return errorResponse(400, 'expected a multipart form with files');
  }
  const files = entries.filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return errorResponse(400, 'no files were uploaded');
  for (const file of files) {
    if (file.size > ATTACHMENT_MAX_BYTES) {
      return errorResponse(413, `${file.name} exceeds the 25 MB limit`);
    }
  }

  // A files-backed project only gets its ignore rules from `dispatch init`,
  // so the first upload tops them up: the blobs must never reach a commit.
  // The machine-local group is the same on both backends, so `files` is
  // right whichever one is live.
  ensureProjectGitignore(ctx.rootDir, 'files');

  const existing = task.meta.attachments ?? [];
  const taken = new Set(existing.map((a) => a.name.toLowerCase()));
  const added: TaskAttachment[] = [];
  for (const file of files) {
    const clean = sanitizeAttachmentName(file.name);
    if (clean === null) {
      return errorResponse(400, `invalid attachment name: ${file.name}`);
    }
    const target = attachmentTarget(ctx, id, dedupeName(clean, taken));
    if (target === null) {
      return errorResponse(400, `invalid attachment name: ${file.name}`);
    }
    mkdirSync(target.dir, { recursive: true });
    await Bun.write(target.path, file);
    taken.add(target.name.toLowerCase());
    added.push({
      name: target.name,
      path: attachmentRelativePath(id, target.name),
      size: file.size,
      addedAt: new Date().toISOString(),
    });
  }
  return jsonResponse(persistList(ctx, id, [...existing, ...added]));
}

// GET /api/tasks/:id/attachments
export function listTaskAttachments(
  ctx: AttachmentRouteContext,
  id: string
): Response {
  const task = ctx.store.get(id);
  if (task === null) return errorResponse(404, `task not found: ${id}`);
  return jsonResponse({ attachments: task.meta.attachments ?? [] });
}

// GET /api/tasks/:id/attachments/:name — the bytes, when this machine has
// them. A file-backed teammate who pulled the frontmatter without the blob
// gets a 404 rather than a stream that never starts. HEAD answers the same
// status with no body, so a client can ask before opening the path locally.
export function downloadTaskAttachment(
  ctx: AttachmentRouteContext,
  id: string,
  rawName: string,
  method: 'GET' | 'HEAD' = 'GET'
): Response {
  const res = resolveDownload(ctx, id, rawName);
  if (method === 'GET') return res;
  return new Response(null, { status: res.status, headers: res.headers });
}

function resolveDownload(
  ctx: AttachmentRouteContext,
  id: string,
  rawName: string
): Response {
  const task = ctx.store.get(id);
  if (task === null) return errorResponse(404, `task not found: ${id}`);
  const target = attachmentTarget(ctx, id, decodeSegment(rawName));
  if (target === null) return errorResponse(400, 'invalid attachment name');
  const listed = (task.meta.attachments ?? []).some(
    (a) => a.name === target.name
  );
  if (!listed || !existsSync(target.path)) {
    return errorResponse(404, `attachment not found: ${target.name}`);
  }
  return new Response(Bun.file(target.path), {
    headers: { 'content-disposition': contentDisposition(target.name) },
  });
}

// DELETE /api/tasks/:id/attachments/:name — unlinks the blob (a missing file
// is not an error: the entry may have arrived from another machine) and drops
// the entry from the list.
export function removeTaskAttachment(
  ctx: AttachmentRouteContext,
  id: string,
  rawName: string
): Response {
  const task = ctx.store.get(id);
  if (task === null) return errorResponse(404, `task not found: ${id}`);
  const target = attachmentTarget(ctx, id, decodeSegment(rawName));
  if (target === null) return errorResponse(400, 'invalid attachment name');
  const existing = task.meta.attachments ?? [];
  if (!existing.some((a) => a.name === target.name)) {
    return errorResponse(404, `attachment not found: ${target.name}`);
  }
  try {
    unlinkSync(target.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return jsonResponse(
    persistList(
      ctx,
      id,
      existing.filter((a) => a.name !== target.name)
    )
  );
}

// Overseer (chat) attachments: a file a human pastes or picks in the composer
// is uploaded first, then named by the message that carries it. Each upload
// gets its own directory under OVERSEER_ATTACHMENTS_DIR, so two `image.png`
// pastes never collide and a path in a message pins exactly one blob.

// One upload directory's name: random, and the only shape a path may carry.
const OVERSEER_UPLOAD_ID = /^[0-9a-f]{12}$/;

// The type a browser reported, else Bun's guess from the extension, without
// parameters (`text/plain;charset=utf-8` is `text/plain`).
function mimeTypeOf(file: File, name: string): string {
  const type = file.type !== '' ? file.type : Bun.file(name).type;
  const bare = type.split(';')[0].trim();
  return bare === '' ? 'application/octet-stream' : bare;
}

// Writes a multipart request's `files` each into its own random directory
// under `dir` (project-relative), so two `image.png` pastes never collide.
// Answers the entries written, or the error response when the request is too
// big, malformed, or names a file no attachment may be called. Shared by the
// overseer's and a run's upload routes, which differ only in where blobs land.
async function writeUploads(
  req: Request,
  rootDir: string,
  dir: string
): Promise<OverseerAttachment[] | Response> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > UPLOAD_REQUEST_MAX_BYTES) {
    return errorResponse(413, 'upload exceeds the 100 MB request limit');
  }
  let entries: unknown[];
  try {
    entries = (await req.formData()).getAll('files');
  } catch {
    return errorResponse(400, 'expected a multipart form with files');
  }
  const files = entries.filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return errorResponse(400, 'no files were uploaded');
  for (const file of files) {
    if (file.size > ATTACHMENT_MAX_BYTES) {
      return errorResponse(413, `${file.name} exceeds the 25 MB limit`);
    }
    if (sanitizeAttachmentName(file.name) === null) {
      return errorResponse(400, `invalid attachment name: ${file.name}`);
    }
  }
  ensureProjectGitignore(rootDir, 'files');
  const attachments: OverseerAttachment[] = [];
  for (const file of files) {
    const name = sanitizeAttachmentName(file.name) as string;
    const uploadId = randomBytes(6).toString('hex');
    const path = `${dir}/${uploadId}/${name}`;
    const absolute = resolve(rootDir, path);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    await Bun.write(absolute, file);
    attachments.push({
      name,
      path,
      size: file.size,
      mimeType: mimeTypeOf(file, name),
    });
  }
  return attachments;
}

// POST /api/overseer/attachments — multipart upload under `files`. Answers
// `{ attachments }`, the entries the next message's body may carry.
export async function uploadOverseerAttachments(
  req: Request,
  rootDir: string
): Promise<Response> {
  const written = await writeUploads(req, rootDir, OVERSEER_ATTACHMENTS_DIR);
  if (written instanceof Response) return written;
  return jsonResponse({ attachments: written });
}

/** Where files attached to a run's follow-up messages live, relative to the
 *  project root; one directory per run under it. */
const RUN_ATTACHMENTS_DIR = '.dispatch/attachments/runs';

// A run id as the orchestrator mints them, and the only shape that may name a
// directory: no dots or separators, so it can never climb out of the root.
const RUN_ID = /^[A-Za-z0-9_-]+$/;

/** A file uploaded for a run's next follow-up. Unlike an overseer attachment
 *  the path is absolute: the message body names it for an agent whose working
 *  directory is a worktree, not the project root. */
export interface RunAttachment {
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

// POST /api/runs/:id/attachments — multipart upload under `files`, for a file
// dropped, pasted or picked in a run's follow-up composer. Run messages are
// plain text on the bus, so the desktop lists each answered `path` in the
// message body; the agent reads the files from there.
export async function uploadRunAttachments(
  req: Request,
  rootDir: string,
  runId: string
): Promise<Response> {
  if (!RUN_ID.test(runId)) return errorResponse(400, 'invalid run id');
  const written = await writeUploads(
    req,
    rootDir,
    `${RUN_ATTACHMENTS_DIR}/${runId}`
  );
  if (written instanceof Response) return written;
  const attachments: RunAttachment[] = written.map((a) => ({
    ...a,
    path: resolve(rootDir, a.path),
  }));
  return jsonResponse({ attachments });
}

// The blob behind an overseer attachment path, or null when the path is not
// one this daemon's upload route could have written.
function overseerAttachmentFile(rootDir: string, path: string): string | null {
  const prefix = `${OVERSEER_ATTACHMENTS_DIR}/`;
  if (!path.startsWith(prefix)) return null;
  const [uploadId, rawName, ...rest] = path.slice(prefix.length).split('/');
  if (rest.length > 0 || uploadId === undefined || rawName === undefined) {
    return null;
  }
  if (!OVERSEER_UPLOAD_ID.test(uploadId)) return null;
  const name = sanitizeAttachmentName(rawName);
  if (name === null || name !== rawName) return null;
  const dir = resolve(rootDir, OVERSEER_ATTACHMENTS_DIR, uploadId);
  const file = resolve(dir, name);
  return file.startsWith(dir + sep) ? file : null;
}

// GET /api/overseer/attachments/:uploadId/:name — the bytes, for the chat's
// thumbnails and downloads.
export function downloadOverseerAttachment(
  rootDir: string,
  uploadId: string,
  rawName: string
): Response {
  const name = decodeSegment(rawName);
  const file = overseerAttachmentFile(
    rootDir,
    `${OVERSEER_ATTACHMENTS_DIR}/${uploadId}/${name}`
  );
  if (file === null) return errorResponse(400, 'invalid attachment path');
  if (!existsSync(file)) {
    return errorResponse(404, `attachment not found: ${name}`);
  }
  return new Response(Bun.file(file), {
    headers: { 'content-disposition': contentDisposition(name) },
  });
}

// A message body's `attachments`: absent means none; otherwise every entry
// must name a blob the upload route wrote and that is still on disk. Size and
// type are taken from the request but the path is what the daemon trusts.
export function readOverseerAttachments(
  value: unknown,
  rootDir: string
):
  | { ok: true; attachments: OverseerAttachment[] }
  | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, attachments: [] };
  const invalid = (why: string) => ({
    ok: false as const,
    response: errorResponse(400, `invalid attachments: ${why}`),
  });
  if (!Array.isArray(value)) return invalid('expected an array');
  const attachments: OverseerAttachment[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return invalid('each entry must be an object');
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== 'string') {
      return invalid('each entry needs a path');
    }
    const file = overseerAttachmentFile(rootDir, e.path);
    if (file === null) return invalid(`not an uploaded file: ${e.path}`);
    if (!existsSync(file)) return invalid(`no longer on disk: ${e.path}`);
    // The name shown is the one on disk, whatever the request called it.
    attachments.push({
      name: e.path.slice(e.path.lastIndexOf('/') + 1),
      path: e.path,
      size: typeof e.size === 'number' ? e.size : 0,
      mimeType:
        typeof e.mimeType === 'string' && e.mimeType !== ''
          ? e.mimeType
          : 'application/octet-stream',
    });
  }
  return { ok: true, attachments };
}
