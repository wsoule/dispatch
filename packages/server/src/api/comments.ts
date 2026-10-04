import {
  commentInputError,
  commentThreadIds,
  FileCommentStore,
} from '@dispatch/core';
import type { CommentStorePort, TaskComment } from '@dispatch/core';

import type { ApiContext } from '../api.js';
import { humanActor } from './caller.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// The comment routes under /api/tasks/:id/comments. Comments are records of
// their own (core's comments.ts), so a write broadcasts `comment.changed`,
// never `task.changed`: a new comment does not refetch the board.
//
// Authorship is the server's to decide: a request is credited to whoever
// its credential names, stamped with the server's clock, and only a
// comment's author may edit or delete it. A sync importing someone else's
// comment writes through the store in-process (CommentStorePort.add takes
// author, created and external), never over HTTP.

type CommentRouteContext = Pick<
  ApiContext,
  | 'rootDir'
  | 'store'
  | 'events'
  | 'commentStore'
  | 'caller'
  | 'actorContext'
  | 'viaRun'
> &
  Partial<Pick<ApiContext, 'orchestrator'>>;

// The daemon passes the backend's store; a hand-built test context without
// one gets the file store, which is what a files-backed project uses.
function commentsOf(ctx: CommentRouteContext): CommentStorePort {
  return ctx.commentStore ?? new FileCommentStore(ctx.rootDir);
}

/**
 * Who a comment request speaks for. The on-disk agent token is what every
 * run's agent holds, so it is credited to an agent — the run's own executor
 * when `runId` names a live run, else the bare `agent` — never to the human
 * who operates the daemon. Any other credential is its human.
 */
function commentActor(ctx: CommentRouteContext, runId: unknown): string {
  if (ctx.caller?.agentToken !== true) return humanActor(ctx);
  // A run's own token names its run; a body runId cannot override it.
  const id = ctx.viaRun ?? runId;
  const run =
    typeof id === 'string' ? (ctx.orchestrator?.getRun(id) ?? null) : null;
  return run === null ? 'agent' : ctx.actorContext.agentRef(run.meta.executor);
}

// Whether the caller may edit or delete a comment `author` wrote: their own,
// or (for a human) one their own agents wrote.
function mayModify(ctx: CommentRouteContext, author: string): boolean {
  if (ctx.caller?.agentToken === true) {
    const operator = ctx.caller.handle;
    return author === 'agent' || author.startsWith(`agent:${operator}/`);
  }
  const me = humanActor(ctx);
  const handle = me.slice(me.indexOf(':') + 1);
  return author === me || author.startsWith(`agent:${handle}/`);
}

function taskMissing(ctx: CommentRouteContext, taskId: string): boolean {
  return ctx.store.get(taskId) === null;
}

// GET /api/tasks/:id/comments — the thread, oldest first.
export function listComments(
  ctx: CommentRouteContext,
  taskId: string
): Response {
  if (taskMissing(ctx, taskId)) {
    return errorResponse(404, `task not found: ${taskId}`);
  }
  return jsonResponse(commentsOf(ctx).list(taskId));
}

// POST /api/tasks/:id/comments — `{ body, parentId?, runId? }`. Any other
// key (author, created, external) is ignored: those are the server's.
export async function addComment(
  req: Request,
  ctx: CommentRouteContext,
  taskId: string
): Promise<Response> {
  if (taskMissing(ctx, taskId)) {
    return errorResponse(404, `task not found: ${taskId}`);
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;
  const bodyError = commentInputError(body.body);
  if (bodyError !== null) return errorResponse(400, bodyError);
  const parentId = body.parentId ?? null;
  if (parentId !== null && typeof parentId !== 'string') {
    return errorResponse(400, 'invalid parentId: expected a string');
  }
  const comments = commentsOf(ctx);
  if (parentId !== null && comments.get(taskId, parentId) === null) {
    return errorResponse(400, `invalid parentId: no comment ${parentId}`);
  }
  const comment = comments.add({
    taskId,
    author: commentActor(ctx, body.runId),
    body: body.body as string,
    parentId,
  });
  ctx.events.broadcast({
    type: 'comment.changed',
    taskId,
    commentIds: [comment.id],
  });
  return jsonResponse(comment, 201);
}

// POST /api/tasks/:id/comment — the pre-thread `task_comment` target, kept
// for MCP servers older than the thread: `{ text, runId? }` becomes a comment,
// credited to the run's agent or `none` (never the operator), and the answer
// is still the task doc those servers read `meta` from.
export async function addLegacyTaskNote(
  req: Request,
  ctx: CommentRouteContext,
  taskId: string
): Promise<Response> {
  const doc = ctx.store.get(taskId);
  if (doc === null) {
    return errorResponse(404, `task not found: ${taskId}`);
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown; runId?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  const run =
    typeof body.runId === 'string'
      ? (ctx.orchestrator?.getRun(body.runId) ?? null)
      : null;
  const comment = commentsOf(ctx).add({
    taskId,
    author:
      run === null ? 'none' : ctx.actorContext.agentRef(run.meta.executor),
    body: body.text,
  });
  ctx.events.broadcast({
    type: 'comment.changed',
    taskId,
    commentIds: [comment.id],
  });
  return jsonResponse(doc);
}

// Resolves the comment a PATCH/DELETE targets and checks the caller wrote it.
function ownComment(
  ctx: CommentRouteContext,
  taskId: string,
  commentId: string
): { comment: TaskComment } | { response: Response } {
  const comment = commentsOf(ctx).get(taskId, commentId);
  if (comment === null) {
    return {
      response: errorResponse(404, `comment not found: ${commentId}`),
    };
  }
  if (!mayModify(ctx, comment.author)) {
    return {
      response: errorResponse(
        403,
        `only ${comment.author} may change comment ${commentId}`
      ),
    };
  }
  return { comment };
}

// PATCH /api/tasks/:id/comments/:commentId — `{ body }`, author only.
export async function updateComment(
  req: Request,
  ctx: CommentRouteContext,
  taskId: string,
  commentId: string
): Promise<Response> {
  const owned = ownComment(ctx, taskId, commentId);
  if ('response' in owned) return owned.response;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;
  const bodyError = commentInputError(body.body);
  if (bodyError !== null) return errorResponse(400, bodyError);
  const comment = commentsOf(ctx).update(taskId, commentId, {
    body: body.body as string,
  });
  ctx.events.broadcast({
    type: 'comment.changed',
    taskId,
    commentIds: [commentId],
  });
  return jsonResponse(comment);
}

// DELETE /api/tasks/:id/comments/:commentId — author only. Deleting takes
// the reply subtree with it, so it is refused (409) while anyone else has
// replied beneath: one person's delete never removes another's words.
export function deleteComment(
  ctx: CommentRouteContext,
  taskId: string,
  commentId: string
): Response {
  const owned = ownComment(ctx, taskId, commentId);
  if ('response' in owned) return owned.response;
  const comments = commentsOf(ctx);
  const thread = comments.list(taskId);
  const subtree = commentThreadIds(thread, commentId);
  const foreign = thread.filter(
    (c) => subtree.has(c.id) && !mayModify(ctx, c.author)
  );
  if (foreign.length > 0) {
    return errorResponse(
      409,
      `comment ${commentId} has replies by others (${foreign.map((c) => c.author).join(', ')}); edit it instead of deleting`
    );
  }
  const removed = comments.remove(taskId, commentId);
  ctx.events.broadcast({
    type: 'comment.changed',
    taskId,
    commentIds: removed,
  });
  return jsonResponse({ removed });
}
