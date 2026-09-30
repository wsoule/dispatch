// Task comments: first-class records, not Activity text. Pure shapes and
// validation, no node:* imports, so the desktop webview can import them.
import type { Assignee } from './types.js';

export interface TaskComment {
  id: string;
  taskId: string;
  /** A serialized ActorRef (see actor.ts). */
  author: Assignee;
  /** Markdown. */
  body: string;
  created: string;
  updated: string;
  /** The comment this one replies to, for threads; null at the top level. */
  parentId: string | null;
  /** The id in an external tracker (`linear:<uuid>`), or null. */
  external: string | null;
}

export interface AddCommentInput {
  taskId: string;
  author: Assignee;
  body: string;
  parentId?: string | null;
  external?: string | null;
  /** Kept verbatim when importing (a synced comment's own timestamp). */
  created?: string;
}

export interface CommentPatch {
  body?: string;
  external?: string | null;
}

/** The comment surface both backends answer. */
export interface CommentStorePort {
  /** One task's comments, oldest first. */
  list(taskId: string): TaskComment[];
  get(taskId: string, id: string): TaskComment | null;
  add(input: AddCommentInput, now?: string): TaskComment;
  /** Throws when the comment does not exist. */
  update(
    taskId: string,
    id: string,
    patch: CommentPatch,
    now?: string
  ): TaskComment;
  /** Removes the comment and its replies; the removed ids ([] if absent). */
  remove(taskId: string, id: string): string[];
}

/** Why a comment input is invalid, or null when it is fine. */
export function commentInputError(body: unknown): string | null {
  if (typeof body !== 'string' || body.trim() === '') {
    return 'invalid body: a comment needs text';
  }
  return null;
}

/** Oldest first, ties broken by id, the order every backend returns. */
export function compareComments(a: TaskComment, b: TaskComment): number {
  const byCreated = a.created.localeCompare(b.created);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

/** `id` plus every reply beneath it, for a cascading delete. */
export function commentThreadIds(
  comments: readonly TaskComment[],
  id: string
): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of comments) {
      if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        grew = true;
      }
    }
  }
  return ids;
}
