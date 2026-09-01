import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { generateTaskId, isTaskId } from './ids.js';
import { slugify } from './slug.js';
import type { TaskStoreBackend } from './storeBackend.js';
import {
  appendActivity,
  appendAmendment,
  escapeHeadingLines,
  normalizeBody,
  parseTaskFile,
  serializeTaskFile,
  setSection,
} from './taskfile.js';
import type { Amendment } from './taskfile.js';
import type {
  Assignee,
  Priority,
  TaskDoc,
  TaskKind,
  TaskMeta,
  TaskRisk,
} from './types.js';

export const DISPATCH_DIR = '.dispatch';

// New projects opt into the board syncer by default; every project
// initialized before this plan has `autoCommit: false` already written to
// its own config.yml, so loadConfig's file value wins and nothing existing
// starts pushing.
const DEFAULT_CONFIG = `statuses: [backlog, todo, in-progress, in-review, done, cancelled]
autoCommit: true
`;

export interface CreateInput {
  title: string;
  kind?: TaskKind;
  status?: string;
  description?: string;
  parent?: string | null;
  milestone?: string | null;
  blockedBy?: string[];
  labels?: string[];
  priority?: Priority;
  assignee?: Assignee;
  selfReview?: boolean;
  // Per-task opt-out of the automatic fix loop; only `false` is recorded.
  fixLoop?: boolean;
  writes?: string[];
  risk?: TaskRisk;
  model?: string | null;
  // What this task was synthesized from (see TaskMeta.derivedFrom). Set only
  // by the code that synthesizes one; a person creating a task never passes it.
  derivedFrom?: string;
}

export interface UpdatePatch {
  title?: string;
  status?: string;
  parent?: string | null;
  milestone?: string | null;
  blockedBy?: string[];
  labels?: string[];
  priority?: Priority;
  assignee?: Assignee;
  selfReview?: boolean;
  // Per-task opt-out of the automatic fix loop; `true` restores the default.
  fixLoop?: boolean;
  writes?: string[];
  risk?: TaskRisk;
  // null clears a per-task override, falling back to config.models.
  model?: string | null;
  // The id of this task in an external tracker (`linear:<uuid>`), or null to unlink it.
  external?: string | null;
  // null clears archivedAt (unarchive); a string sets it; undefined leaves it untouched.
  archivedAt?: string | null;
  // Set once a verify run passes. Never cleared by a patch — a later failing
  // verify run leaves it exactly as it was.
  exercised?: boolean;
  appendActivity?: string;
  // The serialized ActorRef credited for `appendActivity`. Omitted leaves the
  // line unattributed, which is what pre-team task files already look like.
  activityActor?: string;
  // Free-text body sections (replaced via taskfile.ts's setSection), edited
  // the same way as frontmatter fields but living in the markdown body.
  description?: string;
  acceptanceCriteria?: string;
  // The whole markdown body — everything after the frontmatter — replaced
  // wholesale rather than a section at a time. This is what the desktop's
  // task body editor writes; unlike description/acceptanceCriteria it does
  // NOT go through setSection, so it can add, reorder, or drop sections.
  body?: string;
}

export interface ListFilter {
  status?: string;
  kind?: TaskKind;
  parent?: string;
}

// One skipped file from a listSafe() scan: which file failed and why (a
// TaskParseError's message, e.g. "missing frontmatter field: id").
export interface ListSafeError {
  file: string;
  message: string;
}

export interface ListSafeResult {
  docs: TaskDoc[];
  errors: ListSafeError[];
}

/**
 * The backend-neutral task surface, extracted so a second backend can sit
 * behind it: `TaskStore` (markdown files under `.dispatch/tasks`) and
 * `SqliteTaskStore` (a single daemon-owned database) both satisfy it, and
 * picking between them is a construction-time choice — see
 * `openProjectStores` in storeBackend.ts.
 *
 * Filesystem-only members are deliberately left off: `tasksDir` and
 * `taskFilePath` have no answer in a database-backed project, so a caller
 * that needs a path on disk has to hold a concrete `TaskStore`, not a port.
 */
export interface TaskStorePort {
  readonly rootDir: string;
  isInitialized(): boolean;
  create(input: CreateInput, now?: string): TaskDoc;
  get(id: string): TaskDoc | null;
  list(filter?: ListFilter): TaskDoc[];
  listSafe(filter?: ListFilter): ListSafeResult;
  update(id: string, patch: UpdatePatch, now?: string): TaskDoc;
  amend(id: string, input: Omit<Amendment, 'date'>, now?: string): TaskDoc;
  remove(id: string): boolean;
}

/**
 * The TaskDoc a freshly created task starts as — every default in one place.
 *
 * Shared by both backends rather than written out twice. The defaults here
 * (`status: 'todo'`, `priority: 'none'`, `selfReview: true`, the absent-vs-
 * false handling of `fixLoop`, the body template) ARE the contract for what a
 * new task looks like, so a copy per backend is a copy that can drift — and a
 * task created against one backend would quietly differ from the same task
 * created against the other.
 *
 * Pure: the caller supplies the id, since minting one is the part the two
 * backends genuinely do differently (a filename probe versus an insert that
 * may lose a race).
 */
export function newTaskDoc(
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
  // The initial description is caller-supplied, so it's escaped the same
  // way setSection escapes a later edit to the same section.
  const description = escapeHeadingLines(input.description ?? '');
  const body = `\n## Description\n\n${description}\n\n## Acceptance Criteria\n\n## Activity\n`;
  return { meta, body };
}

/**
 * Applies an `UpdatePatch` to an existing doc, producing the next one.
 *
 * The other half of the create/update contract both backends have to agree
 * on: which patch keys target the markdown body rather than the frontmatter,
 * that `undefined` means "leave alone" while `null` on `archivedAt` means
 * "clear", and that a whole-body replacement is the base later section edits
 * apply to. Shared for the same reason as `newTaskDoc` — this is behaviour,
 * not plumbing, and two copies of it can disagree.
 *
 * Pure: persisting the result is the caller's job.
 */
export function applyUpdatePatch(
  doc: TaskDoc,
  patch: UpdatePatch,
  now: string
): TaskDoc {
  // body/description/acceptanceCriteria/appendActivity target the markdown
  // body, not the frontmatter, so they're pulled out before the meta spread
  // below.
  const {
    appendActivity: activityLine,
    activityActor,
    description,
    acceptanceCriteria,
    body: wholeBody,
    archivedAt,
    ...patchFields
  } = patch;
  // Drop undefined entries so a partial patch never blanks existing fields.
  const fields = Object.fromEntries(
    Object.entries(patchFields).filter(([, v]) => v !== undefined)
  );
  const meta: TaskMeta = { ...doc.meta, ...fields, updated: now };
  // archivedAt is string|undefined on TaskMeta, so null (clear) is handled
  // separately rather than spread in like the other fields.
  if (archivedAt === null) delete meta.archivedAt;
  else if (archivedAt !== undefined) meta.archivedAt = archivedAt;
  // A whole-body replacement is the new base the section edits below apply
  // to, so a patch carrying both `body` and `description` lands the rewrite
  // first and then the section edit on top of it, rather than depending on
  // which field the caller happened to set.
  let body = wholeBody === undefined ? doc.body : normalizeBody(wholeBody);
  if (description !== undefined)
    body = setSection(body, 'Description', description);
  if (acceptanceCriteria !== undefined)
    body = setSection(body, 'Acceptance Criteria', acceptanceCriteria);
  if (activityLine) body = appendActivity(body, activityLine, activityActor);
  return { meta, body };
}

// Writes the starter `.dispatch/config.yml` if the project has none. Config
// stays a plain committable file whichever backend holds the tasks, so both
// initializers call this rather than each spelling out the default.
export function ensureProjectConfig(rootDir: string): void {
  const dir = join(rootDir, DISPATCH_DIR);
  mkdirSync(dir, { recursive: true });
  const cfg = join(dir, 'config.yml');
  if (!existsSync(cfg)) writeFileSync(cfg, DEFAULT_CONFIG);
}

// What `.dispatch/.gitignore` excludes, per backend.
//
// `dispatch.db` is the entry that matters and the one that was missing: until
// now nothing shipped an ignore rule for it to a user's project. Dispatch's
// own repo has one, hand-written in its root .gitignore, which is exactly why
// the gap stayed invisible — every developer working ON dispatch was covered
// and every project using it was not. A migrated project would commit its
// database, its `-wal` and its `-shm` on the next `git add .`.
//
// The three sqlite-only entries are the state that has no table yet, so the
// daemon still writes it here as files on both backends. On `files` they stay
// committable: git is that backend's sync layer, and a teammate's inbox
// arriving with a pull is the behaviour those projects already have. On
// `sqlite` git is no longer the sync layer, so they are local working state
// and committing them only produces churn.
//
// `storage.json` is ignored too, and that is a decided trade-off rather than
// an oversight (t-880ce2). Committing the marker is the more attractive idea —
// it would tell a fresh clone "this board is in a database, restore it from
// the receipt log" instead of leaving the project looking uninitialized. But
// the database it names is per-machine and is NOT in the clone, so a committed
// marker produces a project that insists its board lives somewhere that does
// not exist: the daemon serves an empty board while the CLI and MCP, reading
// the same marker, refuse to fall back to any files they can see. An
// uninitialized-looking clone is recoverable; a confidently-empty one is the
// trap. Keep this in step with the boot import in server/src/index.ts, which
// exists precisely to repair a project that arrives in that state.
const IGNORE_HEADER = `# Written by dispatch. Add your own entries below; dispatch only ever
# appends the lines it needs and never rewrites this file.`;

/** Rules plus the comment that explains them, kept together so a top-up that
 *  appends one never appends the other on its own. */
interface IgnoreGroup {
  comments: string[];
  rules: string[];
}

const MACHINE_LOCAL_GROUP: IgnoreGroup = {
  comments: [
    "# The daemon's database is per-machine state, never committable, and",
    '# neither is the marker naming it — a clone carrying the marker without',
    '# the database reads as a board that is confidently empty.',
  ],
  rules: ['dispatch.db', 'dispatch.db-wal', 'dispatch.db-shm', 'storage.json'],
};

const DAEMON_STATE_GROUP: IgnoreGroup = {
  comments: [
    '# Daemon working state that has no database table yet, so it is still',
    '# written here as files rather than held in dispatch.db.',
  ],
  rules: ['fix-loops.jsonl', 'notes.json', 'inbox/'],
};

function ignoreGroupsFor(backend: TaskStoreBackend): IgnoreGroup[] {
  return backend === 'sqlite'
    ? [MACHINE_LOCAL_GROUP, DAEMON_STATE_GROUP]
    : [MACHINE_LOCAL_GROUP];
}

/**
 * Writes (or tops up) `.dispatch/.gitignore` so a project never commits the
 * state the daemon owns.
 *
 * Additive, never a rewrite: an existing file keeps everything in it and only
 * gains the rules it is missing. A user who pinned an extra path here, or
 * deliberately un-ignored one of ours by deleting the line, would otherwise
 * have that undone on the next `dispatch init` — and silently, since nothing
 * about running init suggests it edits files you already have.
 *
 * A group is appended only when one of its RULES is missing, never because its
 * comment is: a project that moves to the database has the machine-local rules
 * already, and re-appending their explanation every time would grow a comment
 * block on every init.
 */
export function ensureProjectGitignore(
  rootDir: string,
  backend: TaskStoreBackend
): void {
  const dir = join(rootDir, DISPATCH_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.gitignore');
  const groups = ignoreGroupsFor(backend);
  if (!existsSync(path)) {
    const body = groups.flatMap((group, index) => [
      ...(index === 0 ? [] : ['']),
      ...group.comments,
      ...group.rules,
    ]);
    writeFileSync(path, `${[IGNORE_HEADER, ...body].join('\n')}\n`);
    return;
  }
  const existing = new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
  );
  const additions = groups.flatMap((group) => {
    const missing = group.rules.filter((rule) => !existing.has(rule));
    return missing.length === 0 ? [] : ['', ...group.comments, ...missing];
  });
  if (additions.length === 0) return;
  appendFileSync(path, `${additions.join('\n')}\n`);
}

export class TaskStore implements TaskStorePort {
  readonly tasksDir: string;

  constructor(readonly rootDir: string) {
    this.tasksDir = join(rootDir, DISPATCH_DIR, 'tasks');
  }

  static init(rootDir: string): TaskStore {
    const store = new TaskStore(rootDir);
    mkdirSync(store.tasksDir, { recursive: true });
    ensureProjectConfig(rootDir);
    return store;
  }

  isInitialized(): boolean {
    return existsSync(this.tasksDir);
  }

  create(input: CreateInput, now: string = new Date().toISOString()): TaskDoc {
    const kind = input.kind ?? 'task';
    let id = generateTaskId(kind, input.title, now);
    for (let i = 0; i < 5 && this.taskFilePath(id); i++) {
      id = generateTaskId(kind, input.title, now);
    }
    if (this.taskFilePath(id)) throw new Error(`id collision persisted: ${id}`);
    const doc = newTaskDoc(id, kind, input, now);
    writeFileSync(
      join(this.tasksDir, `${id}-${slugify(input.title)}.md`),
      serializeTaskFile(doc)
    );
    return doc;
  }

  get(id: string): TaskDoc | null {
    const file = this.taskFilePath(id);
    if (!file) return null;
    return parseTaskFile(readFileSync(file, 'utf8'), file);
  }

  list(filter: ListFilter = {}): TaskDoc[] {
    if (!this.isInitialized()) return [];
    const docs = readdirSync(this.tasksDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) =>
        parseTaskFile(readFileSync(join(this.tasksDir, f), 'utf8'), f)
      );
    return this.filterAndSort(docs, filter);
  }

  // Same scan as list(), but a bad file is collected as an error instead of
  // aborting the scan — used where one bad file must not stop the rest.
  listSafe(filter: ListFilter = {}): ListSafeResult {
    if (!this.isInitialized()) return { docs: [], errors: [] };
    const docs: TaskDoc[] = [];
    const errors: ListSafeError[] = [];
    for (const f of readdirSync(this.tasksDir).filter((f) =>
      f.endsWith('.md')
    )) {
      try {
        docs.push(
          parseTaskFile(readFileSync(join(this.tasksDir, f), 'utf8'), f)
        );
      } catch (err) {
        errors.push({ file: f, message: (err as Error).message });
      }
    }
    return { docs: this.filterAndSort(docs, filter), errors };
  }

  // Shared filter + sort for list()/listSafe(): by status/kind/parent, then
  // by created timestamp (ties broken by id), so both return the same order.
  private filterAndSort(docs: TaskDoc[], filter: ListFilter): TaskDoc[] {
    return docs
      .filter((d) =>
        filter.status !== undefined ? d.meta.status === filter.status : true
      )
      .filter((d) =>
        filter.kind !== undefined ? d.meta.kind === filter.kind : true
      )
      .filter((d) =>
        filter.parent !== undefined ? d.meta.parent === filter.parent : true
      )
      .sort((a, b) => {
        const byCreated = a.meta.created.localeCompare(b.meta.created);
        return byCreated !== 0 ? byCreated : a.meta.id.localeCompare(b.meta.id);
      });
  }

  update(
    id: string,
    patch: UpdatePatch,
    now: string = new Date().toISOString()
  ): TaskDoc {
    const file = this.taskFilePath(id);
    if (!file) throw new Error(`task not found: ${id}`);
    const doc = parseTaskFile(readFileSync(file, 'utf8'), file);
    const next = applyUpdatePatch(doc, patch, now);
    writeFileSync(file, serializeTaskFile(next));
    return next;
  }

  // Records a dated, sourced correction against a task's spec, additive to
  // whatever amendments already exist rather than replacing them.
  amend(
    id: string,
    input: Omit<Amendment, 'date'>,
    now: string = new Date().toISOString()
  ): TaskDoc {
    const file = this.taskFilePath(id);
    if (!file) throw new Error(`task not found: ${id}`);
    const doc = parseTaskFile(readFileSync(file, 'utf8'), file);
    const body = appendAmendment(doc.body, { ...input, date: now });
    const next: TaskDoc = { meta: { ...doc.meta, updated: now }, body };
    writeFileSync(file, serializeTaskFile(next));
    return next;
  }

  // Deletes a task file outright — the rollback half of create(), for a
  // caller that synthesized a task for work which then failed to start.
  // Not how a user retires a task: that is `archivedAt` on update().
  remove(id: string): boolean {
    const file = this.taskFilePath(id);
    if (file === null) return false;
    rmSync(file, { force: true });
    return true;
  }

  taskFilePath(id: string): string | null {
    if (!isTaskId(id)) return null;
    if (!this.isInitialized()) return null;
    const hit = readdirSync(this.tasksDir).find(
      (f) => f === `${id}.md` || f.startsWith(`${id}-`)
    );
    return hit ? join(this.tasksDir, hit) : null;
  }
}
