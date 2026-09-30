import {
  ATTACHMENT_MAX_BYTES,
  attachmentRelativePath,
  attachmentsDir,
  ensureProjectGitignore,
  sanitizeAttachmentName,
} from '@dispatch/core';
import type { TaskAttachment, TaskDoc } from '@dispatch/core';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import type { ApiContext } from '../api.js';
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
