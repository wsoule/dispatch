import type { PlanningConfig } from '@dispatch-foo/core';
import { DEFAULT_TUNING, tuningFrom } from '@dispatch/planning';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// The planning audit (Better Tracker's Settings → Audit): every change made
// through the app to config.yml's `planning:` block (a tuning number, the
// active statuses, a watcher, a milestone's weight, the allocation or digest
// mode), with who made it, when, and the value before and after. The config
// route records it when it saves a planning patch; an edit to config.yml by
// hand or through git is not seen here.

/** One audited change. */
export interface PlanningAuditEntry {
  id: number;
  at: string;
  /** Who changed it (a `human:<handle>` ref). */
  by: string;
  /** What changed, in words: "Warn ahead", "Weight of Beta". */
  what: string;
  /** The value before and after, in words; null for none (the default). */
  before: string | null;
  after: string | null;
}

type Change = Omit<PlanningAuditEntry, 'id' | 'at' | 'by'>;

/** How many entries the audit keeps. */
const KEEP_ENTRIES = 1000;

const TUNING_LABEL: Record<keyof typeof DEFAULT_TUNING, string> = {
  warnLeadDays: 'Warn ahead',
  stallDays: 'Stalled after',
  paceWindowDays: 'Pace window',
  overdueRepeatDays: 'Repeat overdue every',
  newBadgeDays: 'New mark lasts',
  timelineDaysBack: 'Timeline looks back',
  timelineDaysAhead: 'Timeline looks ahead',
  activeProjectStatuses: 'Active project statuses',
};

const MODE_LABEL: Record<string, string> = {
  manual: 'Manual',
  daily: 'Daily',
  off: 'Off',
  notify: 'Notify',
};

// A tuning value in words: "7 days", or the statuses as a list.
function tuningWords(value: number | readonly string[]): string {
  return typeof value === 'number'
    ? `${value} ${value === 1 ? 'day' : 'days'}`
    : value.join(', ');
}

/**
 * What changed between two planning blocks, field by field. `nameOf` names a
 * person ref (for watchers) and `titleOf` a milestone id (for weights).
 */
export function planningChanges(
  before: PlanningConfig | undefined,
  after: PlanningConfig | undefined,
  nameOf: (ref: string) => string,
  titleOf: (taskId: string) => string
): Change[] {
  const changes: Change[] = [];
  const was = tuningFrom(before);
  const is = tuningFrom(after);
  for (const key of Object.keys(
    TUNING_LABEL
  ) as (keyof typeof TUNING_LABEL)[]) {
    const from = tuningWords(was[key]);
    const to = tuningWords(is[key]);
    if (from !== to)
      changes.push({ what: TUNING_LABEL[key], before: from, after: to });
  }

  const watchersBefore = new Set(before?.watchers ?? []);
  const watchersAfter = new Set(after?.watchers ?? []);
  for (const ref of watchersAfter) {
    if (!watchersBefore.has(ref)) {
      changes.push({ what: 'Watcher added', before: null, after: nameOf(ref) });
    }
  }
  for (const ref of watchersBefore) {
    if (!watchersAfter.has(ref)) {
      changes.push({
        what: 'Watcher removed',
        before: nameOf(ref),
        after: null,
      });
    }
  }

  const weightsBefore = before?.weights ?? {};
  const weightsAfter = after?.weights ?? {};
  for (const id of new Set([
    ...Object.keys(weightsBefore),
    ...Object.keys(weightsAfter),
  ])) {
    const from = weightsBefore[id];
    const to = weightsAfter[id];
    if (from === to) continue;
    changes.push({
      what: `Weight of ${titleOf(id)}`,
      before: from === undefined ? null : String(from),
      after: to === undefined ? null : String(to),
    });
  }

  const modes = [
    ['Allocate', before?.allocation ?? 'manual', after?.allocation ?? 'manual'],
    ['Daily digest', before?.warnings ?? 'off', after?.warnings ?? 'off'],
  ] as const;
  for (const [what, from, to] of modes) {
    if (from !== to) {
      changes.push({
        what,
        before: MODE_LABEL[from] ?? from,
        after: MODE_LABEL[to] ?? to,
      });
    }
  }
  return changes;
}

/** The planning audit of one project, in its own SQLite file. */
export class PlanningAuditStore {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date()
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        what TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Records changes made together, stamped now and with who made them. */
  record(changes: readonly Change[], by: string): void {
    if (changes.length === 0) return;
    const at = this.now().toISOString();
    const put = this.db.query(
      'INSERT INTO entries (at, actor, what, old_value, new_value) VALUES (?, ?, ?, ?, ?)'
    );
    this.db.transaction(() => {
      for (const change of changes) {
        put.run(at, by, change.what, change.before, change.after);
      }
    })();
    this.db
      .query(
        'DELETE FROM entries WHERE id NOT IN (SELECT id FROM entries ORDER BY id DESC LIMIT ?)'
      )
      .run(KEEP_ENTRIES);
  }

  /** The newest entries first. */
  list(limit = 200): PlanningAuditEntry[] {
    return this.db
      .query<PlanningAuditEntry, [number]>(
        'SELECT id, at, actor AS "by", what, old_value AS "before", new_value AS "after" FROM entries ORDER BY id DESC LIMIT ?'
      )
      .all(limit);
  }
}
