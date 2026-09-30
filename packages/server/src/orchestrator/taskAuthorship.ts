import type { TaskDoc } from '@dispatch/core';
import { removeSection } from '@dispatch/core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface AuthorshipRecord {
  createdBy: string;
  /** Last writer of the title; null once someone who acts for no one did. */
  titleBy: string | null;
  /** Last writer of the body (Activity aside); null as for `titleBy`. */
  bodyBy: string | null;
  /** The title and body as the last tracked edit of each left them. */
  titleDigest: string;
  bodyDigest: string;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// The title a run is briefed from.
function titleDigest(doc: TaskDoc): string {
  return digest(doc.meta.title);
}

// The body a run is briefed from; Activity lines are appended by comments and
// runs, so they never count as an edit.
function bodyDigest(doc: TaskDoc): string {
  return digest(removeSection(doc.body, 'Activity'));
}

/**
 * Who created each task and who last wrote its title and its body, so an
 * epic's auto-fill acts for its operator only on work that operator wrote. A
 * task with no record, or changed since the last tracked edit, acts for no one.
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
        titleBy: operator,
        bodyBy: operator,
        titleDigest: titleDigest(doc),
        bodyDigest: bodyDigest(doc),
      });
    this.persist();
  }

  /** An edit on behalf of `operator`; each of the title and body is claimed
   *  only when this edit actually changed it. */
  edited(before: TaskDoc, after: TaskDoc, operator: string | null): void {
    const record = this.records.get(after.meta.id);
    if (record === undefined) return;
    const title = titleDigest(after);
    const body = bodyDigest(after);
    const titleChanged = title !== titleDigest(before);
    const bodyChanged = body !== bodyDigest(before);
    if (!titleChanged && !bodyChanged) return;
    if (titleChanged) {
      record.titleBy = operator;
      record.titleDigest = title;
    }
    if (bodyChanged) {
      record.bodyBy = operator;
      record.bodyDigest = body;
    }
    this.persist();
  }

  /** `operator` when they created the task and last wrote both its title and
   *  its body as they read now; otherwise null. */
  actsFor(doc: TaskDoc, operator: string | null): string | null {
    if (operator === null) return null;
    const record = this.records.get(doc.meta.id);
    return record !== undefined &&
      record.createdBy === operator &&
      record.titleBy === operator &&
      record.bodyBy === operator &&
      record.titleDigest === titleDigest(doc) &&
      record.bodyDigest === bodyDigest(doc)
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

  // A missing or unreadable file starts empty, and a record in an older shape
  // is dropped: those tasks then act for no one.
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
          (typeof r.titleBy === 'string' || r.titleBy === null) &&
          (typeof r.bodyBy === 'string' || r.bodyBy === null) &&
          typeof r.titleDigest === 'string' &&
          typeof r.bodyDigest === 'string'
        )
          this.records.set(id, {
            createdBy: r.createdBy,
            titleBy: r.titleBy,
            bodyBy: r.bodyBy,
            titleDigest: r.titleDigest,
            bodyDigest: r.bodyDigest,
          });
      }
    } catch (err) {
      console.error(
        `dispatchd: failed to read task authorship, starting empty: ${(err as Error).message}`
      );
    }
  }
}
