import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  AddCommentInput,
  CommentPatch,
  CommentStorePort,
  TaskComment,
} from './comments.js';
import { commentThreadIds, compareComments } from './comments.js';
import { isTaskId } from './ids.js';
import { queryAll, queryOne } from './sqliteDb.js';
import type { SqliteDatabase } from './sqliteDb.js';
import { DISPATCH_DIR } from './store.js';

/** A fresh comment id: `c-` plus 8 hex characters. */
export function generateCommentId(): string {
  return `c-${randomBytes(4).toString('hex')}`;
}

const MINT_ATTEMPTS = 32;

// The record a new comment starts as; shared so both backends agree.
function newComment(
  id: string,
  input: AddCommentInput,
  now: string
): TaskComment {
  const created = input.created ?? now;
  return {
    id,
    taskId: input.taskId,
    author: input.author,
    body: input.body,
    created,
    updated: created,
    parentId: input.parentId ?? null,
    external: input.external ?? null,
  };
}

function applyCommentPatch(
  comment: TaskComment,
  patch: CommentPatch,
  now: string
): TaskComment {
  return {
    ...comment,
    ...(patch.body === undefined ? {} : { body: patch.body }),
    ...(patch.external === undefined ? {} : { external: patch.external }),
    updated: now,
  };
}

// Reads one JSONL line into a comment, or null when it is not one.
function readComment(value: unknown): TaskComment | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.taskId !== 'string' ||
    typeof r.author !== 'string' ||
    typeof r.body !== 'string' ||
    typeof r.created !== 'string'
  ) {
    return null;
  }
  return {
    id: r.id,
    taskId: r.taskId,
    author: r.author,
    body: r.body,
    created: r.created,
    updated: typeof r.updated === 'string' ? r.updated : r.created,
    parentId: typeof r.parentId === 'string' ? r.parentId : null,
    external: typeof r.external === 'string' ? r.external : null,
  };
}

/**
 * The file backend's comments: `.dispatch/comments/<taskId>.jsonl`, one
 * comment per line, oldest first. A task's file is rewritten whole on each
 * write, so it stays small, diffable and committable like the task files.
 */
export class FileCommentStore implements CommentStorePort {
  readonly dir: string;

  constructor(readonly rootDir: string) {
    this.dir = join(rootDir, DISPATCH_DIR, 'comments');
  }

  private file(taskId: string): string {
    // The task id pattern is hex only, so it can never steer a path.
    if (!isTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
    return join(this.dir, `${taskId}.jsonl`);
  }

  list(taskId: string): TaskComment[] {
    const file = this.file(taskId);
    if (!existsSync(file)) return [];
    const comments: TaskComment[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const comment = readComment(JSON.parse(line));
        if (comment !== null) comments.push(comment);
      } catch {
        // A hand-corrupted line costs itself, not the thread.
      }
    }
    return comments.sort(compareComments);
  }

  private write(taskId: string, comments: TaskComment[]): void {
    const file = this.file(taskId);
    if (comments.length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    const lines = [...comments]
      .sort(compareComments)
      .map((c) => JSON.stringify(c));
    writeFileSync(file, `${lines.join('\n')}\n`);
  }

  get(taskId: string, id: string): TaskComment | null {
    return this.list(taskId).find((c) => c.id === id) ?? null;
  }

  add(
    input: AddCommentInput,
    now: string = new Date().toISOString()
  ): TaskComment {
    const existing = this.list(input.taskId);
    const taken = new Set(existing.map((c) => c.id));
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
      const id = generateCommentId();
      if (taken.has(id)) continue;
      const comment = newComment(id, input, now);
      this.write(input.taskId, [...existing, comment]);
      return comment;
    }
    throw new Error('could not mint an unused comment id');
  }

  update(
    taskId: string,
    id: string,
    patch: CommentPatch,
    now: string = new Date().toISOString()
  ): TaskComment {
    const comments = this.list(taskId);
    const index = comments.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(`comment not found: ${id}`);
    const next = applyCommentPatch(comments[index], patch, now);
    comments[index] = next;
    this.write(taskId, comments);
    return next;
  }

  remove(taskId: string, id: string): string[] {
    const comments = this.list(taskId);
    if (!comments.some((c) => c.id === id)) return [];
    const doomed = commentThreadIds(comments, id);
    this.write(
      taskId,
      comments.filter((c) => !doomed.has(c.id))
    );
    return [...doomed];
  }
}

interface CommentRow {
  id: string;
  task_id: string;
  author: string;
  body: string;
  created: string;
  updated: string;
  parent_id: string | null;
  external: string | null;
}

function commentFromRow(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    body: row.body,
    created: row.created,
    updated: row.updated,
    parentId: row.parent_id,
    external: row.external,
  };
}

const INSERT_COMMENT = `INSERT INTO comments
  (id, task_id, author, body, created, updated, parent_id, external)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`;

/** The database backend's comments: the `comments` table. */
export class SqliteCommentStore implements CommentStorePort {
  constructor(private readonly db: SqliteDatabase) {}

  list(taskId: string): TaskComment[] {
    return queryAll<CommentRow>(
      this.db,
      'SELECT * FROM comments WHERE task_id = ? ORDER BY created, id',
      [taskId]
    ).map(commentFromRow);
  }

  get(taskId: string, id: string): TaskComment | null {
    const row = queryOne<CommentRow>(
      this.db,
      'SELECT * FROM comments WHERE id = ? AND task_id = ?',
      [id, taskId]
    );
    return row === undefined ? null : commentFromRow(row);
  }

  add(
    input: AddCommentInput,
    now: string = new Date().toISOString()
  ): TaskComment {
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
      const comment = newComment(generateCommentId(), input, now);
      const written = this.db
        .prepare(INSERT_COMMENT)
        .run(
          comment.id,
          comment.taskId,
          comment.author,
          comment.body,
          comment.created,
          comment.updated,
          comment.parentId,
          comment.external
        );
      if (written.changes > 0) return comment;
    }
    throw new Error('could not mint an unused comment id');
  }

  update(
    taskId: string,
    id: string,
    patch: CommentPatch,
    now: string = new Date().toISOString()
  ): TaskComment {
    const current = this.get(taskId, id);
    if (current === null) throw new Error(`comment not found: ${id}`);
    const next = applyCommentPatch(current, patch, now);
    this.db
      .prepare(
        'UPDATE comments SET body = ?, external = ?, updated = ? WHERE id = ?'
      )
      .run(next.body, next.external, next.updated, id);
    return next;
  }

  remove(taskId: string, id: string): string[] {
    const comments = this.list(taskId);
    if (!comments.some((c) => c.id === id)) return [];
    const doomed = [...commentThreadIds(comments, id)];
    const remove = this.db.prepare('DELETE FROM comments WHERE id = ?');
    for (const commentId of doomed) remove.run(commentId);
    return doomed;
  }
}
