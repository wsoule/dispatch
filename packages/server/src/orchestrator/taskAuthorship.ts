import type { TaskDoc } from '@dispatch/core';
import { removeSection } from '@dispatch/core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface AuthorshipRecord {
  createdBy: string;
  /** Null once someone who acts for no one rewrote the title or body. */
  editedBy: string | null;
  /** The title and body (Activity aside) as that last tracked edit left them. */
  digest: string;
}

// The title and body a run is briefed from; Activity lines are appended by
// comments and runs, so they never count as an edit.
function contentDigest(doc: TaskDoc): string {
  return createHash('sha256')
    .update(doc.meta.title)
    .update('\0')
    .update(removeSection(doc.body, 'Activity'))
    .digest('hex');
}

/**
 * Who created each task and who last wrote its title or body, so an epic's
 * auto-fill acts for its operator only on work that operator wrote. A task
 * with no record, or changed since the last tracked edit, acts for no one.
 */
export class TaskAuthorship {
  private readonly records = new Map<string, AuthorshipRecord>();

  /** `path` null keeps the records in memory only. */
  constructor(private readonly path: string | null) {
    this.hydrate();
  }

  /** A task just created on behalf of `operator` (null: no one). */
  created(doc: TaskDoc, operator: string | null): void {
    if (operator === null) this.records.delete(doc.meta.id);
    else
      this.records.set(doc.meta.id, {
        createdBy: operator,
        editedBy: operator,
        digest: contentDigest(doc),
      });
    this.persist();
  }

  /** An edit on behalf of `operator`; only a title or body change counts. */
  edited(before: TaskDoc, after: TaskDoc, operator: string | null): void {
    const record = this.records.get(after.meta.id);
    if (record === undefined) return;
    const digest = contentDigest(after);
    if (digest === contentDigest(before)) return;
    record.editedBy = operator;
    record.digest = digest;
    this.persist();
  }

  /** `operator` when they created the task and last wrote it as it reads
   *  now; otherwise null. */
  actsFor(doc: TaskDoc, operator: string | null): string | null {
    if (operator === null) return null;
    const record = this.records.get(doc.meta.id);
    return record !== undefined &&
      record.createdBy === operator &&
      record.editedBy === operator &&
      record.digest === contentDigest(doc)
      ? operator
      : null;
  }

  private persist(): void {
    if (this.path === null) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        `${JSON.stringify(Object.fromEntries(this.records))}\n`
      );
    } catch (err) {
      console.error(
        `dispatchd: failed to persist task authorship: ${(err as Error).message}`
      );
    }
  }

  // A missing or unreadable file starts empty: every task then acts for no one.
  private hydrate(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<
        string,
        Partial<AuthorshipRecord>
      >;
      for (const [id, r] of Object.entries(parsed)) {
        if (
          typeof r.createdBy === 'string' &&
          (typeof r.editedBy === 'string' || r.editedBy === null) &&
          typeof r.digest === 'string'
        )
          this.records.set(id, {
            createdBy: r.createdBy,
            editedBy: r.editedBy,
            digest: r.digest,
          });
      }
    } catch (err) {
      console.error(
        `dispatchd: failed to read task authorship, starting empty: ${(err as Error).message}`
      );
    }
  }
}
