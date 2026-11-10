// Which parts of a task, and which comments, the daemon's owner last wrote,
// and to what, so a background Linear push goes out with their own Linear
// token only for values they wrote. Pushes run later, in a debounced pass
// that does not know who changed what (`task.changed` carries ids only), so
// the human task and comment routes record here when a request came on the
// owner's own credential.
//
// A field is credited to the person only while every part behind it still
// holds the digest the owner left, and nobody else wrote that part since:
// every other write the daemon sees (`observe`, called for each task change
// and for each local write a sync pass makes) drops the entries it no longer
// matches, so a value someone else restores later is theirs, not the owner's.
// A comment is credited only for the body (or the delete) the owner sent
// through this daemon's API, never for a comment file that arrived by git or
// board sync. Memory only: a restart before the push loses the credit, which
// falls back to the project connection.
import { removeSection } from '@dispatch-foo/core';
import type { TaskDoc } from '@dispatch-foo/core';
import { createHash } from 'node:crypto';

/** The task parts a Linear issue field is built from. */
const PARTS = [
  'title',
  'body',
  'status',
  'priority',
  'estimate',
  'assignee',
  'labels',
  'dueDate',
  'cycle',
  'parent',
  'blockedBy',
  'relatedTo',
  'duplicateOf',
  'archivedAt',
] as const;
type Part = (typeof PARTS)[number];

/** Issue field -> the task parts it is computed from. A field not listed
 *  (`creator`, pull-only) has no part, so it can never be credited. */
const FIELD_PARTS: Readonly<Record<string, readonly Part[]>> = {
  title: ['title'],
  description: ['body'],
  links: ['body'],
  state: ['status'],
  priority: ['priority'],
  estimate: ['estimate'],
  assignee: ['assignee'],
  labels: ['labels'],
  dueDate: ['dueDate'],
  cycle: ['cycle'],
  parent: ['parent'],
  project: ['parent'],
  milestone: ['parent'],
  blockedBy: ['blockedBy'],
  relatedTo: ['relatedTo'],
  duplicateOf: ['duplicateOf'],
  archived: ['archivedAt', 'status'],
};

// The value a part holds on a task, before hashing.
function partValue(doc: TaskDoc, part: Part): unknown {
  const { meta } = doc;
  switch (part) {
    case 'title':
      return meta.title;
    // Activity lines are appended by runs and comments, never an edit; the
    // blank lines around a removed section do not count either.
    case 'body':
      return removeSection(doc.body, 'Activity').trimEnd();
    case 'status':
      return meta.status;
    case 'priority':
      return meta.priority;
    case 'estimate':
      return meta.estimate;
    case 'assignee':
      return meta.assignee;
    case 'labels':
      return meta.labels;
    case 'dueDate':
      return meta.dueDate;
    case 'cycle':
      return meta.cycle?.id ?? null;
    case 'parent':
      return [meta.parent, meta.milestone];
    case 'blockedBy':
      return meta.blockedBy;
    case 'relatedTo':
      return meta.relatedTo;
    case 'duplicateOf':
      return meta.duplicateOf;
    case 'archivedAt':
      return meta.archivedAt ?? null;
  }
}

// SHA-256 of a part's canonical JSON (`undefined` reads as null).
function digest(doc: TaskDoc, part: Part): string {
  return createHash('sha256')
    .update(JSON.stringify(partValue(doc, part) ?? null))
    .digest('hex');
}

// SHA-256 of a comment body as the owner sent it.
function bodyDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Who wrote a part (or a comment), and the digest they left. */
interface Entry {
  ref: string;
  digest: string;
}

/** What the owner last did to a comment: wrote this body, or deleted it. */
type CommentEntry =
  | { ref: string; body: string }
  | { ref: string; deleted: true };

/** Which parts of a task, and which comments, the owner last wrote. Memory only. */
export class LinearPersonEdits {
  // Task id -> part -> who set it and the digest they left.
  private readonly edits = new Map<string, Map<Part, Entry>>();
  // Local comment id -> the owner's last body digest, or their delete.
  private readonly comments = new Map<string, CommentEntry>();

  private entries(taskId: string): Map<Part, Entry> {
    let entries = this.edits.get(taskId);
    if (entries === undefined) {
      entries = new Map();
      this.edits.set(taskId, entries);
    }
    return entries;
  }

  /** A task `ref` just created: every part is theirs. */
  created(doc: TaskDoc, ref: string): void {
    const entries = this.entries(doc.meta.id);
    for (const part of PARTS)
      entries.set(part, { ref, digest: digest(doc, part) });
  }

  /** An edit `ref` made: only the parts it changed become theirs. */
  edited(before: TaskDoc, after: TaskDoc, ref: string): void {
    let entries: Map<Part, Entry> | null = null;
    for (const part of PARTS) {
      const now = digest(after, part);
      if (now === digest(before, part)) continue;
      entries ??= this.entries(after.meta.id);
      entries.set(part, { ref, digest: now });
    }
  }

  /** Whether the ledger holds anything for a task, so a caller can skip
   *  reading it. */
  tracks(taskId: string): boolean {
    return this.edits.has(taskId);
  }

  /** The tasks the ledger holds anything for. */
  tracked(): string[] {
    return [...this.edits.keys()];
  }

  /**
   * A task as it stands after a write the owner's routes did not record (an
   * agent, the orchestrator, a teammate, a sync pull, board sync, a file
   * edited on disk): every part whose value moved away from the owner's is
   * no longer theirs, even if someone later sets it back. A removed task
   * (null) loses everything.
   */
  observe(taskId: string, doc: TaskDoc | null): void {
    const entries = this.edits.get(taskId);
    if (entries === undefined) return;
    if (doc === null) {
      this.edits.delete(taskId);
      return;
    }
    for (const [part, entry] of entries) {
      if (entry.digest !== digest(doc, part)) entries.delete(part);
    }
    if (entries.size === 0) this.edits.delete(taskId);
  }

  /**
   * The subset of `fields` that `ref` set and the task still holds: every
   * part behind each such field. An unknown or pull-only field is never
   * theirs. A part found changed is dropped, as `observe` would.
   */
  owned(doc: TaskDoc, fields: readonly string[], ref: string): string[] {
    this.observe(doc.meta.id, doc);
    const entries = this.edits.get(doc.meta.id);
    if (entries === undefined) return [];
    return fields.filter((field) => {
      const parts = FIELD_PARTS[field];
      return (
        parts !== undefined &&
        parts.every((part) => entries.get(part)?.ref === ref)
      );
    });
  }

  /** Whether `ref` owns every one of `fields` (false for none). */
  owns(doc: TaskDoc, fields: readonly string[], ref: string): boolean {
    return (
      fields.length > 0 && this.owned(doc, fields, ref).length === fields.length
    );
  }

  /** The pushed fields reached Linear: their parts are no longer pending
   *  credit, so a later push of the same part needs a new edit. A part that
   *  a field still waiting to land (`pending`) is built from keeps its
   *  credit, so that field is retried as the owner. */
  settled(
    taskId: string,
    fields: readonly string[],
    pending: readonly string[] = []
  ): void {
    const entries = this.edits.get(taskId);
    if (entries === undefined) return;
    const kept = new Set(pending.flatMap((field) => FIELD_PARTS[field] ?? []));
    for (const field of fields)
      for (const part of FIELD_PARTS[field] ?? [])
        if (!kept.has(part)) entries.delete(part);
    if (entries.size === 0) this.edits.delete(taskId);
  }

  /** The owner wrote (created or edited) a comment to `body` through the API. */
  commentWritten(commentId: string, body: string, ref: string): void {
    this.comments.set(commentId, { ref, body: bodyDigest(body) });
  }

  /** The owner deleted these comments through the API. */
  commentsDeleted(commentIds: readonly string[], ref: string): void {
    for (const id of commentIds) this.comments.set(id, { ref, deleted: true });
  }

  /** Whether `ref` wrote this comment's current `body` through the API. */
  wroteComment(commentId: string, body: string, ref: string): boolean {
    const entry = this.comments.get(commentId);
    return (
      entry !== undefined &&
      entry.ref === ref &&
      'body' in entry &&
      entry.body === bodyDigest(body)
    );
  }

  /** Whether `ref` deleted this comment through the API. */
  deletedComment(commentId: string, ref: string): boolean {
    const entry = this.comments.get(commentId);
    return entry !== undefined && entry.ref === ref && 'deleted' in entry;
  }

  /** A comment's write or delete reached Linear: its credit is spent. */
  commentSettled(commentId: string): void {
    this.comments.delete(commentId);
  }
}
