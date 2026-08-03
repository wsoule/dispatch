import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { generateTaskId } from './ids.js';
import { slugify } from './slug.js';
import {
  appendActivity,
  appendAmendment,
  escapeHeadingLines,
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

const DEFAULT_CONFIG = `statuses: [backlog, todo, in-progress, in-review, done, cancelled]
autoCommit: false
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
  writes?: string[];
  risk?: TaskRisk;
  model?: string | null;
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
  // Free-text body sections (replaced via taskfile.ts's setSection), edited
  // the same way as frontmatter fields but living in the markdown body.
  description?: string;
  acceptanceCriteria?: string;
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

export class TaskStore {
  readonly tasksDir: string;

  constructor(readonly rootDir: string) {
    this.tasksDir = join(rootDir, DISPATCH_DIR, 'tasks');
  }

  static init(rootDir: string): TaskStore {
    const store = new TaskStore(rootDir);
    mkdirSync(store.tasksDir, { recursive: true });
    const cfg = join(rootDir, DISPATCH_DIR, 'config.yml');
    if (!existsSync(cfg)) writeFileSync(cfg, DEFAULT_CONFIG);
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
      writes: input.writes ?? [],
      risk: input.risk ?? 'routine',
      model: input.model ?? null,
      exercised: false,
    };
    // The initial description is caller-supplied, so it's escaped the same
    // way setSection escapes a later edit to the same section.
    const description = escapeHeadingLines(input.description ?? '');
    const body = `\n## Description\n\n${description}\n\n## Acceptance Criteria\n\n## Activity\n`;
    const doc: TaskDoc = { meta, body };
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
    // description/acceptanceCriteria/appendActivity target the markdown body,
    // not the frontmatter, so they're pulled out before the meta spread below.
    const {
      appendActivity: activityLine,
      description,
      acceptanceCriteria,
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
    let body = doc.body;
    if (description !== undefined)
      body = setSection(body, 'Description', description);
    if (acceptanceCriteria !== undefined)
      body = setSection(body, 'Acceptance Criteria', acceptanceCriteria);
    if (activityLine) body = appendActivity(body, activityLine);
    const next: TaskDoc = { meta, body };
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

  taskFilePath(id: string): string | null {
    if (!/^[te]-[0-9a-f]{6}$/.test(id)) return null;
    if (!this.isInitialized()) return null;
    const hit = readdirSync(this.tasksDir).find(
      (f) => f === `${id}.md` || f.startsWith(`${id}-`)
    );
    return hit ? join(this.tasksDir, hit) : null;
  }
}
