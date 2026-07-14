# Phase 1: Core + CLI Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working git-native task tracker: `@dispatch/core` (task files as markdown+YAML frontmatter, hash IDs, dependency graph, file-based store) and a `dispatch` CLI (init, task create/list/show/edit/status, next, doctor).

**Architecture:** TypeScript pnpm monorepo. `packages/core` owns the task file format and all task logic with zero CLI/HTTP concerns; `packages/cli` is a thin commander wrapper around core, testable programmatically via `makeProgram(ctx)`. Tasks live in `.dispatch/tasks/*.md` in the target repo; no database in this phase (directory scans).

**Tech Stack:** Node ≥ 22, pnpm workspaces, TypeScript (strict, ESM/NodeNext), vitest, `yaml`, `commander`, `execa` (dev, e2e only).

## Global Constraints

- Node `>=22`, pnpm `>=9`, ESM only (`"type": "module"`), TS `strict: true`, module/moduleResolution `NodeNext`.
- Runtime deps allowed in this phase: `yaml`, `commander`. Nothing else (no DB, no HTTP).
- License Apache-2.0. Conventional-commit messages (`feat:`, `test:`, `chore:`, `docs:`).
- Task frontmatter keys are kebab-case on disk (`blocked-by`), camelCase in code (`blockedBy`).
- Statuses: `backlog | todo | in-progress | in-review | done | cancelled`. Kinds: `task | epic`. Priorities: `urgent | high | medium | low | none`. Assignees: `agent | human | none`.
- IDs: `t-`/`e-` + first 6 hex of sha256(`${now}\n${title}\n${nonce}`).
- Timestamps are ISO 8601 UTC strings; core functions accept `now` as a parameter (defaulted) so tests are deterministic.
- All CLI read commands support `--json`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `LICENSE`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`

**Interfaces:**
- Produces: workspace layout + `pnpm -r test` / `pnpm -r build` conventions every later task relies on. `@dispatch/core` package name.

- [ ] **Step 1: Write workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`package.json`:
```json
{
  "name": "dispatch-monorepo",
  "private": true,
  "license": "Apache-2.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
.superpowers/
```

- [ ] **Step 2: Fetch the Apache-2.0 license text**

Run: `curl -fsS https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE`
Expected: `LICENSE` exists, first line contains "Apache License".

- [ ] **Step 3: Create packages/core**

`packages/core/package.json`:
```json
{
  "name": "@dispatch/core",
  "version": "0.0.1",
  "type": "module",
  "license": "Apache-2.0",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "yaml": "^2.6.0" },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.0.1';
```

`packages/core/test/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { CORE_VERSION } from '../src/index.js';

describe('smoke', () => {
  it('imports the package', () => {
    expect(CORE_VERSION).toBe('0.0.1');
  });
});
```

- [ ] **Step 4: Install and verify**

Run: `pnpm install && pnpm -r test && pnpm -r build`
Expected: smoke test PASS; `packages/core/dist/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm/TypeScript monorepo with @dispatch/core"
```

---

### Task 2: Types, ID generation, slugify

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/ids.ts`, `packages/core/src/slug.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/ids.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `TaskStatus`, `TaskKind`, `Priority`, `Assignee` union types; `interface TaskMeta { id: string; title: string; status: TaskStatus; kind: TaskKind; parent: string | null; blockedBy: string[]; labels: string[]; priority: Priority; assignee: Assignee; created: string; updated: string; external: string | null }`; `interface TaskDoc { meta: TaskMeta; body: string }`
  - `generateTaskId(kind: TaskKind, title: string, now: string, nonce?: string): string`
  - `slugify(title: string): string`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/ids.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { generateTaskId } from '../src/ids.js';
import { slugify } from '../src/slug.js';

describe('generateTaskId', () => {
  it('prefixes tasks with t- and epics with e-, 6 hex chars', () => {
    expect(generateTaskId('task', 'Fix login', '2026-07-13T00:00:00Z', 'n1')).toMatch(/^t-[0-9a-f]{6}$/);
    expect(generateTaskId('epic', 'Auth', '2026-07-13T00:00:00Z', 'n1')).toMatch(/^e-[0-9a-f]{6}$/);
  });
  it('is deterministic for identical inputs, differs across nonces', () => {
    const a = generateTaskId('task', 'X', '2026-01-01T00:00:00Z', 'n1');
    expect(generateTaskId('task', 'X', '2026-01-01T00:00:00Z', 'n1')).toBe(a);
    expect(generateTaskId('task', 'X', '2026-01-01T00:00:00Z', 'n2')).not.toBe(a);
  });
  it('generates a random nonce when omitted', () => {
    const a = generateTaskId('task', 'X', '2026-01-01T00:00:00Z');
    const b = generateTaskId('task', 'X', '2026-01-01T00:00:00Z');
    expect(a).not.toBe(b);
  });
});

describe('slugify', () => {
  it('lowercases, replaces non-alphanumerics with dashes, collapses and trims', () => {
    expect(slugify('Fix Login: Redirect Loop!')).toBe('fix-login-redirect-loop');
  });
  it('caps length at 40 chars without trailing dash', () => {
    const s = slugify('word '.repeat(30));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test`
Expected: FAIL — cannot resolve `../src/ids.js`.

- [ ] **Step 3: Implement**

`packages/core/src/types.ts`:
```ts
export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'in-review' | 'done' | 'cancelled';
export type TaskKind = 'task' | 'epic';
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
export type Assignee = 'agent' | 'human' | 'none';

export interface TaskMeta {
  id: string;
  title: string;
  status: TaskStatus;
  kind: TaskKind;
  parent: string | null;
  blockedBy: string[];
  labels: string[];
  priority: Priority;
  assignee: Assignee;
  created: string;
  updated: string;
  external: string | null;
}

export interface TaskDoc {
  meta: TaskMeta;
  body: string;
}

export const STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in-progress', 'in-review', 'done', 'cancelled'];
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
```

`packages/core/src/ids.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import type { TaskKind } from './types.js';

export function generateTaskId(
  kind: TaskKind,
  title: string,
  now: string,
  nonce: string = randomBytes(4).toString('hex'),
): string {
  const prefix = kind === 'epic' ? 'e' : 't';
  const hash = createHash('sha256').update(`${now}\n${title}\n${nonce}`).digest('hex').slice(0, 6);
  return `${prefix}-${hash}`;
}
```

`packages/core/src/slug.ts`:
```ts
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
```

`packages/core/src/index.ts` (replace contents):
```ts
export const CORE_VERSION = '0.0.1';
export * from './types.js';
export { generateTaskId } from './ids.js';
export { slugify } from './slug.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core test`
Expected: PASS (smoke + 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): task types, hash-based id generation, slugify"
```

---

### Task 3: Task file parse/serialize

**Files:**
- Create: `packages/core/src/taskfile.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/taskfile.test.ts`

**Interfaces:**
- Consumes: `TaskDoc`, `TaskMeta` from Task 2.
- Produces: `parseTaskFile(content: string): TaskDoc` (throws `TaskParseError`), `serializeTaskFile(doc: TaskDoc): string`, `class TaskParseError extends Error`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/taskfile.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseTaskFile, serializeTaskFile, TaskParseError } from '../src/taskfile.js';
import type { TaskDoc } from '../src/types.js';

const doc: TaskDoc = {
  meta: {
    id: 't-3fa9c2', title: 'Fix login redirect loop', status: 'todo', kind: 'task',
    parent: 'e-8b21d0', blockedBy: ['t-91c4aa'], labels: ['bug', 'auth'],
    priority: 'high', assignee: 'agent',
    created: '2026-07-13T18:04:00Z', updated: '2026-07-13T18:04:00Z', external: null,
  },
  body: '\n## Description\n\nStuff.\n\n## Acceptance Criteria\n\n## Activity\n',
};

describe('serializeTaskFile / parseTaskFile', () => {
  it('round-trips exactly', () => {
    const text = serializeTaskFile(doc);
    expect(parseTaskFile(text)).toEqual(doc);
    expect(serializeTaskFile(parseTaskFile(text))).toBe(text);
  });
  it('writes kebab-case blocked-by in frontmatter', () => {
    expect(serializeTaskFile(doc)).toContain('blocked-by:');
  });
  it('applies defaults for optional fields', () => {
    const text = [
      '---',
      'id: t-aaaaaa', 'title: Minimal', 'status: todo', 'kind: task',
      'created: 2026-07-13T00:00:00Z', 'updated: 2026-07-13T00:00:00Z',
      '---', 'body',
    ].join('\n');
    const parsed = parseTaskFile(text);
    expect(parsed.meta.blockedBy).toEqual([]);
    expect(parsed.meta.labels).toEqual([]);
    expect(parsed.meta.parent).toBeNull();
    expect(parsed.meta.priority).toBe('none');
    expect(parsed.meta.assignee).toBe('none');
    expect(parsed.meta.external).toBeNull();
    expect(parsed.body).toBe('body');
  });
  it('throws TaskParseError on missing frontmatter or required field', () => {
    expect(() => parseTaskFile('no frontmatter')).toThrow(TaskParseError);
    expect(() => parseTaskFile('---\ntitle: X\n---\n')).toThrow(/missing frontmatter field: id/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test`
Expected: FAIL — cannot resolve `../src/taskfile.js`.

- [ ] **Step 3: Implement**

`packages/core/src/taskfile.ts`:
```ts
import YAML from 'yaml';
import type { Assignee, Priority, TaskDoc, TaskKind, TaskMeta, TaskStatus } from './types.js';

export class TaskParseError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message);
    this.name = 'TaskParseError';
  }
}

const REQUIRED = ['id', 'title', 'status', 'kind', 'created', 'updated'] as const;

export function parseTaskFile(content: string, file?: string): TaskDoc {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) throw new TaskParseError('missing frontmatter', file);
  let raw: Record<string, unknown>;
  try {
    raw = YAML.parse(m[1]) ?? {};
  } catch (err) {
    throw new TaskParseError(`invalid YAML frontmatter: ${(err as Error).message}`, file);
  }
  for (const key of REQUIRED) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new TaskParseError(`missing frontmatter field: ${key}`, file);
    }
  }
  const meta: TaskMeta = {
    id: String(raw.id),
    title: String(raw.title),
    status: raw.status as TaskStatus,
    kind: raw.kind as TaskKind,
    parent: (raw.parent as string | null) ?? null,
    blockedBy: (raw['blocked-by'] as string[]) ?? [],
    labels: (raw.labels as string[]) ?? [],
    priority: ((raw.priority as Priority) ?? 'none'),
    assignee: ((raw.assignee as Assignee) ?? 'none'),
    created: String(raw.created),
    updated: String(raw.updated),
    external: (raw.external as string | null) ?? null,
  };
  return { meta, body: content.slice(m[0].length) };
}

export function serializeTaskFile(doc: TaskDoc): string {
  const { meta } = doc;
  const fm = {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    kind: meta.kind,
    parent: meta.parent,
    'blocked-by': meta.blockedBy,
    labels: meta.labels,
    priority: meta.priority,
    assignee: meta.assignee,
    created: meta.created,
    updated: meta.updated,
    external: meta.external,
  };
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n${doc.body}`;
}
```

Add to `packages/core/src/index.ts`:
```ts
export { parseTaskFile, serializeTaskFile, TaskParseError } from './taskfile.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core test`
Expected: PASS.

Note: if the round-trip test fails on timestamp quoting, YAML 1.2 core schema (the `yaml` default) treats `2026-07-13T18:04:00Z` as a plain string — it must NOT become a `Date`. The `String(raw.created)` guards this; do not add a custom schema.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): task file frontmatter parse/serialize with round-trip fidelity"
```

---

### Task 4: Activity log append

**Files:**
- Modify: `packages/core/src/taskfile.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/activity.test.ts`

**Interfaces:**
- Produces: `appendActivity(body: string, line: string): string` — appends `- <line>` to the `## Activity` section. Convention (documented in code): **Activity is always the last section of the body**; the store's create template guarantees this.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/activity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { appendActivity } from '../src/taskfile.js';

describe('appendActivity', () => {
  it('appends a bullet to an existing Activity section', () => {
    const body = '\n## Description\n\nX\n\n## Activity\n';
    const out = appendActivity(body, '2026-07-13T19:00Z created');
    expect(out.endsWith('## Activity\n- 2026-07-13T19:00Z created\n')).toBe(true);
  });
  it('accumulates multiple entries in order', () => {
    let body = '\n## Activity\n';
    body = appendActivity(body, 'first');
    body = appendActivity(body, 'second');
    expect(body).toContain('- first\n- second\n');
  });
  it('creates the section when missing', () => {
    const out = appendActivity('\n## Description\n\nX\n', 'note');
    expect(out).toContain('## Activity\n\n- note\n');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test`
Expected: FAIL — `appendActivity` not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/taskfile.ts`:
```ts
/**
 * Appends an activity bullet. Assumes `## Activity` is the LAST section of the
 * body (the store's create template guarantees this).
 */
export function appendActivity(body: string, line: string): string {
  const entry = `- ${line}`;
  if (!body.includes('## Activity')) {
    return `${body.trimEnd()}\n\n## Activity\n\n${entry}\n`;
  }
  return `${body.trimEnd()}\n${entry}\n`;
}
```

Add to `packages/core/src/index.ts`:
```ts
export { appendActivity } from './taskfile.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): activity log append helper"
```

---

### Task 5: TaskStore (file-backed CRUD)

**Files:**
- Create: `packages/core/src/store.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/store.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces:
  ```ts
  interface CreateInput {
    title: string; kind?: TaskKind; status?: TaskStatus; description?: string;
    parent?: string | null; blockedBy?: string[]; labels?: string[];
    priority?: Priority; assignee?: Assignee;
  }
  interface UpdatePatch {
    title?: string; status?: TaskStatus; parent?: string | null;
    blockedBy?: string[]; labels?: string[]; priority?: Priority;
    assignee?: Assignee; appendActivity?: string;
  }
  interface ListFilter { status?: TaskStatus; kind?: TaskKind; parent?: string; }
  class TaskStore {
    constructor(rootDir: string);
    readonly rootDir: string; readonly tasksDir: string;
    static init(rootDir: string): TaskStore;
    isInitialized(): boolean;
    create(input: CreateInput, now?: string): TaskDoc;
    get(id: string): TaskDoc | null;
    list(filter?: ListFilter): TaskDoc[];        // sorted by created asc; throws TaskParseError with file name on bad files
    update(id: string, patch: UpdatePatch, now?: string): TaskDoc;  // throws Error(`task not found: ${id}`)
    taskFilePath(id: string): string | null;
  }
  ```
- File name convention: `<id>-<slug>.md`; lookup is by id prefix, so title edits never rename files.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/store.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dispatch-')); });

describe('TaskStore.init', () => {
  it('creates .dispatch/tasks and config.yml, idempotently', () => {
    TaskStore.init(root);
    TaskStore.init(root);
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(readFileSync(join(root, '.dispatch/config.yml'), 'utf8')).toContain('autoCommit: false');
  });
});

describe('create/get', () => {
  it('writes <id>-<slug>.md with template body and returns the doc', () => {
    const store = TaskStore.init(root);
    const doc = store.create(
      { title: 'Fix login', description: 'It loops.', priority: 'high' },
      '2026-07-13T18:00:00Z',
    );
    expect(doc.meta.id).toMatch(/^t-[0-9a-f]{6}$/);
    const files = readdirSync(store.tasksDir);
    expect(files).toEqual([`${doc.meta.id}-fix-login.md`]);
    const got = store.get(doc.meta.id)!;
    expect(got.meta.title).toBe('Fix login');
    expect(got.body).toContain('## Description\n\nIt loops.');
    expect(got.body.trimEnd().endsWith('## Activity')).toBe(true);
    expect(store.get('t-nope00')).toBeNull();
  });
  it('creates epics with e- ids', () => {
    const store = TaskStore.init(root);
    expect(store.create({ title: 'Auth', kind: 'epic' }).meta.id).toMatch(/^e-/);
  });
});

describe('list', () => {
  it('filters by status, kind, parent and sorts by created', () => {
    const store = TaskStore.init(root);
    const epic = store.create({ title: 'Epic', kind: 'epic' }, '2026-07-13T01:00:00Z');
    store.create({ title: 'A', parent: epic.meta.id }, '2026-07-13T02:00:00Z');
    const b = store.create({ title: 'B', status: 'backlog' }, '2026-07-13T03:00:00Z');
    expect(store.list().map(t => t.meta.title)).toEqual(['Epic', 'A', 'B']);
    expect(store.list({ status: 'backlog' })[0].meta.id).toBe(b.meta.id);
    expect(store.list({ kind: 'epic' })).toHaveLength(1);
    expect(store.list({ parent: epic.meta.id })[0].meta.title).toBe('A');
  });
});

describe('update', () => {
  it('patches fields, bumps updated, appends activity, keeps filename', () => {
    const store = TaskStore.init(root);
    const doc = store.create({ title: 'Fix login' }, '2026-07-13T18:00:00Z');
    const out = store.update(
      doc.meta.id,
      { status: 'in-progress', title: 'Renamed', appendActivity: 'started' },
      '2026-07-13T19:00:00Z',
    );
    expect(out.meta.status).toBe('in-progress');
    expect(out.meta.updated).toBe('2026-07-13T19:00:00Z');
    expect(out.body).toContain('- started');
    expect(store.taskFilePath(doc.meta.id)).toContain('fix-login.md');
    expect(() => store.update('t-nope00', { status: 'done' })).toThrow(/task not found/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test`
Expected: FAIL — cannot resolve `../src/store.js`.

- [ ] **Step 3: Implement**

`packages/core/src/store.ts`:
```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateTaskId } from './ids.js';
import { slugify } from './slug.js';
import { appendActivity, parseTaskFile, serializeTaskFile } from './taskfile.js';
import type { Assignee, Priority, TaskDoc, TaskKind, TaskMeta, TaskStatus } from './types.js';

export const DISPATCH_DIR = '.dispatch';

const DEFAULT_CONFIG = `statuses: [backlog, todo, in-progress, in-review, done, cancelled]
autoCommit: false
`;

export interface CreateInput {
  title: string;
  kind?: TaskKind;
  status?: TaskStatus;
  description?: string;
  parent?: string | null;
  blockedBy?: string[];
  labels?: string[];
  priority?: Priority;
  assignee?: Assignee;
}

export interface UpdatePatch {
  title?: string;
  status?: TaskStatus;
  parent?: string | null;
  blockedBy?: string[];
  labels?: string[];
  priority?: Priority;
  assignee?: Assignee;
  appendActivity?: string;
}

export interface ListFilter {
  status?: TaskStatus;
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
    writeFileSync(join(this.tasksDir, `${id}-${slugify(input.title)}.md`), serializeTaskFile(doc));
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
      .filter(f => f.endsWith('.md'))
      .map(f => parseTaskFile(readFileSync(join(this.tasksDir, f), 'utf8'), f));
    return docs
      .filter(d => (filter.status ? d.meta.status === filter.status : true))
      .filter(d => (filter.kind ? d.meta.kind === filter.kind : true))
      .filter(d => (filter.parent ? d.meta.parent === filter.parent : true))
      .sort((a, b) => a.meta.created.localeCompare(b.meta.created) || a.meta.id.localeCompare(b.meta.id));
  }

  update(id: string, patch: UpdatePatch, now: string = new Date().toISOString()): TaskDoc {
    const file = this.taskFilePath(id);
    if (!file) throw new Error(`task not found: ${id}`);
    const doc = parseTaskFile(readFileSync(file, 'utf8'), file);
    const { appendActivity: activityLine, ...patchFields } = patch;
    // Drop undefined entries so a partial patch never blanks existing fields.
    const fields = Object.fromEntries(
      Object.entries(patchFields).filter(([, v]) => v !== undefined),
    );
    const meta: TaskMeta = { ...doc.meta, ...fields, updated: now };
    let body = doc.body;
    if (activityLine) body = appendActivity(body, activityLine);
    const next: TaskDoc = { meta, body };
    writeFileSync(file, serializeTaskFile(next));
    return next;
  }

  taskFilePath(id: string): string | null {
    if (!this.isInitialized()) return null;
    const hit = readdirSync(this.tasksDir).find(f => f === `${id}.md` || f.startsWith(`${id}-`));
    return hit ? join(this.tasksDir, hit) : null;
  }
}
```

Add to `packages/core/src/index.ts`:
```ts
export { TaskStore, DISPATCH_DIR } from './store.js';
export type { CreateInput, UpdatePatch, ListFilter } from './store.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): file-backed TaskStore with init/create/get/list/update"
```

---

### Task 6: Dependency graph and ready-work query

**Files:**
- Create: `packages/core/src/graph.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/graph.test.ts`

**Interfaces:**
- Consumes: `TaskDoc`, `Priority` from Task 2.
- Produces:
  - `isDone(t: TaskDoc): boolean` — status is `done` or `cancelled`
  - `readyTasks(tasks: TaskDoc[]): TaskDoc[]` — kind `task`, status `todo`, every `blockedBy` entry either missing from the set (dangling — doctor's job to flag) or done; result sorted by priority then created
  - `PRIORITY_ORDER: Record<Priority, number>` — urgent 0 → none 4

- [ ] **Step 1: Write the failing tests**

`packages/core/test/graph.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readyTasks, isDone } from '../src/graph.js';
import type { TaskDoc, TaskMeta } from '../src/types.js';

function make(partial: Partial<TaskMeta>): TaskDoc {
  return {
    meta: {
      id: 't-000000', title: 'x', status: 'todo', kind: 'task', parent: null,
      blockedBy: [], labels: [], priority: 'none', assignee: 'none',
      created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', external: null,
      ...partial,
    },
    body: '',
  };
}

describe('readyTasks', () => {
  it('includes todo tasks whose blockers are done/cancelled, excludes others', () => {
    const done = make({ id: 't-d00000', status: 'done' });
    const open = make({ id: 't-o00000', status: 'in-progress' });
    const ready = make({ id: 't-r00000', blockedBy: ['t-d00000'] });
    const blocked = make({ id: 't-b00000', blockedBy: ['t-o00000'] });
    const ids = readyTasks([done, open, ready, blocked]).map(t => t.meta.id);
    expect(ids).toContain('t-r00000');
    expect(ids).not.toContain('t-b00000');
    expect(ids).not.toContain('t-o00000'); // not todo
  });
  it('excludes epics and non-todo statuses', () => {
    const epic = make({ id: 'e-100000', kind: 'epic' });
    const review = make({ id: 't-200000', status: 'in-review' });
    expect(readyTasks([epic, review])).toEqual([]);
  });
  it('treats dangling blocker ids as non-blocking', () => {
    const t = make({ id: 't-300000', blockedBy: ['t-ghost0'] });
    expect(readyTasks([t])).toHaveLength(1);
  });
  it('sorts by priority then created', () => {
    const low = make({ id: 't-400000', priority: 'low', created: '2026-01-01T00:00:00Z' });
    const urgent = make({ id: 't-500000', priority: 'urgent', created: '2026-01-02T00:00:00Z' });
    expect(readyTasks([low, urgent])[0].meta.id).toBe('t-500000');
  });
});

describe('isDone', () => {
  it('true for done and cancelled only', () => {
    expect(isDone(make({ status: 'done' }))).toBe(true);
    expect(isDone(make({ status: 'cancelled' }))).toBe(true);
    expect(isDone(make({ status: 'in-review' }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test`
Expected: FAIL — cannot resolve `../src/graph.js`.

- [ ] **Step 3: Implement**

`packages/core/src/graph.ts`:
```ts
import type { Priority, TaskDoc } from './types.js';

export const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0, high: 1, medium: 2, low: 3, none: 4,
};

export function isDone(t: TaskDoc): boolean {
  return t.meta.status === 'done' || t.meta.status === 'cancelled';
}

/**
 * Tasks safe to start now: kind=task, status=todo, all blockers done.
 * Dangling blocker ids (no task in the set) do not block; `doctor` reports them.
 */
export function readyTasks(tasks: TaskDoc[]): TaskDoc[] {
  const byId = new Map(tasks.map(t => [t.meta.id, t]));
  return tasks
    .filter(t => t.meta.kind === 'task' && t.meta.status === 'todo')
    .filter(t => t.meta.blockedBy.every(dep => {
      const d = byId.get(dep);
      return !d || isDone(d);
    }))
    .sort((a, b) =>
      PRIORITY_ORDER[a.meta.priority] - PRIORITY_ORDER[b.meta.priority]
      || a.meta.created.localeCompare(b.meta.created));
}
```

Add to `packages/core/src/index.ts`:
```ts
export { readyTasks, isDone, PRIORITY_ORDER } from './graph.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): dependency graph ready-work query"
```

---

### Task 7: Config loader

**Files:**
- Create: `packages/core/src/config.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Produces: `interface DispatchConfig { statuses: string[]; autoCommit: boolean }`, `loadConfig(rootDir: string): DispatchConfig` — reads `.dispatch/config.yml`, falls back to defaults per-key; missing file returns full defaults.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/config.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dispatch-')); });

describe('loadConfig', () => {
  it('returns defaults when file missing', () => {
    expect(loadConfig(root)).toEqual({
      statuses: ['backlog', 'todo', 'in-progress', 'in-review', 'done', 'cancelled'],
      autoCommit: false,
    });
  });
  it('merges file values over defaults', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: true\n');
    const cfg = loadConfig(root);
    expect(cfg.autoCommit).toBe(true);
    expect(cfg.statuses).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Implement**

`packages/core/src/config.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { DISPATCH_DIR } from './store.js';
import { STATUSES } from './types.js';

export interface DispatchConfig {
  statuses: string[];
  autoCommit: boolean;
}

const DEFAULTS: DispatchConfig = {
  statuses: [...STATUSES],
  autoCommit: false,
};

export function loadConfig(rootDir: string): DispatchConfig {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(path)) return { ...DEFAULTS };
  const raw = (YAML.parse(readFileSync(path, 'utf8')) ?? {}) as Partial<DispatchConfig>;
  return {
    statuses: raw.statuses ?? DEFAULTS.statuses,
    autoCommit: raw.autoCommit ?? DEFAULTS.autoCommit,
  };
}
```

Add to `packages/core/src/index.ts`:
```ts
export { loadConfig } from './config.js';
export type { DispatchConfig } from './config.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): config.yml loader with defaults"
```

---

### Task 8: CLI package scaffold + `dispatch init`

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/cli.ts`, `packages/cli/src/program.ts`, `packages/cli/src/context.ts`
- Test: `packages/cli/test/init.test.ts`

**Interfaces:**
- Consumes: `TaskStore` from core.
- Produces:
  ```ts
  interface CliContext { cwd: string; log: (line: string) => void; }
  class CliError extends Error { constructor(message: string, readonly exitCode = 1) }
  function makeProgram(ctx: CliContext): Command   // commander, exitOverride enabled
  ```
  All later CLI tasks register subcommands inside `makeProgram`. Tests call `program.parseAsync(argv, { from: 'user' })` and collect output via `ctx.log`.

- [ ] **Step 1: Create the package**

`packages/cli/package.json`:
```json
{
  "name": "@dispatch/cli",
  "version": "0.0.1",
  "type": "module",
  "license": "Apache-2.0",
  "bin": { "dispatch": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@dispatch/core": "workspace:*",
    "commander": "^13.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "execa": "^9.0.0"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": []
}
```

- [ ] **Step 2: Write the failing test**

`packages/cli/test/init.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProgram } from '../src/program.js';
import type { CliContext } from '../src/context.js';

let root: string;
let lines: string[];
let ctx: CliContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
});

describe('dispatch init', () => {
  it('scaffolds .dispatch and reports success', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(existsSync(join(root, '.dispatch/config.yml'))).toBe(true);
    expect(lines.join('\n')).toContain('Initialized');
  });
  it('is idempotent', async () => {
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
    expect(lines.join('\n')).toContain('already initialized');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @dispatch/cli test`
Expected: FAIL — cannot resolve `../src/program.js`.

- [ ] **Step 4: Implement**

`packages/cli/src/context.ts`:
```ts
export interface CliContext {
  cwd: string;
  log: (line: string) => void;
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = 1) {
    super(message);
    this.name = 'CliError';
  }
}
```

`packages/cli/src/program.ts`:
```ts
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, DISPATCH_DIR } from '@dispatch/core';
import type { CliContext } from './context.js';

export function makeProgram(ctx: CliContext): Command {
  const program = new Command('dispatch')
    .description('Git-native task tracking and agent orchestration')
    .exitOverride();

  program
    .command('init')
    .description('Scaffold .dispatch/ in the current directory')
    .action(() => {
      if (existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'))) {
        ctx.log('already initialized (.dispatch exists)');
        return;
      }
      TaskStore.init(ctx.cwd);
      ctx.log(`Initialized ${DISPATCH_DIR}/ — create your first task with: dispatch task create "<title>"`);
    });

  return program;
}
```

`packages/cli/src/cli.ts`:
```ts
#!/usr/bin/env node
import { makeProgram } from './program.js';
import { CliError } from './context.js';

const program = makeProgram({ cwd: process.cwd(), log: line => console.log(line) });

try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (err) {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    process.exitCode = err.exitCode;
  } else if ((err as { code?: string }).code?.startsWith('commander.')) {
    // commander already printed help/version; exitOverride throws instead of exiting
    process.exitCode = (err as { exitCode?: number }).exitCode ?? 1;
  } else {
    throw err;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dispatch/cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "feat(cli): package scaffold and dispatch init"
```

---

### Task 9: `task create` and `task list`

**Files:**
- Create: `packages/cli/src/commands/task.ts`, `packages/cli/src/output.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/test/task-crud.test.ts`

**Interfaces:**
- Consumes: `makeProgram`/`CliContext`/`CliError` (Task 8), `TaskStore`, types (core).
- Produces: `registerTaskCommands(program: Command, ctx: CliContext): void`; `formatTable(rows: string[][]): string` (left-aligned, two-space gutters); `requireStore(ctx: CliContext): TaskStore` (throws `CliError('not initialized — run: dispatch init')`). Command surface:
  - `dispatch task create <title> [--kind epic|task] [--description <d>] [--parent <id>] [--priority <p>] [--label <l>...] [--blocked-by <id>...] [--status <s>] [--json]`
  - `dispatch task list [--status <s>] [--kind <k>] [--parent <id>] [--json]` — table columns `ID  STATUS  PRI  KIND  TITLE`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/task-crud.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProgram } from '../src/program.js';
import type { CliContext } from '../src/context.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
  await run('init');
  lines = [];
});

describe('task create', () => {
  it('prints the new id and --json emits the doc', async () => {
    await run('task', 'create', 'Fix login', '--priority', 'high', '--json');
    const doc = JSON.parse(lines.join('\n'));
    expect(doc.meta.id).toMatch(/^t-[0-9a-f]{6}$/);
    expect(doc.meta.priority).toBe('high');
  });
  it('fails outside an initialized repo', async () => {
    ctx = { cwd: mkdtempSync(join(tmpdir(), 'other-')), log: l => lines.push(l) };
    await expect(run('task', 'create', 'X')).rejects.toThrow(/not initialized/);
  });
  it('rejects invalid priority', async () => {
    await expect(run('task', 'create', 'X', '--priority', 'huge')).rejects.toThrow(/invalid priority/);
  });
});

describe('task list', () => {
  it('renders a table and honors --status filter', async () => {
    await run('task', 'create', 'One');
    await run('task', 'create', 'Two', '--status', 'backlog');
    lines = [];
    await run('task', 'list');
    const out = lines.join('\n');
    expect(out).toContain('ID');
    expect(out).toContain('One');
    lines = [];
    await run('task', 'list', '--status', 'backlog', '--json');
    const docs = JSON.parse(lines.join('\n'));
    expect(docs).toHaveLength(1);
    expect(docs[0].meta.title).toBe('Two');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/cli test`
Expected: FAIL — `task` is an unknown command.

- [ ] **Step 3: Implement**

`packages/cli/src/output.ts`:
```ts
export function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '(none)';
  const widths = rows[0].map((_, col) => Math.max(...rows.map(r => r[col].length)));
  return rows
    .map(r => r.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd())
    .join('\n');
}
```

`packages/cli/src/commands/task.ts`:
```ts
import type { Command } from 'commander';
import { TaskStore, PRIORITIES, STATUSES } from '@dispatch/core';
import type { Priority, TaskDoc, TaskKind, TaskStatus } from '@dispatch/core';
import { CliError, type CliContext } from '../context.js';
import { formatTable } from '../output.js';

export function requireStore(ctx: CliContext): TaskStore {
  const store = new TaskStore(ctx.cwd);
  if (!store.isInitialized()) throw new CliError('not initialized — run: dispatch init');
  return store;
}

function validate<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`invalid ${label}: ${value} (expected ${allowed.join('|')})`);
  }
  return value as T;
}

export function taskRow(t: TaskDoc): string[] {
  return [t.meta.id, t.meta.status, t.meta.priority, t.meta.kind, t.meta.title];
}

export const TABLE_HEADER = ['ID', 'STATUS', 'PRI', 'KIND', 'TITLE'];

export function registerTaskCommands(program: Command, ctx: CliContext): void {
  const task = program.command('task').description('Manage tasks and epics');

  task
    .command('create')
    .argument('<title>')
    .option('--kind <kind>', 'task|epic', 'task')
    .option('--description <text>')
    .option('--parent <id>')
    .option('--priority <priority>', 'urgent|high|medium|low|none', 'none')
    .option('--status <status>')
    .option('--label <label...>')
    .option('--blocked-by <id...>')
    .option('--json', 'print the created task as JSON')
    .action((title: string, opts: Record<string, string | string[] | boolean | undefined>) => {
      const store = requireStore(ctx);
      const doc = store.create({
        title,
        kind: validate(opts.kind as string, ['task', 'epic'] as const, 'kind') as TaskKind,
        status: validate(opts.status as string | undefined, STATUSES, 'status') as TaskStatus | undefined,
        description: opts.description as string | undefined,
        parent: (opts.parent as string | undefined) ?? null,
        priority: validate(opts.priority as string, PRIORITIES, 'priority') as Priority,
        labels: (opts.label as string[] | undefined) ?? [],
        blockedBy: (opts.blockedBy as string[] | undefined) ?? [],
      });
      ctx.log(opts.json ? JSON.stringify(doc, null, 2) : `created ${doc.meta.id}  ${doc.meta.title}`);
    });

  task
    .command('list')
    .option('--status <status>')
    .option('--kind <kind>')
    .option('--parent <id>')
    .option('--json')
    .action((opts: Record<string, string | boolean | undefined>) => {
      const store = requireStore(ctx);
      const docs = store.list({
        status: validate(opts.status as string | undefined, STATUSES, 'status') as TaskStatus | undefined,
        kind: validate(opts.kind as string | undefined, ['task', 'epic'] as const, 'kind') as TaskKind | undefined,
        parent: opts.parent as string | undefined,
      });
      if (opts.json) {
        ctx.log(JSON.stringify(docs, null, 2));
        return;
      }
      ctx.log(formatTable([TABLE_HEADER, ...docs.map(taskRow)]));
    });
}
```

In `packages/cli/src/program.ts`, add after the `init` command registration:
```ts
import { registerTaskCommands } from './commands/task.js';
// ... inside makeProgram, before `return program`:
registerTaskCommands(program, ctx);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): task create and task list with --json output"
```

---

### Task 10: `task show`, `task status`, `task edit`

**Files:**
- Modify: `packages/cli/src/commands/task.ts`
- Test: `packages/cli/test/task-edit.test.ts`

**Interfaces:**
- Consumes: Task 9's `requireStore`, `validate` pattern, `TaskStore.update`.
- Produces:
  - `dispatch task show <id> [--json]` — raw file content (or JSON doc)
  - `dispatch task status <id> <status>` — validates status, appends activity line `status → <status>`
  - `dispatch task edit <id> [--title <t>] [--priority <p>] [--assignee <a>] [--parent <id>] [--add-label <l>...] [--add-blocked-by <id>...]`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/task-edit.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProgram } from '../src/program.js';
import type { CliContext } from '../src/context.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

async function createTask(title: string): Promise<string> {
  lines = [];
  await run('task', 'create', title, '--json');
  return JSON.parse(lines.join('\n')).meta.id as string;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
  await run('init');
});

describe('task show', () => {
  it('prints the raw markdown file', async () => {
    const id = await createTask('Show me');
    lines = [];
    await run('task', 'show', id);
    expect(lines.join('\n')).toContain('title: Show me');
    expect(lines.join('\n')).toContain('## Description');
  });
  it('errors on unknown id', async () => {
    await expect(run('task', 'show', 't-nope00')).rejects.toThrow(/task not found/);
  });
});

describe('task status', () => {
  it('updates status and logs activity', async () => {
    const id = await createTask('Move me');
    await run('task', 'status', id, 'in-progress');
    lines = [];
    await run('task', 'show', id);
    const out = lines.join('\n');
    expect(out).toContain('status: in-progress');
    expect(out).toMatch(/- .*status → in-progress/);
  });
  it('rejects unknown status', async () => {
    const id = await createTask('X');
    await expect(run('task', 'status', id, 'shipped')).rejects.toThrow(/invalid status/);
  });
});

describe('task edit', () => {
  it('patches fields additively', async () => {
    const id = await createTask('Edit me');
    await run('task', 'edit', id, '--priority', 'urgent', '--add-label', 'infra');
    lines = [];
    await run('task', 'show', id, '--json');
    const doc = JSON.parse(lines.join('\n'));
    expect(doc.meta.priority).toBe('urgent');
    expect(doc.meta.labels).toContain('infra');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/cli test`
Expected: FAIL — `show` is an unknown command.

- [ ] **Step 3: Implement**

Append inside `registerTaskCommands` in `packages/cli/src/commands/task.ts`:
```ts
  task
    .command('show')
    .argument('<id>')
    .option('--json')
    .action((id: string, opts: { json?: boolean }) => {
      const store = requireStore(ctx);
      const doc = store.get(id);
      if (!doc) throw new CliError(`task not found: ${id}`);
      if (opts.json) {
        ctx.log(JSON.stringify(doc, null, 2));
        return;
      }
      ctx.log(readFileSync(store.taskFilePath(id)!, 'utf8'));
    });

  task
    .command('status')
    .argument('<id>')
    .argument('<status>')
    .action((id: string, status: string) => {
      const store = requireStore(ctx);
      const valid = validate(status, STATUSES, 'status') as TaskStatus;
      if (!store.get(id)) throw new CliError(`task not found: ${id}`);
      store.update(id, {
        status: valid,
        appendActivity: `${new Date().toISOString()} status → ${valid}`,
      });
      ctx.log(`${id} → ${valid}`);
    });

  task
    .command('edit')
    .argument('<id>')
    .option('--title <title>')
    .option('--priority <priority>')
    .option('--assignee <assignee>', 'agent|human|none')
    .option('--parent <id>')
    .option('--add-label <label...>')
    .option('--add-blocked-by <id...>')
    .action((id: string, opts: Record<string, string | string[] | undefined>) => {
      const store = requireStore(ctx);
      const doc = store.get(id);
      if (!doc) throw new CliError(`task not found: ${id}`);
      store.update(id, {
        title: opts.title as string | undefined,
        priority: validate(opts.priority as string | undefined, PRIORITIES, 'priority') as Priority | undefined,
        assignee: validate(opts.assignee as string | undefined, ['agent', 'human', 'none'] as const, 'assignee'),
        parent: (opts.parent as string | undefined) ?? doc.meta.parent,
        labels: opts.addLabel ? [...doc.meta.labels, ...(opts.addLabel as string[])] : undefined,
        blockedBy: opts.addBlockedBy ? [...doc.meta.blockedBy, ...(opts.addBlockedBy as string[])] : undefined,
      });
      ctx.log(`updated ${id}`);
    });
```

Add the import at the top of the file:
```ts
import { readFileSync } from 'node:fs';
```

Note: `TaskStore.update` (Task 5) already filters `undefined` patch entries, so partially-filled `edit` options never blank existing fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): task show, status, and edit commands"
```

---

### Task 11: `task next` (ready-work query)

**Files:**
- Modify: `packages/cli/src/commands/task.ts`
- Test: `packages/cli/test/task-next.test.ts`

**Interfaces:**
- Consumes: `readyTasks` from core, Task 9's table helpers.
- Produces: `dispatch task next [--json]` — ready tasks sorted by priority; human output reuses `TABLE_HEADER`/`taskRow`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/task-next.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProgram } from '../src/program.js';
import type { CliContext } from '../src/context.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

async function createTask(...args: string[]): Promise<string> {
  lines = [];
  await run('task', 'create', ...args, '--json');
  return JSON.parse(lines.join('\n')).meta.id as string;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
  await run('init');
});

describe('task next', () => {
  it('lists only unblocked todo tasks, priority first', async () => {
    const blocker = await createTask('Blocker');
    await createTask('Blocked', '--blocked-by', blocker);
    await createTask('Urgent free', '--priority', 'urgent');
    lines = [];
    await run('task', 'next', '--json');
    const docs = JSON.parse(lines.join('\n'));
    const titles = docs.map((d: { meta: { title: string } }) => d.meta.title);
    expect(titles[0]).toBe('Urgent free');
    expect(titles).toContain('Blocker');
    expect(titles).not.toContain('Blocked');
  });
  it('unblocks when the blocker is done', async () => {
    const blocker = await createTask('Blocker');
    await createTask('Blocked', '--blocked-by', blocker);
    await run('task', 'status', blocker, 'done');
    lines = [];
    await run('task', 'next', '--json');
    const titles = JSON.parse(lines.join('\n')).map((d: { meta: { title: string } }) => d.meta.title);
    expect(titles).toContain('Blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/cli test`
Expected: FAIL — `next` is an unknown command.

- [ ] **Step 3: Implement**

Append inside `registerTaskCommands`:
```ts
  task
    .command('next')
    .description('Tasks ready to start: todo with all blockers done')
    .option('--json')
    .action((opts: { json?: boolean }) => {
      const store = requireStore(ctx);
      const ready = readyTasks(store.list());
      if (opts.json) {
        ctx.log(JSON.stringify(ready, null, 2));
        return;
      }
      ctx.log(formatTable([TABLE_HEADER, ...ready.map(taskRow)]));
    });
```

Add `readyTasks` to the `@dispatch/core` import at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dispatch/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): task next ready-work command"
```

---

### Task 12: `dispatch doctor`

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `TaskStore`, `parseTaskFile`, `loadConfig`, `CliError`.
- Produces: `registerDoctorCommand(program: Command, ctx: CliContext): void`. `dispatch doctor [--json]` reports issues: unparsable files, dangling `parent`/`blocked-by` references, statuses not in config. Exit: throws `CliError(<n> issue(s) found)` when issues exist; prints `ok — <n> tasks checked` when clean. JSON shape: `{ ok: boolean, tasks: number, issues: [{ file: string, problem: string }] }`.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/doctor.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProgram } from '../src/program.js';
import type { CliContext } from '../src/context.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: l => lines.push(l) };
  await run('init');
});

describe('doctor', () => {
  it('reports ok on a healthy tracker', async () => {
    await run('task', 'create', 'Fine');
    lines = [];
    await run('doctor');
    expect(lines.join('\n')).toMatch(/ok — 1 task/);
  });
  it('flags unparsable files and dangling references', async () => {
    await run('task', 'create', 'Refs ghost', '--blocked-by', 't-ghost0');
    writeFileSync(join(root, '.dispatch/tasks/broken.md'), 'not a task file');
    await expect(run('doctor')).rejects.toThrow(/2 issue/);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(2);
    expect(report.issues.map((i: { problem: string }) => i.problem).join(' ')).toMatch(/missing frontmatter/);
    expect(report.issues.map((i: { problem: string }) => i.problem).join(' ')).toMatch(/dangling blocked-by/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/cli test`
Expected: FAIL — `doctor` is an unknown command.

- [ ] **Step 3: Implement**

`packages/cli/src/commands/doctor.ts`:
```ts
import type { Command } from 'commander';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseTaskFile } from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';
import { CliError, type CliContext } from '../context.js';
import { requireStore } from './task.js';

interface Issue { file: string; problem: string; }

export function registerDoctorCommand(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Validate task files and references')
    .option('--json')
    .action((opts: { json?: boolean }) => {
      const store = requireStore(ctx);
      const config = loadConfig(ctx.cwd);
      const issues: Issue[] = [];
      const docs: TaskDoc[] = [];

      for (const file of readdirSync(store.tasksDir).filter(f => f.endsWith('.md'))) {
        try {
          docs.push(parseTaskFile(readFileSync(join(store.tasksDir, file), 'utf8'), file));
        } catch (err) {
          issues.push({ file, problem: (err as Error).message });
        }
      }

      const ids = new Set(docs.map(d => d.meta.id));
      for (const d of docs) {
        const file = `${d.meta.id}`;
        if (d.meta.parent && !ids.has(d.meta.parent)) {
          issues.push({ file, problem: `dangling parent: ${d.meta.parent}` });
        }
        for (const dep of d.meta.blockedBy) {
          if (!ids.has(dep)) issues.push({ file, problem: `dangling blocked-by: ${dep}` });
        }
        if (!config.statuses.includes(d.meta.status)) {
          issues.push({ file, problem: `status not in config: ${d.meta.status}` });
        }
      }

      if (opts.json) {
        ctx.log(JSON.stringify({ ok: issues.length === 0, tasks: docs.length, issues }, null, 2));
      } else if (issues.length === 0) {
        ctx.log(`ok — ${docs.length} task${docs.length === 1 ? '' : 's'} checked`);
      } else {
        for (const i of issues) ctx.log(`${i.file}: ${i.problem}`);
      }
      if (issues.length > 0) {
        throw new CliError(`${issues.length} issue${issues.length === 1 ? '' : 's'} found`);
      }
    });
}
```

In `packages/cli/src/program.ts`, register it beside the task commands:
```ts
import { registerDoctorCommand } from './commands/doctor.js';
// inside makeProgram:
registerDoctorCommand(program, ctx);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): doctor command validating files and references"
```

---

### Task 13: End-to-end smoke test + README

**Files:**
- Create: `packages/cli/test/e2e.test.ts`, `README.md`

**Interfaces:**
- Consumes: the built `dispatch` binary (`packages/cli/dist/cli.js`).
- Produces: proof the whole tracker works as a subprocess in a real temp git repo; user-facing quickstart.

- [ ] **Step 1: Write the failing e2e test**

`packages/cli/test/e2e.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dirname, '../dist/cli.js');
let repo: string;

async function dispatch(...args: string[]) {
  return execa('node', [BIN, ...args], { cwd: repo });
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'dispatch-e2e-'));
  await execa('git', ['init', '-q'], { cwd: repo });
}, 20_000);

describe('dispatch e2e', () => {
  it('init → create → block → status → next → doctor', async () => {
    await dispatch('init');
    const a = JSON.parse((await dispatch('task', 'create', 'Build parser', '--json')).stdout);
    const b = JSON.parse(
      (await dispatch('task', 'create', 'Use parser', '--blocked-by', a.meta.id, '--json')).stdout,
    );
    let next = JSON.parse((await dispatch('task', 'next', '--json')).stdout);
    expect(next.map((t: { meta: { id: string } }) => t.meta.id)).toEqual([a.meta.id]);

    await dispatch('task', 'status', a.meta.id, 'done');
    next = JSON.parse((await dispatch('task', 'next', '--json')).stdout);
    expect(next.map((t: { meta: { id: string } }) => t.meta.id)).toEqual([b.meta.id]);

    const doctor = await dispatch('doctor');
    expect(doctor.stdout).toContain('ok — 2 tasks checked');

    const status = await execa('git', ['status', '--porcelain'], { cwd: repo });
    expect(status.stdout).toContain('.dispatch/');
  }, 30_000);
});
```

- [ ] **Step 2: Build, then run the e2e to verify it fails without dist**

Run: `rm -rf packages/cli/dist && pnpm --filter @dispatch/cli test -- e2e`
Expected: FAIL — `dist/cli.js` not found.

Run: `pnpm -r build && pnpm --filter @dispatch/cli test`
Expected: PASS (all CLI tests including e2e).

- [ ] **Step 3: Write README**

`README.md`:
```markdown
# Dispatch (working title)

Open-source, git-native task tracking and AI-agent orchestration. Tasks are
markdown files in your repo (`.dispatch/tasks/*.md`) — synced by git, readable
by humans and agents alike.

**Status:** Phase 1 (tracker core + CLI). Roadmap: `docs/superpowers/plans/2026-07-13-dispatch-roadmap.md`.

## Quickstart

    pnpm install && pnpm -r build
    node packages/cli/dist/cli.js init
    node packages/cli/dist/cli.js task create "My first task" --priority high
    node packages/cli/dist/cli.js task list
    node packages/cli/dist/cli.js task next
    node packages/cli/dist/cli.js doctor

Every read command accepts `--json` for agent/script consumption.

## Design docs

- Spec: `docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md`
- Research: `docs/research/2026-07-13-landscape-research.md`

## License

Apache-2.0
```

- [ ] **Step 4: Full suite green**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS across core and cli.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/e2e.test.ts README.md
git commit -m "test: end-to-end CLI smoke test; docs: quickstart README"
```
