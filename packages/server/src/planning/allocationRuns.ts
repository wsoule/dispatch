import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// The allocation run log (Better Tracker's /runs): each time someone previews
// or applies the planning's allocation (unassigned issues in a project's next
// milestone go to its lead), the desktop records what it would do or did,
// item by item, here. The planning itself runs in the client; the daemon only
// keeps the record, in its own SQLite file outside the repository (daemon
// state, not project content). Recent applied items also feed My week's
// "New to you".

type AllocationRunMode = 'dry_run' | 'applied';

type AllocationItemOutcome = 'assigned' | 'would_assign' | 'failed';

/** One issue the run gave (or would give) to a project's lead. */
export interface AllocationRunItem {
  issueId: string;
  identifier: string;
  title: string;
  projectId: string;
  projectName: string;
  milestoneId: string;
  milestoneName: string;
  assigneeId: string;
  assigneeName: string;
  /** The status it moved from, and to (null: it kept its status). */
  fromStatus: string;
  toStatus: string | null;
  outcome: AllocationItemOutcome;
  /** Why it failed, or anything else worth saying. */
  note: string | null;
}

/** One project's verdict in the run: allocating, blocked (why), and so on. */
interface AllocationRunProject {
  projectId: string;
  projectName: string;
  outcome: string;
  /** The block reason, worded for people; null unless blocked. */
  reason: string | null;
  skipped: number;
}

interface AllocationRunCounts {
  assigned: number;
  wouldAssign: number;
  failed: number;
  blocked: number;
  skipped: number;
}

/** What a client records: the run less what the daemon stamps. */
export interface AllocationRunInput {
  mode: AllocationRunMode;
  items: AllocationRunItem[];
  projects: AllocationRunProject[];
}

/** What started a run: someone in the app, or the daemon's daily job. */
export type AllocationRunTrigger = 'manual' | 'daily';

export interface AllocationRunSummary {
  id: string;
  trigger: AllocationRunTrigger;
  /** ISO time the run was recorded. */
  at: string;
  /** Who ran it (a `human:<handle>` ref). */
  by: string;
  mode: AllocationRunMode;
  counts: AllocationRunCounts;
}

export interface AllocationRun extends AllocationRunSummary {
  items: AllocationRunItem[];
  projects: AllocationRunProject[];
}

/** How many runs the log keeps; older ones are dropped on record. */
const KEEP_RUNS = 500;

const MODES: readonly AllocationRunMode[] = ['dry_run', 'applied'];
const OUTCOMES: readonly AllocationItemOutcome[] = [
  'assigned',
  'would_assign',
  'failed',
];

function countsOf(input: AllocationRunInput): AllocationRunCounts {
  const counts: AllocationRunCounts = {
    assigned: 0,
    wouldAssign: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const item of input.items) {
    if (item.outcome === 'assigned') counts.assigned += 1;
    else if (item.outcome === 'would_assign') counts.wouldAssign += 1;
    else counts.failed += 1;
  }
  for (const project of input.projects) {
    if (project.outcome === 'blocked') counts.blocked += 1;
    counts.skipped += project.skipped;
  }
  return counts;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function isItem(value: unknown): value is AllocationRunItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    [
      'issueId',
      'identifier',
      'title',
      'projectId',
      'projectName',
      'milestoneId',
      'milestoneName',
      'assigneeId',
      'assigneeName',
      'fromStatus',
    ].every((key) => isString(item[key])) &&
    isNullableString(item.toStatus) &&
    isNullableString(item.note) &&
    OUTCOMES.includes(item.outcome as AllocationItemOutcome)
  );
}

function isProject(value: unknown): value is AllocationRunProject {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    isString(project.projectId) &&
    isString(project.projectName) &&
    isString(project.outcome) &&
    isNullableString(project.reason) &&
    typeof project.skipped === 'number' &&
    Number.isInteger(project.skipped) &&
    project.skipped >= 0
  );
}

/**
 * A run a client sent, checked field by field; an error message when it is
 * not one. An applied run may not carry "would assign" items, nor a dry run
 * "assigned" ones: the mode and the outcomes must agree.
 */
export function parseAllocationRunInput(
  value: unknown
): { ok: true; input: AllocationRunInput } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'expected a run object' };
  }
  const body = value as Record<string, unknown>;
  if (!MODES.includes(body.mode as AllocationRunMode)) {
    return { ok: false, error: `invalid mode (expected ${MODES.join('|')})` };
  }
  if (!Array.isArray(body.items) || !body.items.every(isItem)) {
    return { ok: false, error: 'invalid items' };
  }
  if (!Array.isArray(body.projects) || !body.projects.every(isProject)) {
    return { ok: false, error: 'invalid projects' };
  }
  const mode = body.mode as AllocationRunMode;
  const items = body.items;
  const mismatch = items.some((item) =>
    mode === 'dry_run'
      ? item.outcome !== 'would_assign'
      : item.outcome === 'would_assign'
  );
  if (mismatch) {
    return { ok: false, error: `items do not match the ${mode} mode` };
  }
  return {
    ok: true,
    input: {
      mode,
      items,
      projects: body.projects,
    },
  };
}

// A stored run; one logged before runs had a trigger reads as manual.
function readRun(json: string): AllocationRun {
  const run = JSON.parse(json) as Omit<AllocationRun, 'trigger'> & {
    trigger?: AllocationRunTrigger;
  };
  return { ...run, trigger: run.trigger ?? 'manual' };
}

/** The allocation run log of one project, in its own SQLite file. */
export class AllocationRunStore {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date()
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Records a run, stamped with an id, the time and who ran it. */
  record(
    input: AllocationRunInput,
    by: string,
    trigger: AllocationRunTrigger = 'manual'
  ): AllocationRun {
    const run: AllocationRun = {
      id: `ar-${randomBytes(4).toString('hex')}`,
      trigger,
      at: this.now().toISOString(),
      by,
      mode: input.mode,
      counts: countsOf(input),
      items: input.items,
      projects: input.projects,
    };
    this.db
      .query('INSERT INTO runs (id, at, json) VALUES (?, ?, ?)')
      .run(run.id, run.at, JSON.stringify(run));
    this.db
      .query(
        'DELETE FROM runs WHERE seq NOT IN (SELECT seq FROM runs ORDER BY seq DESC LIMIT ?)'
      )
      .run(KEEP_RUNS);
    return run;
  }

  /** Every kept run, newest first, without its items. */
  list(): AllocationRunSummary[] {
    return this.all().map(
      ({ items: _items, projects: _projects, ...rest }) => rest
    );
  }

  get(id: string): AllocationRun | null {
    const row = this.db
      .query<{ json: string }, [string]>('SELECT json FROM runs WHERE id = ?')
      .get(id);
    return row === null ? null : readRun(row.json);
  }

  /** Applied runs recorded at or after `since` (ISO), newest first, whole. */
  appliedSince(since: string): AllocationRun[] {
    return this.all().filter(
      (run) => run.mode === 'applied' && run.at >= since
    );
  }

  private all(): AllocationRun[] {
    return this.db
      .query<{ json: string }, []>('SELECT json FROM runs ORDER BY seq DESC')
      .all()
      .map((row) => readRun(row.json));
  }
}
