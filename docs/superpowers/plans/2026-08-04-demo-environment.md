# Demo Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live, driveable demo of every Dispatch capability added
2026-08-02 → 2026-08-04, backed by a real storefront repo, seeded board state, a
puppeted teammate, and reset/preflight tooling.

**Architecture:** A private workspace package `packages/demo` holds the
generator, the storefront source template, and the teammate puppet. It emits
four artifacts into gitignored `.agents/ignore/`: Wyat's storefront clone, his
isolated `DISPATCH_HOME`, a teammate clone, and the teammate's `DISPATCH_HOME`.
Shared board state (tasks, team.yml, findings, ledger, inboxes) is committed to
a public GitHub repo and is what the board syncer moves; run transcripts and
actor identity stay in `DISPATCH_HOME`, keyed by `sha256(rootDir)[:12]`.

**Tech Stack:** Bun, TypeScript, `node:crypto`, `node:fs`, git CLI via
`Bun.spawnSync`, gh CLI for the remote.

## Deviation from the spec

The spec implied the toolkit lives in `.agents/ignore/` alongside its output. It
does not. `AGENTS.md` forbids source files and tests under `.agents/ignore/`,
and this toolkit must be re-run as Dispatch evolves, so it needs typecheck,
lint, and tests. It lives at `packages/demo` (private, never published) and
_writes into_ `.agents/ignore/`. The existing `.agents/ignore/gen-demo.py` is
deleted in Task 9.

## Global Constraints

- Bun only. Never `npm`, `pnpm`, `npx`.
- Dependencies go in the root `workspaces.catalog`, never a package's own
  `package.json`.
- `bunfig.toml` sets `minimumReleaseAge=7d`; a dependency published this week
  will not install.
- `export AGENT=1` before running tests.
- Preserve trailing newlines at end of files.
- Comments: 1-2 lines, function-level, no incident narratives.
- Every generated artifact lands under `.agents/ignore/`. Nothing generated is
  ever committed to this repo.
- Every seeded run must reach a terminal state. `reconcileOnBoot` fails any
  non-terminal run with no process behind it.
- An inbox line's `^in-xxxx` marker must be last, after any `@r-...` or
  `→ t-...`.
- The Linear API key lives only in `~/.dispatch/credentials.json`. It never
  enters any repo.
- Verification after code changes: `bun run format` and `bun run lint` from the
  root, plus `bun ws demo tsc` and focused tests.

---

### Task 1: Package skeleton and path/identity module

Establishes `packages/demo` and the single source of truth for every path,
actor, and derived key. Everything downstream imports from here, so getting the
run-key derivation right now prevents a fixture whose runs are invisible.

**Files:**

- Create: `packages/demo/package.json`
- Create: `packages/demo/tsconfig.json`
- Create: `packages/demo/bunfig.toml`
- Create: `packages/demo/src/paths.ts`
- Test: `packages/demo/test/paths.test.ts`
- Modify: `tsconfig.oxlint.json` (exclude the storefront template added in
  Task 2)

**Interfaces:**

- Consumes: nothing
- Produces: `DEMO`, `runKey(rootDir: string): string`, `ACTORS: DemoActor[]`,
  `type DemoActor = { handle: string; email: string; displayName: string }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/paths.test.ts
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ACTORS, DEMO, runKey } from '../src/paths.js';

test('runKey is the first 12 hex of sha256 of the absolute root', () => {
  const root = '/tmp/example-root';
  const want = createHash('sha256').update(root).digest('hex').slice(0, 12);
  expect(runKey(root)).toBe(want);
});

test('runKey distinguishes the two clones', () => {
  expect(runKey(DEMO.root)).not.toBe(runKey(DEMO.teammateRoot));
});

test('every demo path is absolute and under .agents/ignore', () => {
  for (const p of [
    DEMO.root,
    DEMO.home,
    DEMO.teammateRoot,
    DEMO.teammateHome,
  ]) {
    expect(p.startsWith('/')).toBe(true);
    expect(p).toContain('/.agents/ignore/');
  }
});

test('actors are unique by handle and email', () => {
  expect(new Set(ACTORS.map((a) => a.handle)).size).toBe(ACTORS.length);
  expect(new Set(ACTORS.map((a) => a.email)).size).toBe(ACTORS.length);
  expect(ACTORS.length).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/demo && bun test test/paths.test.ts` Expected: FAIL — cannot
resolve `../src/paths.js`

- [ ] **Step 3: Write the package files**

```json
// packages/demo/package.json
{
  "name": "@dispatch/demo",
  "private": true,
  "type": "module",
  "scripts": {
    "tsc": "tsc --noEmit",
    "test": "bun test",
    "demo": "bun src/cli.ts"
  }
}
```

```json
// packages/demo/tsconfig.json
{
  "extends": "../../tsconfig.options.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["storefront-src/**"]
}
```

```toml
# packages/demo/bunfig.toml
[test]
root = "./test"
```

```ts
// packages/demo/src/paths.ts
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run transcripts and actor identity live under $DISPATCH_HOME keyed by a hash
// of the project root, so the two clones never share run history.
export function runKey(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

export interface DemoActor {
  handle: string;
  email: string;
  displayName: string;
}

export const ACTORS: DemoActor[] = [
  {
    handle: 'wsoule679',
    email: 'wsoule679@gmail.com',
    displayName: 'Wyat Soule',
  },
  {
    handle: 'pmirand',
    email: 'p.miranda@example.com',
    displayName: 'Priya Miranda',
  },
  {
    handle: 'dokafor',
    email: 'd.okafor@example.com',
    displayName: 'Dami Okafor',
  },
];

/** The human who drives the demo; the other actors only ever appear via the puppet. */
export const OWNER = ACTORS[0]!;
export const TEAMMATE = ACTORS[1]!;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ignore = join(repoRoot, '.agents', 'ignore');

export const DEMO = {
  repoRoot,
  ignore,
  /** Source of the storefront codebase, copied into the clone on generate. */
  template: join(repoRoot, 'packages', 'demo', 'storefront-src'),
  root: join(ignore, 'storefront'),
  home: join(ignore, 'storefront-home'),
  teammateRoot: join(ignore, 'teammate', 'storefront'),
  teammateHome: join(ignore, 'teammate', 'home'),
  remote: 'git@github.com:wsoule/storefront.git',
} as const;

/** Where a clone's run transcripts live, given its root and DISPATCH_HOME. */
export function runsDir(rootDir: string, home: string): string {
  return join(home, '.dispatch', 'runs', runKey(rootDir));
}

/** Where a clone's actor identity file lives. */
export function actorFile(rootDir: string, home: string): string {
  return join(home, '.dispatch', 'actor', `${runKey(rootDir)}.json`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/demo && bun test test/paths.test.ts` Expected: PASS, 4 tests

- [ ] **Step 5: Exclude the storefront template from root typecheck and lint**

In `tsconfig.oxlint.json`, add to `exclude`:

```json
"packages/demo/storefront-src/**"
```

In `.oxlintrc.json`, add a top-level key (the storefront intentionally contains
defects and must not be linted with this repo's rules):

```json
"ignorePatterns": ["packages/demo/storefront-src/**"]
```

- [ ] **Step 6: Verify the root still passes**

Run from repo root: `bun install && bun run lint && bun ws demo tsc` Expected:
lint clean, tsc clean

- [ ] **Step 7: Commit**

```bash
git add packages/demo tsconfig.oxlint.json .oxlintrc.json
git commit -m "feat(demo): add the demo toolkit package and path module"
```

---

### Task 2: Storefront codebase template

The demo project's real source. `bun test`, `bun run tsc`, and `bun run lint`
must pass inside a generated clone, because the verify panel and merge gate
render real output or nothing. Defect placement follows task status: `done`
fixed on main, `in-review` broken on main and fixed on a branch,
`todo`/`backlog` broken and untouched.

**Files:**

- Create: `packages/demo/storefront-src/package.json`
- Create: `packages/demo/storefront-src/tsconfig.json`
- Create: `packages/demo/storefront-src/README.md`
- Create: `packages/demo/storefront-src/src/db/client.ts`
- Create: `packages/demo/storefront-src/src/search/tokenize.ts`
- Create: `packages/demo/storefront-src/src/search/rank.ts`
- Create: `packages/demo/storefront-src/src/search/index.ts`
- Create: `packages/demo/storefront-src/src/cart/CartProvider.ts`
- Create: `packages/demo/storefront-src/src/checkout/discount.ts`
- Create: `packages/demo/storefront-src/src/server/routes.ts`
- Create: `packages/demo/storefront-src/test/search.test.ts`
- Create: `packages/demo/storefront-src/test/cart.test.ts`
- Create: `packages/demo/storefront-src/test/discount.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: a directory tree copied verbatim by Task 3. `src/db/client.ts`
  exports `query(sql: string, params?: unknown[]): Promise<Row[]>` and is
  imported by `search/index.ts`, `checkout/discount.ts`, and `server/routes.ts`
  — that fan-in is what makes carto's blast radius non-trivial.

- [ ] **Step 1: Write the storefront's own package manifest**

```json
// packages/demo/storefront-src/package.json
{
  "name": "storefront",
  "private": true,
  "type": "module",
  "scripts": {
    "tsc": "tsc --noEmit",
    "test": "bun test",
    "lint": "tsc --noEmit"
  },
  "devDependencies": { "typescript": "5.9.2" }
}
```

```json
// packages/demo/storefront-src/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 2: Write the shared db layer**

This file is the blast-radius target. It must be imported by three modules.

```ts
// packages/demo/storefront-src/src/db/client.ts
export interface Row {
  [column: string]: string | number | null;
}

const SLOW_QUERY_MS = 200;

// Logs any statement over 200ms with its duration — task t-4e01af, already done.
export async function query(
  sql: string,
  params: unknown[] = []
): Promise<Row[]> {
  const started = performance.now();
  const rows = await execute(sql, params);
  const elapsed = performance.now() - started;
  if (elapsed > SLOW_QUERY_MS) {
    console.warn(`slow query ${elapsed.toFixed(0)}ms: ${sql}`);
  }
  return rows;
}

// Stand-in for a real driver; the demo never talks to a database.
async function execute(sql: string, _params: unknown[]): Promise<Row[]> {
  if (sql.startsWith('SELECT 1')) return [{ ok: 1 }];
  return [];
}
```

- [ ] **Step 3: Write the search module with the hyphen bug already fixed**

`t-0c9b88` is `done`, so this ships correct on main.

```ts
// packages/demo/storefront-src/src/search/tokenize.ts
// Hyphens are kept so SKUs like "AB-1200" survive tokenisation — task t-0c9b88.
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 0);
}
```

```ts
// packages/demo/storefront-src/src/search/rank.ts
import { tokenize } from './tokenize.js';

export interface Product {
  sku: string;
  title: string;
}

export interface Hit {
  sku: string;
  score: number;
}

// Scores every product against the query. Exact SKU matches score the same as
// fuzzy ones today — task t-58cc03 fixes that on its branch.
export function rank(query: string, products: Product[]): Hit[] {
  const terms = tokenize(query);
  const hits: Hit[] = [];
  for (const product of products) {
    const haystack = tokenize(`${product.sku} ${product.title}`);
    const overlap = terms.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) hits.push({ sku: product.sku, score: overlap });
  }
  return hits.sort((a, b) => b.score - a.score);
}
```

```ts
// packages/demo/storefront-src/src/search/index.ts
import { query } from '../db/client.js';
import { rank, type Product } from './rank.js';

export async function search(term: string): Promise<string[]> {
  const rows = await query('SELECT sku, title FROM products');
  const products = rows as unknown as Product[];
  return rank(term, products).map((h) => h.sku);
}
```

- [ ] **Step 4: Write the cart with the localStorage defect on main**

`t-2e91aa` is `in-review` — broken here, fixed on its branch in Task 3.

```ts
// packages/demo/storefront-src/src/cart/CartProvider.ts
export interface CartLine {
  sku: string;
  qty: number;
}

const KEY = 'cart';

// Cart state is mirrored into localStorage, so it never follows a signed-in
// user between devices — task t-2e91aa moves it to the session store.
export function loadCart(): CartLine[] {
  const raw = globalThis.localStorage?.getItem(KEY);
  if (raw == null) return [];
  try {
    return JSON.parse(raw) as CartLine[];
  } catch {
    return [];
  }
}

export function saveCart(lines: CartLine[]): void {
  globalThis.localStorage?.setItem(KEY, JSON.stringify(lines));
}
```

- [ ] **Step 5: Write the discount module with the live-demo defect**

`t-3f8a21` is `todo` — this stays broken, and is what the live agent run fixes.

```ts
// packages/demo/storefront-src/src/checkout/discount.ts
import { query } from '../db/client.js';

export interface Discount {
  code: string;
  percent: number;
  expiresAt: string;
}

// The client decides whether a code is valid, so anyone can mint one — task
// t-3f8a21 moves this behind the API.
export function applyDiscount(code: string, subtotal: number): number {
  const known: Discount[] = [
    { code: 'WELCOME10', percent: 10, expiresAt: '2027-01-01T00:00:00Z' },
    { code: 'SUMMER25', percent: 25, expiresAt: '2026-09-01T00:00:00Z' },
  ];
  const match = known.find((d) => d.code === code.toUpperCase());
  if (match == null) return subtotal;
  return Math.round(subtotal * (1 - match.percent / 100));
}

export async function listDiscounts(): Promise<Discount[]> {
  const rows = await query('SELECT code, percent, expires_at FROM discounts');
  return rows as unknown as Discount[];
}
```

- [ ] **Step 6: Write the routes module**

```ts
// packages/demo/storefront-src/src/server/routes.ts
import { applyDiscount } from '../checkout/discount.js';
import { query } from '../db/client.js';
import { search } from '../search/index.js';

export const BUILD_SHA = 'demo';

// Cheap endpoint for the load balancer to poll — task t-71ff03, already done.
export async function health(): Promise<Response> {
  await query('SELECT 1');
  return new Response(JSON.stringify({ ok: true, sha: BUILD_SHA }), {
    status: 200,
  });
}

export async function searchRoute(term: string): Promise<Response> {
  const skus = await search(term);
  return new Response(JSON.stringify({ skus }), { status: 200 });
}

export function checkoutRoute(code: string, subtotal: number): Response {
  return new Response(
    JSON.stringify({ total: applyDiscount(code, subtotal) }),
    { status: 200 }
  );
}
```

- [ ] **Step 7: Write the storefront's tests**

These must pass against the _defective_ main, or the generated clone is red
before the demo starts. They assert current behaviour, not desired behaviour.

```ts
// packages/demo/storefront-src/test/search.test.ts
import { expect, test } from 'bun:test';
import { rank } from '../src/search/rank.js';
import { tokenize } from '../src/search/tokenize.js';

test('tokenize keeps hyphenated SKUs intact', () => {
  expect(tokenize('AB-1200 blue widget')).toEqual([
    'ab-1200',
    'blue',
    'widget',
  ]);
});

test('rank returns every product sharing a term', () => {
  const products = [
    { sku: 'AB-1200', title: 'blue widget' },
    { sku: 'CD-3400', title: 'red widget' },
  ];
  expect(
    rank('widget', products)
      .map((h) => h.sku)
      .sort()
  ).toEqual(['AB-1200', 'CD-3400']);
});
```

```ts
// packages/demo/storefront-src/test/cart.test.ts
import { expect, test } from 'bun:test';
import { loadCart } from '../src/cart/CartProvider.js';

test('loadCart returns empty when nothing is stored', () => {
  expect(loadCart()).toEqual([]);
});
```

```ts
// packages/demo/storefront-src/test/discount.test.ts
import { expect, test } from 'bun:test';
import { applyDiscount } from '../src/checkout/discount.js';

test('a known code reduces the subtotal', () => {
  expect(applyDiscount('WELCOME10', 100)).toBe(90);
});

test('an unknown code leaves the subtotal alone', () => {
  expect(applyDiscount('NOPE', 100)).toBe(100);
});
```

- [ ] **Step 8: Verify the template is self-consistent**

Run: `cd packages/demo/storefront-src && bun install && bun test && bun run tsc`
Expected: 5 tests pass, tsc clean

- [ ] **Step 9: Commit**

```bash
git add packages/demo/storefront-src
git commit -m "feat(demo): add the storefront codebase template"
```

---

### Task 3: Repo builder — clone, branches, remote

Copies the template into `.agents/ignore/storefront`, makes the git history the
board's story expects, and pushes to GitHub. The `in-review` branches are what
give the review surface a real diff.

**Files:**

- Create: `packages/demo/src/git.ts`
- Create: `packages/demo/src/repo.ts`
- Test: `packages/demo/test/repo.test.ts`

**Interfaces:**

- Consumes: `DEMO` from `src/paths.js`
- Produces: `git(cwd: string, ...args: string[]): string`,
  `buildRepo(opts: { root: string; push: boolean }): void`,
  `BRANCH_FIXES: BranchFix[]` where
  `type BranchFix = { task: string; branch: string; file: string; contents: string }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/repo.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.js';
import { BRANCH_FIXES, buildRepo } from '../src/repo.js';

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-repo-'));
  buildRepo({ root, push: false });
  return root;
}

test('main carries the unfixed defects', () => {
  const root = build();
  const discount = readFileSync(join(root, 'src/checkout/discount.ts'), 'utf8');
  expect(discount).toContain('const known: Discount[]');
});

test('each in-review task has a branch whose diff is non-empty', () => {
  const root = build();
  for (const fix of BRANCH_FIXES) {
    const diff = git(root, 'diff', '--name-only', `main..${fix.branch}`);
    expect(diff.trim()).not.toBe('');
    expect(diff).toContain(fix.file);
  }
});

test('the working tree is left on main and clean', () => {
  const root = build();
  expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  expect(git(root, 'status', '--porcelain').trim()).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/demo && bun test test/repo.test.ts` Expected: FAIL — cannot
resolve `../src/git.js`

- [ ] **Step 3: Write the git helper**

```ts
// packages/demo/src/git.ts
import { spawnSync } from 'node:child_process';

/** Runs git in `cwd` with a fixed identity, throwing on non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Demo',
      '-c',
      'user.email=demo@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}
```

- [ ] **Step 4: Write the repo builder**

```ts
// packages/demo/src/repo.ts
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';
import { DEMO } from './paths.js';

export interface BranchFix {
  task: string;
  branch: string;
  file: string;
  contents: string;
}

// The in-review tasks: broken on main, fixed on their own branch, so the review
// surface has a real diff to render.
export const BRANCH_FIXES: BranchFix[] = [
  {
    task: 't-2e91aa',
    branch: 'dispatch/t-2e91aa-move-cart-state-to-the-session',
    file: 'src/cart/CartProvider.ts',
    contents: `import { query } from '../db/client.js';

export interface CartLine {
  sku: string;
  qty: number;
}

// Cart state lives in the session store, so it follows a signed-in user
// between devices — task t-2e91aa.
export async function loadCart(sessionId: string): Promise<CartLine[]> {
  const rows = await query('SELECT lines FROM sessions WHERE id = ?', [sessionId]);
  const raw = rows[0]?.lines;
  if (typeof raw !== 'string') return [];
  try {
    return JSON.parse(raw) as CartLine[];
  } catch {
    return [];
  }
}

export async function saveCart(sessionId: string, lines: CartLine[]): Promise<void> {
  await query('UPDATE sessions SET lines = ? WHERE id = ?', [JSON.stringify(lines), sessionId]);
}
`,
  },
  {
    task: 't-58cc03',
    branch: 'dispatch/t-58cc03-rank-exact-sku-matches-above',
    file: 'src/search/rank.ts',
    contents: `import { tokenize } from './tokenize.js';

export interface Product {
  sku: string;
  title: string;
}

export interface Hit {
  sku: string;
  score: number;
}

const EXACT_SKU_BOOST = 100;

// An exact SKU match outranks every fuzzy hit — task t-58cc03.
export function rank(query: string, products: Product[]): Hit[] {
  const terms = tokenize(query);
  const hits: Hit[] = [];
  for (const product of products) {
    const haystack = tokenize(\`\${product.sku} \${product.title}\`);
    const overlap = terms.filter((t) => haystack.includes(t)).length;
    const exact = product.sku.toLowerCase() === query.trim().toLowerCase();
    const score = overlap + (exact ? EXACT_SKU_BOOST : 0);
    if (score > 0) hits.push({ sku: product.sku, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}
`,
  },
];

/** Copies the template into `root`, commits main, then lays down one branch per in-review fix. */
export function buildRepo(opts: { root: string; push: boolean }): void {
  const { root, push } = opts;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(DEMO.template, root, { recursive: true });

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial: storefront');

  for (const fix of BRANCH_FIXES) {
    git(root, 'checkout', '-q', '-b', fix.branch, 'main');
    writeFileSync(join(root, fix.file), fix.contents);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', `fix: ${fix.task}`);
    git(root, 'checkout', '-q', 'main');
  }

  if (push) {
    git(root, 'remote', 'add', 'origin', DEMO.remote);
    git(root, 'push', '-q', '--force', '--all', 'origin');
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/demo && bun test test/repo.test.ts` Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add packages/demo/src/git.ts packages/demo/src/repo.ts packages/demo/test/repo.test.ts
git commit -m "feat(demo): build the storefront repo with in-review fix branches"
```

---

### Task 4: Board state — config, team, tasks, gitattributes

Writes the committed `.dispatch/` state. Every new config field is set
non-default so the Settings tour has something to show, and tasks are spread
across all three actors so attribution is visibly plural.

**Files:**

- Create: `packages/demo/src/board.ts`
- Test: `packages/demo/test/board.test.ts`

**Interfaces:**

- Consumes: `ACTORS`, `OWNER`, `TEAMMATE` from `src/paths.js`
- Produces: `writeBoard(root: string): void`, `TASKS: DemoTask[]` where
  `type DemoTask = { id: string; title: string; status: string; kind: 'epic' | 'task'; parent: string | null; assignee: string; priority: string; labels: string[]; blockedBy: string[]; description: string; criteria: string[]; daysAgo: number }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/board.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBoard, TASKS } from '../src/board.js';
import { ACTORS } from '../src/paths.js';

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-board-'));
  writeBoard(root);
  return root;
}

test('every task lands as a file with matching frontmatter id', () => {
  const root = build();
  const files = readdirSync(join(root, '.dispatch/tasks'));
  expect(files.length).toBe(TASKS.length);
  for (const task of TASKS) {
    const file = files.find((f) => f.startsWith(task.id));
    expect(file).toBeDefined();
    const body = readFileSync(join(root, '.dispatch/tasks', file!), 'utf8');
    expect(body).toContain(`id: ${task.id}`);
    expect(body).toContain(`assignee: ${task.assignee}`);
  }
});

test('team.yml lists every actor', () => {
  const team = readFileSync(join(build(), '.dispatch/team.yml'), 'utf8');
  for (const actor of ACTORS) expect(team).toContain(`handle: ${actor.handle}`);
});

test('config sets every new field away from its default', () => {
  const config = readFileSync(join(build(), '.dispatch/config.yml'), 'utf8');
  for (const key of [
    'verifySteps',
    'fixLoop',
    'carto',
    'models',
    'verify',
    'linear',
  ]) {
    expect(config).toContain(`${key}:`);
  }
});

test('gitattributes registers the task and team merge drivers', () => {
  const attrs = readFileSync(join(build(), '.gitattributes'), 'utf8');
  expect(attrs).toContain('merge=dispatch-task');
  expect(attrs).toContain('merge=dispatch-team');
});

test('work is spread across all three actors', () => {
  const assigned = new Set(TASKS.map((t) => t.assignee));
  for (const actor of ACTORS) expect(assigned.has(actor.handle)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/demo && bun test test/board.test.ts` Expected: FAIL — cannot
resolve `../src/board.js`

- [ ] **Step 3: Write the board generator**

Implement `packages/demo/src/board.ts` exporting `TASKS` and `writeBoard(root)`.
It must:

1. Define the 12 tasks from the existing fixture (`e-4a19c2` Checkout rewrite,
   `e-77b3e1` Search relevance, and the ten tasks beneath them — ids, titles,
   statuses and descriptions are listed verbatim in `.agents/ignore/gen-demo.py`
   lines 39-67; read that file and carry them over), adding an `assignee` to
   each drawn from `ACTORS` so all three appear, and an `## Activity` section on
   at least three tasks crediting a different actor each.
2. Write each task to `.dispatch/tasks/<id>-<slug>.md` with frontmatter keys in
   this exact order: `id`, `title`, `status`, `kind`, `parent`, `milestone`,
   `blocked-by`, `labels`, `priority`, `assignee`, `created`, `updated`,
   `external`.
3. Write `.dispatch/team.yml` as `members:` with `handle`, `email`,
   `displayName`, `emails: []` per actor.
4. Write `.dispatch/config.yml` with `statuses`, `autoCommit: true`,
   `verifySteps` (typecheck/test/lint), `orchestrator` (`epicConcurrency: 3`,
   `maxTurns: 40`, `verifyTimeoutSec: 600`, `maxBudgetUsd: 5`,
   `permissionMode: acceptEdits`), `models` (all six roles), `fixLoop`
   (`cap: 5`, escalation rounds 1 and 4), `carto: { enabled: on }`,
   `verify: { command, url, notes }`, and `linear` (`enabled: true`, `teamId`,
   `statusMap`, `intervalSec`, `direction: both`) — **no API key**.
5. Write `.gitattributes` containing:

```
.dispatch/tasks/*.md merge=dispatch-task
.dispatch/team.yml merge=dispatch-team
```

Timestamps come from a fixed base date, not `Date.now()`, so regenerating
produces a stable board.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/demo && bun test test/board.test.ts` Expected: PASS, 5 tests

- [ ] **Step 5: Prove Dispatch's own parser accepts every generated task**

Hand-rolled frontmatter that _looks_ right but trips `TaskParseError` produces a
board that loads empty. Assert against the real parser, not a regex. Add to
`packages/demo/test/board.test.ts`:

```ts
import { parseTaskFile } from '@dispatch/core';

test('the real parser accepts every generated task file', () => {
  const root = build();
  const dir = join(root, '.dispatch/tasks');
  for (const file of readdirSync(dir)) {
    expect(() => parseTaskFile(join(dir, file))).not.toThrow();
  }
});
```

Add `"@dispatch/core": "workspace:*"` to `packages/demo/package.json`
dependencies. `@dispatch/*` resolves through `dist/`, so run
`bun install && bun run build` from the repo root first or the import will not
resolve.

If `parseTaskFile` is not the exported name, read
`packages/core/src/taskfile.ts` for the actual export and use it — do not work
around a failing import by hand-parsing.

Run: `cd packages/demo && bun test test/board.test.ts` Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add packages/demo/src/board.ts packages/demo/test/board.test.ts
git commit -m "feat(demo): seed tasks, team, config and merge drivers"
```

---

### Task 5: Findings, ledger, and per-actor inboxes

The records that make the review, fix-loop, and memory surfaces non-empty. Each
format covers its full range, so no verdict or ledger kind renders as an empty
state.

**Files:**

- Create: `packages/demo/src/records.ts`
- Test: `packages/demo/test/records.test.ts`

**Interfaces:**

- Consumes: `ACTORS`, `OWNER` from `src/paths.js`; `TASKS` from `src/board.js`
- Produces: `writeRecords(root: string): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/records.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBoard } from '../src/board.js';
import { writeRecords } from '../src/records.js';
import { ACTORS } from '../src/paths.js';

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-records-'));
  writeBoard(root);
  writeRecords(root);
  return root;
}

function lines(root: string, name: string): Record<string, unknown>[] {
  return readFileSync(join(root, '.dispatch', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('findings cover every severity and every verdict', () => {
  const findings = lines(build(), 'findings.jsonl');
  expect(new Set(findings.map((f) => f.severity))).toEqual(
    new Set(['critical', 'important', 'minor'])
  );
  expect(new Set(findings.map((f) => f.verdict))).toEqual(
    new Set(['open', 'addressed', 'parked', 'blocked'])
  );
});

test('parked and blocked findings carry a written ruling', () => {
  for (const f of lines(build(), 'findings.jsonl')) {
    if (f.verdict === 'parked' || f.verdict === 'blocked') {
      expect(typeof f.ruling).toBe('string');
      expect((f.ruling as string).length).toBeGreaterThan(0);
    }
  }
});

test('every finding carries the fields the reader dereferences', () => {
  for (const f of lines(build(), 'findings.jsonl')) {
    for (const key of [
      'id',
      'taskId',
      'severity',
      'verdict',
      'title',
      'detail',
      'createdAt',
    ]) {
      expect(f[key]).toBeDefined();
    }
    expect(typeof f.raisedBy).toBe('string');
  }
});

test('the ledger covers all four kinds', () => {
  const ledger = lines(build(), 'ledger.jsonl');
  expect(new Set(ledger.map((l) => l.kind))).toEqual(
    new Set(['constraint', 'hazard', 'decision', 'handoff'])
  );
});

test('each actor gets their own inbox with the id marker last', () => {
  const root = build();
  for (const actor of ACTORS) {
    const inbox = readFileSync(
      join(root, '.dispatch/inbox', `${actor.handle}.md`),
      'utf8'
    );
    for (const line of inbox.split('\n').filter((l) => l.includes('^in-'))) {
      expect(line.trimEnd()).toMatch(/\^in-[a-z0-9]+$/);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/demo && bun test test/records.test.ts` Expected: FAIL — cannot
resolve `../src/records.js`

- [ ] **Step 3: Write the records generator**

Implement `writeRecords(root)` emitting three things.

`.dispatch/findings.jsonl` — at least six findings against `t-2e91aa` and
`t-58cc03`, one line each, matching the `Finding` shape in
`packages/core/src/findings.ts` exactly: `id` (`f-` + 6 hex), `taskId`, `runId`,
`severity`, `verdict`, `title`, `detail`, `file`, `line`, `ruling`, `round`,
`createdAt`, `updatedAt`, `raisedBy`. Cover all three severities and all four
verdicts. Give the `parked` and `blocked` ones a ruling in the controller's
voice. Set `file` and `line` to real locations in the storefront so they anchor
onto the diff. Include one finding with a `files` array to show the many-file
case, and one with `recommendation: 'blocks'`.

`.dispatch/ledger.jsonl` — four entries matching `LedgerEntry` in
`packages/core/src/ledger.ts`: `id` (`l-` + 6 hex), `epicId`, `sourceTaskId`,
`kind`, `title`, `detail`, `appliesTo`, `createdAt`, `authoredBy`. One
`constraint`, one `hazard`, one `decision`, one `handoff`. Scope at least one to
an epic and leave one project-wide (`epicId: null`).

`.dispatch/inbox/<handle>.md` — one per actor. Carry over the six items from
`gen-demo.py` lines 69-77 into the owner's inbox and give the other two actors
two or three items each. The `^in-xxxx` marker is last on every line, after any
`@r-...` or `→ t-...`.

`raisedBy` and `authoredBy` hold a serialized `ActorRef`. Read
`packages/core/src/actor.ts` for the exact serialization and use it — do not
invent a format.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/demo && bun test test/records.test.ts` Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/demo/src/records.ts packages/demo/test/records.test.ts
git commit -m "feat(demo): seed findings, ledger and per-actor inboxes"
```

---

### Task 6: Run transcripts

Populates run history under each clone's `DISPATCH_HOME`. Every run must be
terminal — the single most common way a fixture silently breaks.

**Files:**

- Create: `packages/demo/src/runs.ts`
- Test: `packages/demo/test/runs.test.ts`

**Interfaces:**

- Consumes: `DEMO`, `runsDir`, `actorFile`, `OWNER` from `src/paths.js`
- Produces: `writeRuns(rootDir: string, home: string, handle: string): void`,
  `TERMINAL_STATES: readonly string[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/runs.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actorFile, runsDir } from '../src/paths.js';
import { TERMINAL_STATES, writeRuns } from '../src/runs.js';

function build(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'demo-root-'));
  const home = mkdtempSync(join(tmpdir(), 'demo-home-'));
  writeRuns(root, home, 'wsoule679');
  return { root, home };
}

test('every seeded run ends in a terminal state', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  for (const file of readdirSync(dir)) {
    const parsed = readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { type: string; state?: string });
    const last = parsed.at(-1)!;
    expect(last.type).toBe('state');
    expect(TERMINAL_STATES).toContain(last.state!);
  }
});

test('every transcript opens with a header carrying its meta', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  for (const file of readdirSync(dir)) {
    const first = JSON.parse(
      readFileSync(join(dir, file), 'utf8').split('\n')[0]!
    ) as {
      type: string;
      meta: { id: string; taskId: string; branch: string };
    };
    expect(first.type).toBe('header');
    expect(first.meta.id).toBe(file.replace('.jsonl', ''));
    expect(first.meta.taskId).toMatch(/^t-/);
  }
});

test('the actor identity file records the handle', () => {
  const { root, home } = build();
  const identity = JSON.parse(readFileSync(actorFile(root, home), 'utf8')) as {
    handle: string;
  };
  expect(identity.handle).toBe('wsoule679');
});

test('a stopped run is present and terminal', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  const states = readdirSync(dir).map((f) => {
    const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n');
    return (JSON.parse(lines.at(-1)!) as { state: string }).state;
  });
  expect(states).toContain('stopped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/demo && bun test test/runs.test.ts` Expected: FAIL — cannot
resolve `../src/runs.js`

- [ ] **Step 3: Write the run generator**

Port the transcript writer from `.agents/ignore/gen-demo.py` lines 92-143 to
TypeScript, keeping its JSONL shape: a `header` line carrying `meta`, one
`entry` line per step, and a final `state` line carrying `costUsd`, `turns`,
`sessionId`, and optionally `reviewedAt`/`reviewAction`.

Read `packages/server/src/orchestrator/` for the exact state names before
writing `TERMINAL_STATES`; confirm `stopped` is what a gracefully halted run
persists rather than assuming it.

Beyond the eight existing runs, add one of each new kind, all terminal:

- a **review run** against `t-2e91aa` whose entries reference the findings from
  Task 5 by id, and whose `file`/`line` match them
- a **fix loop** across three rounds on `t-58cc03`, the third dispatched fresh
  at the high tier per the escalation ladder
- a **verify run** whose entries carry `CommandEvidence` and `MutationEvidence`
  records shaped per `packages/core/src/evidence.ts`
- a **scope request** that was granted
- a **plan draft** holding unanswered questions
- a **stopped run**, so the Stop button has history behind it

Also write the actor identity file at `actorFile(rootDir, home)` as
`{"handle":"<handle>"}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/demo && bun test test/runs.test.ts` Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/demo/src/runs.ts packages/demo/test/runs.test.ts
git commit -m "feat(demo): seed run transcripts for every run kind"
```

---

### Task 7: Teammate puppet

The second clone and the commands that drive it. This is what makes the sync
chip move and the merge driver fire.

**Files:**

- Create: `packages/demo/src/teammate.ts`
- Test: `packages/demo/test/teammate.test.ts`

**Interfaces:**

- Consumes: `git` from `src/git.js`; `DEMO`, `TEAMMATE` from `src/paths.js`
- Produces: `claim(taskId: string): void`, `addTask(): string`,
  `conflict(taskId: string): void`, each committing and pushing from
  `DEMO.teammateRoot`

- [ ] **Step 1: Write the failing test**

The test drives a local bare remote rather than GitHub, so it never touches the
network.

```ts
// packages/demo/test/teammate.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.js';
import { claimIn, conflictIn } from '../src/teammate.js';

// Builds a bare remote with one board, plus two clones of it.
function twoClones(): { mine: string; theirs: string } {
  const bare = mkdtempSync(join(tmpdir(), 'demo-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = mkdtempSync(join(tmpdir(), 'demo-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'task.md'), 'status: todo\nassignee: none\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  const mine = mkdtempSync(join(tmpdir(), 'demo-mine-'));
  const theirs = mkdtempSync(join(tmpdir(), 'demo-theirs-'));
  git(mine, 'clone', '-q', bare, '.');
  git(theirs, 'clone', '-q', bare, '.');
  return { mine, theirs };
}

test('claim pushes a change the other clone can pull', () => {
  const { mine, theirs } = twoClones();
  claimIn(theirs, 'task.md', 'pmirand');
  git(mine, 'pull', '-q', '--rebase');
  expect(readFileSync(join(mine, 'task.md'), 'utf8')).toContain(
    'assignee: pmirand'
  );
});

test('conflict edits a different field than the local side', () => {
  const { mine, theirs } = twoClones();
  conflictIn(theirs, 'task.md');
  const theirText = readFileSync(join(theirs, 'task.md'), 'utf8');
  expect(theirText).toContain('status: in-progress');
  expect(theirText).toContain('assignee: none');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/demo && bun test test/teammate.test.ts` Expected: FAIL —
cannot resolve `../src/teammate.js`

- [ ] **Step 3: Write the puppet**

Implement `packages/demo/src/teammate.ts` with two layers: pure
`*In(cwd, file, ...)` helpers the test drives against any directory, and thin
`claim`/`addTask`/`conflict` wrappers that bind them to `DEMO.teammateRoot` and
push to `origin`.

- `claimIn(cwd, file, handle)` — rewrites the task's `assignee:` line, commits,
  pushes
- `conflictIn(cwd, file)` — rewrites only the `status:` line and pushes, leaving
  `assignee:` alone, so the local side can edit `assignee:` and the merge driver
  resolves field-by-field
- `addTask()` — writes a new task file into `.dispatch/tasks/`, commits, pushes

Each wrapper prints what it did, so you can see it landed while demoing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/demo && bun test test/teammate.test.ts` Expected: PASS, 2
tests

- [ ] **Step 5: Commit**

```bash
git add packages/demo/src/teammate.ts packages/demo/test/teammate.test.ts
git commit -m "feat(demo): add the teammate puppet"
```

---

### Task 8: CLI, reset, and preflight

Ties the generators into one command surface. `reset` matters because the demo
gets run more than once; `preflight` catches the two failures that are silent by
design.

**Files:**

- Create: `packages/demo/src/preflight.ts`
- Create: `packages/demo/src/cli.ts`
- Test: `packages/demo/test/preflight.test.ts`

**Interfaces:**

- Consumes: everything above
- Produces: `runPreflight(): Check[]` where
  `type Check = { name: string; ok: boolean; detail: string }`; a CLI with
  subcommands `reset`, `preflight`,
  `teammate <claim|add-task|conflict> [taskId]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/demo/test/preflight.test.ts
import { expect, test } from 'bun:test';
import {
  checkNoCredentialsStaged,
  checkRunsTerminal,
} from '../src/preflight.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a non-terminal run is reported, not ignored', () => {
  const home = mkdtempSync(join(tmpdir(), 'demo-pf-'));
  const dir = join(home, '.dispatch/runs', 'deadbeefcafe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'r-bad.jsonl'),
    `${JSON.stringify({ type: 'header', meta: { id: 'r-bad', taskId: 't-1' } })}\n` +
      `${JSON.stringify({ type: 'state', state: 'running' })}\n`
  );
  const check = checkRunsTerminal(join(home, '.dispatch/runs'));
  expect(check.ok).toBe(false);
  expect(check.detail).toContain('r-bad');
});

test('a credentials file staged for commit fails preflight', () => {
  const check = checkNoCredentialsStaged([
    '.dispatch/config.yml',
    'credentials.json',
  ]);
  expect(check.ok).toBe(false);
  expect(check.detail).toContain('credentials.json');
});

test('a clean stage passes', () => {
  expect(checkNoCredentialsStaged(['.dispatch/config.yml']).ok).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/demo && bun test test/preflight.test.ts` Expected: FAIL —
cannot resolve `../src/preflight.js`

- [ ] **Step 3: Write preflight**

Implement `packages/demo/src/preflight.ts` exporting the two pure checks above
plus `runPreflight()`, which additionally asserts:

- `carto --version` exits 0 (carto degrades silently to the built-in scanner
  when absent)
- `~/.dispatch/credentials.json` exists and parses, and holds a Linear key
- `DEMO.teammateRoot` has no unpushed commits
- both clones' `git status --porcelain` is empty

Each check returns `{ name, ok, detail }`; `runPreflight` prints them as a table
and exits non-zero if any failed.

- [ ] **Step 4: Write the CLI**

`packages/demo/src/cli.ts` dispatches on `process.argv[2]`:

- `reset` — `buildRepo({ root: DEMO.root, push: true })`, `writeBoard`,
  `writeRecords`, commit and push the board, `writeRuns` for both clones, then
  clone the remote into `DEMO.teammateRoot` and write the teammate's identity
- `preflight` — `runPreflight()`
- `teammate claim <taskId>` / `teammate add-task` / `teammate conflict <taskId>`

An unknown subcommand prints usage and exits 1 — never a silent no-op.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/demo && bun test test/preflight.test.ts` Expected: PASS, 3
tests

- [ ] **Step 6: Commit**

```bash
git add packages/demo/src/preflight.ts packages/demo/src/cli.ts packages/demo/test/preflight.test.ts
git commit -m "feat(demo): add the demo CLI with reset and preflight"
```

---

### Task 9: End-to-end run, demo runbook, retire the old generator

Proves the whole thing boots, and leaves you something to follow on the day.

**Files:**

- Create: `docs/superpowers/plans/2026-08-04-demo-runbook.md`
- Delete: `.agents/ignore/gen-demo.py`

- [ ] **Step 1: Create the GitHub repo**

```bash
gh repo create wsoule/storefront --public --description "Dispatch demo project"
```

- [ ] **Step 2: Run a full reset**

```bash
export AGENT=1
bun packages/demo/src/cli.ts reset
```

Expected: the command completes, `.agents/ignore/storefront` and
`.agents/ignore/teammate/storefront` both exist, and the remote has `main` plus
two `dispatch/*` branches.

- [ ] **Step 3: Verify the generated storefront is green**

```bash
cd .agents/ignore/storefront && bun install && bun test && bun run tsc
```

Expected: tests pass, tsc clean. If either fails, the verify panel will be red
during the demo — fix before continuing.

- [ ] **Step 4: Boot the daemon and confirm no run failed on boot**

```bash
DISPATCH_HOME=.agents/ignore/storefront-home \
  bun packages/server/src/bin.ts --root "$(pwd)/.agents/ignore/storefront"
```

Open the app against it and confirm every seeded run shows its intended state. A
run showing `failed` that you seeded as `finished` means `reconcileOnBoot`
rejected it — the transcript's final state line is wrong.

- [ ] **Step 5: Run preflight**

```bash
bun packages/demo/src/cli.ts preflight
```

Expected: every check green. Carto red means the graph silently falls back and
blast radius will look empty.

- [ ] **Step 6: Rehearse the teammate**

```bash
bun packages/demo/src/cli.ts teammate claim t-1d77e5
bun packages/demo/src/cli.ts teammate conflict t-6c40de
```

Expected: the sync chip moves and the board updates without a manual merge.

- [ ] **Step 7: Write the runbook**

`docs/superpowers/plans/2026-08-04-demo-runbook.md` carries the eleven-stop demo
path from the spec's "Demo path" section, each stop naming the exact screen, the
exact click, and the one sentence to say. Add a "if it breaks" line per stop —
chiefly: the live run on `t-3f8a21` falls back to its seeded transcript.

- [ ] **Step 8: Delete the superseded generator**

```bash
git rm .agents/ignore/gen-demo.py 2>/dev/null || rm .agents/ignore/gen-demo.py
```

`.agents/ignore/` is gitignored, so this is a plain delete.

- [ ] **Step 9: Full verification from the root**

```bash
bun run format && bun run lint && bun ws demo tsc && bun ws demo test
```

Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add docs/superpowers/plans/2026-08-04-demo-runbook.md
git commit -m "docs(demo): add the demo runbook and retire gen-demo.py"
```

---

## Self-Review Notes

Checked against the spec:

- Architecture's four artifacts → Task 1 (`DEMO`), Task 3 (clones), Task 8
  (`reset` wires both homes)
- Storefront codebase and its import fan-in → Task 2
- Defect-placement-by-status → Task 2 (main) and Task 3 (`BRANCH_FIXES`)
- Seeded board state, all seven files → Tasks 4 and 5
- Seeded run history, all six new kinds → Task 6
- Teammate puppet, all three subcommands → Task 7
- Carto and Linear rails → Task 8 (`runPreflight`)
- `reset` and `preflight` → Task 8
- Demo path → Task 9 runbook
- Testing bar (reset→preflight cold, no failed-on-boot, conflict auto-resolves,
  storefront green) → Task 9 steps 2-6

Two spec details deliberately deferred into their tasks rather than pinned here,
because both depend on reading current source and guessing would produce a
fixture that loads empty: the exact `ActorRef` serialization for `raisedBy` /
`authoredBy` (Task 5, Step 3) and the exact terminal run-state names (Task 6,
Step 3). Both steps name the file to read.
