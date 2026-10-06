import { loadConfig } from '@dispatch-foo/core';

import type { ApiContext } from '../api.js';
import {
  resolveRemote,
  sshCommand,
  sshShell,
  UnknownRemoteError,
} from '../remote/ssh.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';
import { isDirectory, resolveWorkspacePath } from './workspacePaths.js';

// The routes under /api/terminals — create a shell session, read its output
// from a byte cursor, type into it, resize it, close it.
//
// Every one of these sits on the `operator` tier (see ELEVATED_ROUTES in
// api.ts). That is not incidental: a terminal is arbitrary command execution,
// so putting it on the `request` tier would hand every agent holding the
// on-disk agent token a way around the scope, floor and approval machinery
// that the rest of the daemon spends its time enforcing. The human's app
// token is never written to disk, which is exactly the property this needs.

type TerminalRouteContext = Pick<ApiContext, 'rootDir' | 'terminals'>;

// How much output one read returns. A client resuming a long-idle session
// catches up over several requests rather than pulling megabytes into one
// response body.
const MAX_READ_BYTES = 256 * 1024;

/**
 * Resolves the directory a new session should start in.
 *
 * A caller names either a run (its worktree) or a path, and a path is only
 * accepted inside that scope. The check is not about the human's authority —
 * they hold the app token and could run a shell themselves — it is about
 * keeping a session anchored to something the app can label and clean up, so a
 * stray `..` does not silently open a terminal in someone's home directory
 * under a project's name.
 */
function resolveTerminalCwd(
  rootDir: string,
  spec: { runId?: unknown; cwd?: unknown }
):
  | { ok: true; cwd: string; runId: string | null }
  | { ok: false; message: string } {
  const resolved = resolveWorkspacePath(rootDir, {
    runId: spec.runId,
    path: spec.cwd,
  });
  if (!resolved.ok) {
    // The shared guard talks about "path"; this route's field is `cwd`.
    return { ok: false, message: resolved.message.replace('path', 'cwd') };
  }
  if (!isDirectory(resolved.path)) {
    return { ok: false, message: `no such directory: ${resolved.path}` };
  }
  return { ok: true, cwd: resolved.path, runId: resolved.runId };
}

// A command is a list of strings or nothing at all (meaning "the login
// shell"). An empty list is treated as absent rather than rejected, since that
// is what a UI sends when its command field is blank.
function readCommand(
  raw: unknown
): { ok: true; command?: string[] } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) {
    return { ok: false };
  }
  return raw.length === 0 ? { ok: true } : { ok: true, command: raw };
}

function readDimension(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : undefined;
}

export async function createTerminal(
  req: Request,
  ctx: TerminalRouteContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;

  const command = readCommand(body.command);
  if (!command.ok)
    return errorResponse(400, 'command must be a list of strings');

  const title = body.title;
  if (title !== undefined && typeof title !== 'string') {
    return errorResponse(400, 'title must be a string');
  }

  const dimensions = {
    ...(readDimension(body.cols) === undefined
      ? {}
      : { cols: readDimension(body.cols) }),
    ...(readDimension(body.rows) === undefined
      ? {}
      : { rows: readDimension(body.rows) }),
  };

  // A remote session skips the local path checks entirely: `cwd` names a
  // directory on the other machine, which this one cannot resolve or contain.
  // The remote's own configured path is the scope there.
  if (body.remote !== undefined && body.remote !== null) {
    if (typeof body.remote !== 'string' || body.remote === '') {
      return errorResponse(400, 'remote must be a string');
    }
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    let remote;
    try {
      remote = resolveRemote(
        loadConfig(ctx.rootDir).remotes ?? {},
        body.remote
      );
    } catch (err) {
      if (err instanceof UnknownRemoteError) {
        return errorResponse(400, err.message);
      }
      throw err;
    }
    // A named command runs on the remote; without one the session is an
    // interactive login shell. Both go through ssh with a pty, so a
    // long-running command is as attachable as a shell is.
    const argv =
      command.command === undefined
        ? sshShell(remote, ...(cwd === undefined ? [] : [{ cwd }]))
        : sshCommand(
            remote,
            command.command,
            ...(cwd === undefined ? [] : [{ cwd }])
          );
    const where = cwd === undefined ? '' : `:${cwd}`;
    return jsonResponse(
      ctx.terminals.create({
        // The local process's own working directory is irrelevant for an ssh
        // invocation, but the registry records one, so the project root is the
        // honest answer to "where did this get started from".
        cwd: ctx.rootDir,
        remote: body.remote,
        runId: null,
        command: argv,
        title:
          title ??
          (command.command === undefined
            ? `${body.remote}${where}`
            : `${body.remote}${where} ${command.command.join(' ')}`),
        ...dimensions,
      }),
      201
    );
  }

  const where = resolveTerminalCwd(ctx.rootDir, body);
  if (!where.ok) return errorResponse(400, where.message);

  return jsonResponse(
    ctx.terminals.create({
      cwd: where.cwd,
      runId: where.runId,
      ...(command.command === undefined ? {} : { command: command.command }),
      ...(title === undefined ? {} : { title }),
      ...dimensions,
    }),
    201
  );
}

/**
 * `GET /api/terminals/:id/output?since=N` — the scrollback after byte N.
 *
 * `more` in the reply is what lets a client drain a backlog without guessing:
 * it means the read was capped and another request will return the rest
 * immediately, rather than waiting for new output.
 */
export function readTerminalOutput(
  ctx: TerminalRouteContext,
  id: string,
  sinceParam: string | null
): Response {
  const raw = sinceParam === null ? 0 : Number(sinceParam);
  const since = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const result = ctx.terminals.read(id, since);
  if (result === null) return errorResponse(404, `no terminal ${id}`);

  // Cap in decoded bytes, not base64 characters, so `next` stays a real cursor.
  const decoded = Buffer.from(result.data, 'base64');
  if (decoded.length <= MAX_READ_BYTES) {
    return jsonResponse({ ...result, next: result.total, more: false });
  }
  const capped = decoded.subarray(0, MAX_READ_BYTES);
  return jsonResponse({
    ...result,
    data: capped.toString('base64'),
    next: result.since + MAX_READ_BYTES,
    more: true,
  });
}

export async function writeTerminalInput(
  req: Request,
  ctx: TerminalRouteContext,
  id: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const data = (parsed.value as Record<string, unknown>).data;
  if (typeof data !== 'string')
    return errorResponse(400, 'data must be a string');
  if (ctx.terminals.get(id) === null)
    return errorResponse(404, `no terminal ${id}`);
  if (!ctx.terminals.write(id, data)) {
    // The session exists but nothing is on the other end — it exited, or this
    // daemon inherited it from a previous process (`orphaned`). Saying so is
    // more useful than a 404 the client would read as "that id is wrong".
    return errorResponse(409, 'terminal is not running');
  }
  return jsonResponse({ ok: true });
}

export async function resizeTerminal(
  req: Request,
  ctx: TerminalRouteContext,
  id: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;
  const cols = readDimension(body.cols);
  const rows = readDimension(body.rows);
  if (cols === undefined || rows === undefined) {
    return errorResponse(400, 'cols and rows must be positive numbers');
  }
  if (!ctx.terminals.resize(id, cols, rows)) {
    return errorResponse(404, `no terminal ${id}`);
  }
  return jsonResponse(ctx.terminals.get(id));
}

export function closeTerminal(ctx: TerminalRouteContext, id: string): Response {
  if (!ctx.terminals.close(id)) return errorResponse(404, `no terminal ${id}`);
  return jsonResponse({ ok: true });
}

export function deleteTerminal(
  ctx: TerminalRouteContext,
  id: string
): Response {
  if (!ctx.terminals.remove(id)) return errorResponse(404, `no terminal ${id}`);
  return jsonResponse({ ok: true });
}
