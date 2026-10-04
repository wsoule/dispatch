import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TASK_ID = /^t-[0-9a-z-]+$/i;
const RUN_ID = /^r-[0-9a-z-]+$/i;

/**
 * Tasks that are A2A-origin by lineage (XH-R2): created, edited or dispatched
 * by a run whose own task is A2A-origin. Kept apart from a2a.db so the guards
 * still see it with that database down, as an append-only list with one
 * `<task id> <run id>` line per task, naming the run that first marked it; a
 * torn last line is skipped.
 */
export class A2ALineage {
  // Task id -> the run that marked it ('' for a line without one).
  private marks: Map<string, string> | null = null;

  constructor(readonly file: string) {}

  has(taskId: string): boolean {
    return this.load().has(taskId);
  }

  /** The run that first marked `taskId`, or null. */
  markedBy(taskId: string): string | null {
    const by = this.load().get(taskId);
    return by === undefined || by === '' ? null : by;
  }

  // Records `taskId` once; a failed append is thrown, since a task the guards
  // forget would act for the owner.
  mark(taskId: string, byRun: string): void {
    const marks = this.load();
    if (marks.has(taskId)) return;
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${taskId} ${byRun}\n`, { mode: 0o600 });
    marks.set(taskId, byRun);
  }

  private load(): Map<string, string> {
    if (this.marks !== null) return this.marks;
    const marks = new Map<string, string>();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        const [id = '', by = ''] = line.trim().split(/\s+/);
        if (TASK_ID.test(id) && !marks.has(id))
          marks.set(id, RUN_ID.test(by) ? by : '');
      }
    }
    this.marks = marks;
    return marks;
  }
}
