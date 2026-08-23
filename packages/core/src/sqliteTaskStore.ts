import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { generateTaskId, isTaskId } from './ids.js';
import { slugify } from './slug.js';
import {
  parseEnum,
  parseStringArray,
  queryAll,
  queryOne,
  serializeStringArray,
  SqliteRowError,
} from './sqliteDb.js';
import type {
  CreateInput,
  ListFilter,
  ListSafeError,
  ListSafeResult,
  TaskStorePort,
  UpdatePatch,
} from './store.js';
import {
  appendActivity,
  appendAmendment,
  escapeHeadingLines,
  normalizeBody,
  serializeTaskFile,
  setSection,
} from './taskfile.js';
import type { Amendment } from './taskfile.js';
import { KINDS, PRIORITIES, TASK_RISKS } from './types.js';
import type {
  Priority,
  TaskDoc,
  TaskKind,
  TaskMeta,
  TaskRisk,
} from './types.js';

// The database-backed half of the task seam. Same contract as TaskStore, same
// pure body helpers from taskfile.ts (setSection, appendActivity,
// appendAmendment, escapeHeadingLines) — only the persistence differs: one row
// per task instead of one markdown file per task.
//
// Frontmatter lives in typed columns rather than as a blob of serialized YAML,
// so list() filters and sorts in SQL instead of parsing every task to answer a
// question about one field. serializeTaskFile is still the authority on what a
// task looks like as a document: `toMarkdown` below reuses it, which is how a
// row is exported to the git receipt log or migrated back to a file.

// How many ids create() tries before giving up. The file backend mints one and
// re-rolls up to five times, so six is the same budget.
const ID_ATTEMPTS = 6;

// A tasks row as node:sqlite hands it back. Every column is one of SQLite's
// storage classes, so booleans arrive as 0/1 and absent optionals as null.
interface TaskRow {
  id: string;
  title: string;
  status: string;
  kind: string;
  parent: string | null;
  milestone: string | null;
  blocked_by: string;
  labels: string;
  priority: string;
  assignee: string;
  created: string;
  updated: string;
  external: string | null;
  self_review: number;
  fix_loop: number | null;
  writes: string;
  risk: string;
  model: string | null;
  archived_at: string | null;
  exercised: number;
  derived_from: string | null;
  slug: string;
  body: string;
}

// Rebuilds a TaskMeta from a row, throwing a SqliteRowError if the row cannot
// be read as one. The optional keys are spread in rather than assigned so an
// absent one stays absent — the same shape parseTaskFile produces for a file
// that never carried the key, which is what keeps
// `expect(sqliteDoc).toEqual(fileDoc)` honest.
//
// `status` and `assignee` are not validated: status is whatever the project's
// config.yml lists, and assignee is a serialized ActorRef. Neither is a closed
// set, so neither has anything to check against.
function metaFromRow(row: TaskRow): TaskMeta {
  const id = row.id;
  return {
    id,
    title: row.title,
    status: row.status,
    kind: parseEnum<TaskKind>(row.kind, KINDS, 'tasks', id, 'kind'),
    parent: row.parent,
    milestone: row.milestone,
    blockedBy: parseStringArray(row.blocked_by, 'tasks', id, 'blocked_by'),
    labels: parseStringArray(row.labels, 'tasks', id, 'labels'),
    priority: parseEnum<Priority>(
      row.priority,
      PRIORITIES,
      'tasks',
      id,
      'priority'
    ),
    assignee: row.assignee,
    created: row.created,
    updated: row.updated,
    external: row.external,
    selfReview: row.self_review !== 0,
    ...(row.fix_loop === 0 ? { fixLoop: false } : {}),
    writes: parseStringArray(row.writes, 'tasks', id, 'writes'),
    risk: parseEnum<TaskRisk>(row.risk, TASK_RISKS, 'tasks', id, 'risk'),
    model: row.model,
    exercised: row.exercised !== 0,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.derived_from === null ? {} : { derivedFrom: row.derived_from }),
  };
}

function docFromRow(row: TaskRow): TaskDoc {
  return { meta: metaFromRow(row), body: row.body };
}

// The write-side inverse of metaFromRow. `fix_loop` is normalized the way
// serializeTaskFile normalizes it: only an explicit opt-out is persisted, so
// an in-memory `fixLoop: true` reads back as absent from both backends.
function rowValuesFromDoc(doc: TaskDoc, slug: string): SQLInputValue[] {
  const { meta } = doc;
  return [
    meta.id,
    meta.title,
    meta.status,
    meta.kind,
    meta.parent,
    meta.milestone,
    serializeStringArray(meta.blockedBy),
    serializeStringArray(meta.labels),
    meta.priority,
    meta.assignee,
    meta.created,
    meta.updated,
    meta.external,
    meta.selfReview ? 1 : 0,
    meta.fixLoop === false ? 0 : null,
    serializeStringArray(meta.writes),
    meta.risk,
    meta.model,
    meta.archivedAt ?? null,
    meta.exercised ? 1 : 0,
    meta.derivedFrom ?? null,
    slug,
    doc.body,
  ];
}

const TASK_COLUMNS = `
  id, title, status, kind, parent, milestone, blocked_by, labels, priority,
  assignee, created, updated, external, self_review, fix_loop, writes, risk,
  model, archived_at, exercised, derived_from, slug, body
`;
const TASK_PLACEHOLDERS =
  '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

// Claims an id or reports that someone else already holds it, in one
// statement. A `SELECT` followed by an `INSERT` leaves a window in between —
// and the daemon and the CLI share one database file — so the check has to be
// the write itself, not a question asked before it.
const INSERT_TASK_IF_ABSENT = `
INSERT INTO tasks (${TASK_COLUMNS}) VALUES (${TASK_PLACEHOLDERS})
ON CONFLICT (id) DO NOTHING
`;

// The overwriting write, used only where overwriting is the intent: update(),
// amend(), and the migration's put().
const UPSERT_TASK = `
INSERT INTO tasks (${TASK_COLUMNS}) VALUES (${TASK_PLACEHOLDERS})
ON CONFLICT (id) DO UPDATE SET
  title = excluded.title,
  status = excluded.status,
  kind = excluded.kind,
  parent = excluded.parent,
  milestone = excluded.milestone,
  blocked_by = excluded.blocked_by,
  labels = excluded.labels,
  priority = excluded.priority,
  assignee = excluded.assignee,
  created = excluded.created,
  updated = excluded.updated,
  external = excluded.external,
  self_review = excluded.self_review,
  fix_loop = excluded.fix_loop,
  writes = excluded.writes,
  risk = excluded.risk,
  model = excluded.model,
  archived_at = excluded.archived_at,
  exercised = excluded.exercised,
  derived_from = excluded.derived_from,
  slug = excluded.slug,
  body = excluded.body
`;

export class SqliteTaskStore implements TaskStorePort {
  constructor(
    readonly rootDir: string,
    // null when the project has no database yet. Attaching to a project must
    // not create one (see attachDispatchDb), so this store has to be able to
    // represent "nothing here": reads answer empty, writes refuse.
    private readonly handle: DatabaseSync | null,
    // Injectable for the same reason SqliteFindingStore's is: the collision
    // path in create() is unreachable from a test that cannot make the
    // generator repeat itself.
    private readonly generateId: (
      kind: TaskKind,
      title: string,
      now: string
    ) => string = generateTaskId
  ) {}

  // Mirrors the file backend, where this asks whether `.dispatch/tasks` is
  // there. A project whose database was never created reads as uninitialized
  // rather than as an empty project, so the CLI's "not a dispatch project"
  // guard keeps working.
  isInitialized(): boolean {
    return this.handle !== null;
  }

  create(input: CreateInput, now: string = new Date().toISOString()): TaskDoc {
    const kind = input.kind ?? 'task';
    const slug = slugify(input.title);
    let id = this.generateId(kind, input.title, now);
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const doc = this.newDoc(id, kind, input, now);
      const claimed = this.db
        .prepare(INSERT_TASK_IF_ABSENT)
        .run(...rowValuesFromDoc(doc, slug));
      if (claimed.changes > 0) return doc;
      id = this.generateId(kind, input.title, now);
    }
    // Same message the file backend raises, and the same meaning: the
    // generator kept handing back ids that are already taken.
    throw new Error(`id collision persisted: ${id}`);
  }

  get(id: string): TaskDoc | null {
    const row = this.rowOf(id);
    return row === null ? null : docFromRow(row);
  }

  list(filter: ListFilter = {}): TaskDoc[] {
    return this.rows(filter).map(docFromRow);
  }

  // The file backend's listSafe() exists because one unreadable task must not
  // abort a scan of the rest. A row damaged by a foreign writer — a JSON
  // column that will not parse, an enum outside its set — is exactly that
  // case here, so it is collected rather than thrown, keyed by task id where
  // the file backend keys by filename.
  listSafe(filter: ListFilter = {}): ListSafeResult {
    const docs: TaskDoc[] = [];
    const errors: ListSafeError[] = [];
    for (const row of this.rows(filter)) {
      try {
        docs.push(docFromRow(row));
      } catch (err) {
        if (!(err instanceof SqliteRowError)) throw err;
        errors.push({ file: row.id, message: err.message });
      }
    }
    return { docs, errors };
  }

  update(
    id: string,
    patch: UpdatePatch,
    now: string = new Date().toISOString()
  ): TaskDoc {
    const row = this.rowOf(id);
    if (row === null) throw new Error(`task not found: ${id}`);
    const doc = docFromRow(row);
    // Same split as TaskStore.update: the body-targeting keys are pulled out
    // before the rest are spread over the existing frontmatter.
    const {
      appendActivity: activityLine,
      activityActor,
      description,
      acceptanceCriteria,
      body: wholeBody,
      archivedAt,
      ...patchFields
    } = patch;
    const fields = Object.fromEntries(
      Object.entries(patchFields).filter(([, v]) => v !== undefined)
    );
    const meta: TaskMeta = { ...doc.meta, ...fields, updated: now };
    if (archivedAt === null) delete meta.archivedAt;
    else if (archivedAt !== undefined) meta.archivedAt = archivedAt;
    let body = wholeBody === undefined ? doc.body : normalizeBody(wholeBody);
    if (description !== undefined)
      body = setSection(body, 'Description', description);
    if (acceptanceCriteria !== undefined)
      body = setSection(body, 'Acceptance Criteria', acceptanceCriteria);
    if (activityLine) body = appendActivity(body, activityLine, activityActor);
    const next: TaskDoc = { meta, body };
    // The slug is the one the row already carries, not one recomputed from the
    // new title: the file backend writes back to the path it read, so
    // retitling a task never renames `<id>-<old-slug>.md`.
    this.write(next, row.slug);
    return next;
  }

  amend(
    id: string,
    input: Omit<Amendment, 'date'>,
    now: string = new Date().toISOString()
  ): TaskDoc {
    const row = this.rowOf(id);
    if (row === null) throw new Error(`task not found: ${id}`);
    const doc = docFromRow(row);
    const next: TaskDoc = {
      meta: { ...doc.meta, updated: now },
      body: appendAmendment(doc.body, { ...input, date: now }),
    };
    this.write(next, row.slug);
    return next;
  }

  remove(id: string): boolean {
    if (this.handle === null) return false;
    return (
      this.handle.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
    );
  }

  /**
   * The task as a `.dispatch/tasks/*.md` file would spell it: the filename the
   * file backend would use, plus serializeTaskFile's output. This is the
   * export half of the seam — how a row reaches the git receipt log, and how a
   * database-backed project hands an agent something it can read — and it is
   * why frontmatter columns have to round-trip exactly.
   *
   * Both halves of the filename are re-checked here rather than trusted. This
   * database is shared (the daemon writes it, the CLI reads it), so a row can
   * arrive from a writer that never went through create() or put(), and an
   * `id` or `slug` carrying `../` would turn an export into a write outside
   * the tasks directory.
   */
  toMarkdown(id: string): { filename: string; content: string } | null {
    const row = this.rowOf(id);
    if (row === null) return null;
    if (!isTaskId(row.id)) {
      throw new SqliteRowError('tasks', row.id, 'id', 'is not a task id');
    }
    if (row.slug !== slugify(row.slug)) {
      throw new SqliteRowError(
        'tasks',
        row.id,
        'slug',
        `is not a slug: ${row.slug.slice(0, 80)}`
      );
    }
    return {
      filename: `${row.id}-${row.slug}.md`,
      content: serializeTaskFile(docFromRow(row)),
    };
  }

  /**
   * Imports an already-parsed task document verbatim — used by the one-time
   * migration that reads `.dispatch/tasks/*.md` into the database, which must
   * preserve each task's own created/updated stamps rather than mint new ones
   * the way create() does.
   *
   * The id is gated the way the file backend gates it in taskFilePath(): an id
   * outside `<t|e>-<6 hex>` never becomes part of a filename. The slug is
   * normalized rather than rejected, since slugify is idempotent — a real slug
   * survives unchanged and anything else is reduced to slug characters.
   */
  put(doc: TaskDoc, slug: string = slugify(doc.meta.title)): TaskDoc {
    if (!isTaskId(doc.meta.id)) {
      throw new Error(`not a task id: ${doc.meta.id}`);
    }
    this.write(doc, slugify(slug));
    return doc;
  }

  // The database handle, for the paths that write. A store attached to a
  // project with no database refuses rather than silently dropping the write.
  private get db(): DatabaseSync {
    if (this.handle === null) {
      throw new Error(
        `no dispatch database for ${this.rootDir}: initProjectStores() creates one, openProjectStores() attaches to an existing one`
      );
    }
    return this.handle;
  }

  private newDoc(
    id: string,
    kind: TaskKind,
    input: CreateInput,
    now: string
  ): TaskDoc {
    const meta: TaskMeta = {
      id,
      title: input.title,
      status: input.status ?? 'todo',
      kind,
      parent: input.parent ?? null,
      milestone: input.milestone ?? null,
      blockedBy: input.blockedBy ?? [],
      labels: input.labels ?? [],
      priority: input.priority ?? 'none',
      assignee: input.assignee ?? 'none',
      created: now,
      updated: now,
      external: null,
      selfReview: input.selfReview ?? true,
      ...(input.fixLoop === false ? { fixLoop: false } : {}),
      writes: input.writes ?? [],
      risk: input.risk ?? 'routine',
      model: input.model ?? null,
      exercised: false,
      ...(input.derivedFrom === undefined
        ? {}
        : { derivedFrom: input.derivedFrom }),
    };
    // Identical to TaskStore.create's template, escaped the same way, so a
    // task created against either backend reads the same.
    const description = escapeHeadingLines(input.description ?? '');
    const body = `\n## Description\n\n${description}\n\n## Acceptance Criteria\n\n## Activity\n`;
    return { meta, body };
  }

  private rows(filter: ListFilter): TaskRow[] {
    if (this.handle === null) return [];
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.parent !== undefined) {
      clauses.push('parent = ?');
      params.push(filter.parent);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    // Same order as TaskStore.filterAndSort: by created, ties broken by id.
    // SQLite's default BINARY collation orders the ISO timestamps and hex ids
    // these columns hold exactly the way localeCompare does.
    return queryAll<TaskRow>(
      this.handle,
      `SELECT * FROM tasks${where} ORDER BY created, id`,
      params
    );
  }

  // One SELECT per task, shared by every path that needs the row rather than
  // the document — update() and amend() need its slug, toMarkdown() needs both
  // halves of the filename.
  private rowOf(id: string): TaskRow | null {
    if (this.handle === null) return null;
    return (
      queryOne<TaskRow>(this.handle, 'SELECT * FROM tasks WHERE id = ?', [
        id,
      ]) ?? null
    );
  }

  private write(doc: TaskDoc, slug: string): void {
    this.db.prepare(UPSERT_TASK).run(...rowValuesFromDoc(doc, slug));
  }
}
