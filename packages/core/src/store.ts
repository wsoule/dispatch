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
  parseTaskFile,
  serializeTaskFile,
} from './taskfile.js';
import type {
  Assignee,
  Priority,
  TaskDoc,
  TaskKind,
  TaskMeta,
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
  blockedBy?: string[];
  labels?: string[];
  priority?: Priority;
  assignee?: Assignee;
}

export interface UpdatePatch {
  title?: string;
  status?: string;
  parent?: string | null;
  blockedBy?: string[];
  labels?: string[];
  priority?: Priority;
  assignee?: Assignee;
  appendActivity?: string;
}

export interface ListFilter {
  status?: string;
  kind?: TaskKind;
  parent?: string;
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
      blockedBy: input.blockedBy ?? [],
      labels: input.labels ?? [],
      priority: input.priority ?? 'none',
      assignee: input.assignee ?? 'none',
      created: now,
      updated: now,
      external: null,
    };
    const body = `\n## Description\n\n${input.description ?? ''}\n\n## Acceptance Criteria\n\n## Activity\n`;
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
    const { appendActivity: activityLine, ...patchFields } = patch;
    // Drop undefined entries so a partial patch never blanks existing fields.
    const fields = Object.fromEntries(
      Object.entries(patchFields).filter(([, v]) => v !== undefined)
    );
    const meta: TaskMeta = { ...doc.meta, ...fields, updated: now };
    let body = doc.body;
    if (activityLine) body = appendActivity(body, activityLine);
    const next: TaskDoc = { meta, body };
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
