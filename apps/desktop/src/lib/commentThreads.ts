import type { TaskComment } from '@dispatch/core/browser';

/** A top-level comment with every reply beneath it, oldest first. */
export interface CommentThread {
  root: TaskComment;
  replies: TaskComment[];
}

// A comment the client added optimistically carries this id prefix until the daemon's copy
// replaces it.
const PENDING_PREFIX = 'pending:';

export function pendingCommentId(n: number): string {
  return `${PENDING_PREFIX}${n}`;
}

export function isPendingComment(comment: TaskComment): boolean {
  return comment.id.startsWith(PENDING_PREFIX);
}

/**
 * Groups a task's comments into Linear-style threads: each top-level comment with its
 * replies flattened under it, however deep the reply chain goes. A reply whose parent is
 * missing (deleted, or not synced yet) becomes a thread of its own rather than vanishing.
 * Input order is kept, so an oldest-first list yields oldest-first threads and replies.
 */
export function commentThreads(
  comments: readonly TaskComment[]
): CommentThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = new Map<string, string>();
  function resolveRoot(comment: TaskComment): string {
    const cached = rootOf.get(comment.id);
    if (cached !== undefined) return cached;
    // Walk up the parent chain; `seen` guards a malformed cycle.
    const path: string[] = [];
    const seen = new Set<string>();
    let current = comment;
    while (current.parentId !== null && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current.id);
      const parent = byId.get(current.parentId);
      if (parent === undefined) break;
      const known = rootOf.get(parent.id);
      if (known !== undefined) {
        for (const id of path) rootOf.set(id, known);
        return known;
      }
      current = parent;
    }
    for (const id of path) rootOf.set(id, current.id);
    rootOf.set(current.id, current.id);
    return current.id;
  }

  const threads = new Map<string, CommentThread>();
  for (const comment of comments) {
    const rootId = resolveRoot(comment);
    if (rootId === comment.id) {
      threads.set(rootId, { root: comment, replies: [] });
    }
  }
  for (const comment of comments) {
    const rootId = resolveRoot(comment);
    if (rootId === comment.id) continue;
    threads.get(rootId)?.replies.push(comment);
  }
  return [...threads.values()];
}

/**
 * Whether `me` may edit or delete a comment `author` wrote — the daemon's own rule for a
 * person: their comment, or one written by one of their agents (`agent:<handle>/…`).
 */
export function canModifyComment(author: string, me: string | null): boolean {
  if (me === null) return false;
  if (author === me) return true;
  const handle = me.slice(me.indexOf(':') + 1);
  return author.startsWith(`agent:${handle}/`);
}
