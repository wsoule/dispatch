import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TASK_ID = /^t-[0-9a-z-]+$/i;

/**
 * Tasks that are A2A-origin by lineage (XH-R2): created, edited or dispatched
 * by a run whose own task is A2A-origin. Kept apart from a2a.db so the guards
 * still see it with that database down, as an append-only list of task ids,
 * one per line; a torn last line is skipped.
 */
export class A2ALineage {
  private ids: Set<string> | null = null;

  constructor(readonly file: string) {}

  has(taskId: string): boolean {
    return this.load().has(taskId);
  }

  // Records `taskId` once; a failed append is thrown, since a task the guards
  // forget would act for the owner.
  mark(taskId: string): void {
    const ids = this.load();
    if (ids.has(taskId)) return;
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${taskId}\n`, { mode: 0o600 });
    ids.add(taskId);
  }

  private load(): Set<string> {
    if (this.ids !== null) return this.ids;
    const ids = new Set<string>();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        const id = line.trim();
        if (TASK_ID.test(id)) ids.add(id);
      }
    }
    this.ids = ids;
    return ids;
  }
}
