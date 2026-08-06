# Blast Radius Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the dependency reach Dispatch already computes — given a file, a run, or a task, show which files are affected and how far away each one is.

**Architecture:** Three layers. `depmap.ts` gains `reach()`, a transitive walk that preserves hop distance and unions carto's blast radius with a BFS over the scanner's reverse-import graph, taking the shortest distance per file. `impact.ts` resolves any of three subject kinds to a file set and calls `reach()` once. A route, a client binding, and two desktop surfaces render one `ReachResult`.

**Tech Stack:** Bun, TypeScript, React, shadcn/ui (`new-york`, base `neutral`, `lucide` icons), Tailwind via the repo's `chrome/` token layer.

## Global Constraints

- Bun only. Never `npm`, `pnpm`, or `npx`. Adding a shadcn primitive uses `bunx shadcn@latest add <name>`.
- Dependencies go in the root `workspaces.catalog`, never a package's own `package.json`. Workspace-internal deps use `"@dispatch/core": "workspace:*"`.
- `bunfig.toml` sets `minimumReleaseAge=7d`; a dependency published this week will not install.
- `export AGENT=1` before running tests.
- Preserve trailing newlines at end of files.
- Comments: 1-2 lines, function-level, concrete. No incident narratives.
- `ReviewRunner`'s prompt must stay byte-identical. `normalizeBlastRadius(raw): string[]` keeps its exact signature and output.
- `scripts/check-chrome-utilities.ts` fails the build on raw Tailwind palette hues. Colour comes from tokens via `chrome/`.
- Never add a lint-disable comment or narrow a lint rule in config to make a finding go away. Fix it for real.
- Verification after code changes: `bun run format` and `bun run lint` from the root, plus the changed package's `tsc` and focused tests.

## Delivery

Work happens in a fresh worktree off `main` at `../dispatch-worktrees/blast-radius`, NOT in `feat/demo-environment` (open PR). A fresh worktree needs `bun install && bun run build` from its root before `tsc` or tests resolve `@dispatch/*`.

---

### Task 1: Preserve hop distance through normalization

The smallest possible first change, and the one everything else needs. Carto already reports `hop_distance` per file; `normalizeBlastRadius` uses it to sort and dedupe, then throws it away.

**Files:**
- Modify: `packages/server/src/depmap.ts:456-486`
- Test: `packages/server/test/depmap.test.ts`

**Interfaces:**
- Consumes: `CartoBlastRadius` from `@dispatch/core` — `{ count: number; hops: number; files: unknown[] }`
- Produces: `normalizeBlastRadiusEntries(raw: CartoBlastRadius): BlastEntry[]` where `interface BlastEntry { path: string; hops: number }`, and `normalizeBlastRadius(raw): string[]` unchanged

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/depmap.test.ts — add to the existing file
import { normalizeBlastRadiusEntries } from '../src/depmap.js';

test('normalizeBlastRadiusEntries keeps each file\'s hop distance', () => {
  const entries = normalizeBlastRadiusEntries({
    count: 3,
    hops: 2,
    files: [
      { file: 'b.ts', hop_distance: 2 },
      { file: 'a.ts', hop_distance: 1 },
    ],
  });
  expect(entries).toEqual([
    { path: 'a.ts', hops: 1 },
    { path: 'b.ts', hops: 2 },
  ]);
});

test('normalizeBlastRadiusEntries keeps the shortest route to a file', () => {
  const entries = normalizeBlastRadiusEntries({
    count: 2,
    hops: 3,
    files: [
      { file: 'a.ts', hop_distance: 3 },
      { file: 'a.ts', hop_distance: 1 },
    ],
  });
  expect(entries).toEqual([{ path: 'a.ts', hops: 1 }]);
});

test('normalizeBlastRadius still returns bare paths, closest first', () => {
  const paths = normalizeBlastRadius({
    count: 2,
    hops: 2,
    files: [
      { file: 'b.ts', hop_distance: 2 },
      { file: 'a.ts', hop_distance: 1 },
    ],
  });
  expect(paths).toEqual(['a.ts', 'b.ts']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/depmap.test.ts`
Expected: FAIL — `normalizeBlastRadiusEntries` is not exported

- [ ] **Step 3: Split the function**

Replace the body of `normalizeBlastRadius` (`depmap.ts:456-486`) with an entries function plus a one-line map. Keep every existing behaviour: string entries fall back to `raw.hops`; object entries accept `file`/`path` and `hop_distance`/`hops`; non-string paths are skipped; shortest route wins; ties sort by path.

```ts
export interface BlastEntry {
  path: string;
  hops: number;
}

// Carto reports one entry per route, so the same file can appear at several
// distances; the closest is the one that matters.
export function normalizeBlastRadiusEntries(
  raw: CartoBlastRadius
): BlastEntry[] {
  const closest = new Map<string, number>();
  for (const file of raw.files) {
    let path: string | undefined;
    let hops: number | undefined;
    if (typeof file === 'string') {
      path = file;
      hops = raw.hops;
    } else if (typeof file === 'object' && file !== null) {
      const record = file as Record<string, unknown>;
      const rawPath = record.file ?? record.path;
      if (typeof rawPath !== 'string') continue;
      path = rawPath;
      const rawHops = record.hop_distance ?? record.hops;
      hops = typeof rawHops === 'number' ? rawHops : raw.hops;
    } else {
      continue;
    }
    const existing = closest.get(path);
    if (existing === undefined || hops < existing) closest.set(path, hops);
  }
  return [...closest.entries()]
    .sort(([pa, ha], [pb, hb]) =>
      ha !== hb ? ha - hb : pa < pb ? -1 : pa > pb ? 1 : 0
    )
    .map(([path, hops]) => ({ path, hops }));
}

export function normalizeBlastRadius(raw: CartoBlastRadius): string[] {
  return normalizeBlastRadiusEntries(raw).map((e) => e.path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/depmap.test.ts`
Expected: PASS

- [ ] **Step 5: Prove ReviewRunner is unaffected**

Run: `cd packages/server && bun test test/orchestrator/review.test.ts test/carto-integration.test.ts`
Expected: PASS, unchanged. These exercise the review prompt; a diff in their output means the refactor changed behaviour.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/depmap.ts packages/server/test/depmap.test.ts
git commit -m "refactor(server): keep hop distance when normalizing blast radius"
```

---

### Task 2: `reach()` — the transitive walk

The core of the feature, and where subtle wrongness hides. Two graphs contribute distance differently and must be reconciled by shortest hop.

**Files:**
- Modify: `packages/server/src/depmap.ts` (the `DepMap` interface, `buildDepMap`, `createCartoDepMap`)
- Test: `packages/server/test/reach.test.ts`

**Interfaces:**
- Consumes: `BlastEntry`, `normalizeBlastRadiusEntries` from Task 1
- Produces:

```ts
export interface ReachOptions {
  maxHops: number;
  maxFiles: number;
}

export interface ReachResult {
  entries: BlastEntry[]; // closest-first
  count: number;
  maxHops: number; // deepest hop actually reached
  sources: ('carto' | 'scanner')[];
  degraded: boolean;
  truncated: boolean;
}

export const DEFAULT_REACH: ReachOptions = { maxHops: 5, maxFiles: 500 };

// added to the DepMap interface
reach(files: string[], opts?: Partial<ReachOptions>): ReachResult;
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/reach.test.ts
import { expect, test } from 'bun:test';
import type { DepMap } from '../src/depmap.js';
import { reachOver } from '../src/depmap.js';

// A scanner-shaped stub: importer -> the files it is a dependent of.
function scannerOf(graph: Record<string, string[]>): DepMap {
  return {
    dependents: (file) => graph[file] ?? [],
    mirrors: () => [],
    reach: () => {
      throw new Error('unused');
    },
  };
}

test('walks transitively and records distance', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.entries).toEqual([
    { path: 'b.ts', hops: 1 },
    { path: 'c.ts', hops: 2 },
  ]);
  expect(result.maxHops).toBe(2);
  expect(result.truncated).toBe(false);
});

test('terminates on a cycle', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.entries).toEqual([{ path: 'b.ts', hops: 1 }]);
});

test('a diamond records the shortest distance', () => {
  const map = scannerOf({
    'a.ts': ['b.ts', 'd.ts'],
    'b.ts': ['c.ts'],
    'c.ts': ['d.ts'],
  });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.entries.find((e) => e.path === 'd.ts')?.hops).toBe(1);
});

test('the seed files are never reported as their own dependents', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
  const result = reachOver(map, ['a.ts', 'b.ts'], {
    maxHops: 5,
    maxFiles: 500,
  });
  expect(result.entries).toEqual([]);
});

test('the hop cap stops the walk and sets truncated', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 1, maxFiles: 500 });
  expect(result.entries).toEqual([{ path: 'b.ts', hops: 1 }]);
  expect(result.truncated).toBe(true);
});

test('the file cap stops the walk and sets truncated', () => {
  const map = scannerOf({ 'a.ts': ['b.ts', 'c.ts', 'd.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 2 });
  expect(result.count).toBe(2);
  expect(result.truncated).toBe(true);
});

test('an exhausted walk is not marked truncated', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.truncated).toBe(false);
});

test('results are ordered by distance, never interleaved by source', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  const hops = result.entries.map((e) => e.hops);
  expect(hops).toEqual([...hops].sort((x, y) => x - y));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/reach.test.ts`
Expected: FAIL — `reachOver` is not exported

- [ ] **Step 3: Implement the shared walk**

Add `reachOver` to `depmap.ts` as a standalone function so both `DepMap` implementations share one traversal, and wire `reach` on the object `buildDepMap` returns.

```ts
export interface ReachOptions {
  maxHops: number;
  maxFiles: number;
}

export interface ReachResult {
  entries: BlastEntry[];
  count: number;
  maxHops: number;
  sources: ('carto' | 'scanner')[];
  degraded: boolean;
  truncated: boolean;
}

export const DEFAULT_REACH: ReachOptions = { maxHops: 5, maxFiles: 500 };

// Breadth-first over reverse-import edges, recording the shortest distance to
// each file. Seeds are excluded from their own result — a file is not its own
// blast radius.
export function reachOver(
  map: DepMap,
  files: string[],
  opts: ReachOptions
): ReachResult {
  const seeds = new Set(files);
  const closest = new Map<string, number>();
  let frontier = [...seeds];
  let hops = 0;
  let truncated = false;

  while (frontier.length > 0 && hops < opts.maxHops) {
    hops++;
    const next: string[] = [];
    for (const file of frontier) {
      for (const dependent of map.dependents(file)) {
        if (seeds.has(dependent) || closest.has(dependent)) continue;
        if (closest.size >= opts.maxFiles) {
          truncated = true;
          continue;
        }
        closest.set(dependent, hops);
        next.push(dependent);
      }
    }
    frontier = next;
  }
  // A frontier still holding work when the hop cap stopped us means the walk
  // was cut short, not exhausted.
  if (frontier.length > 0) truncated = true;

  return {
    entries: sortEntries(closest),
    count: closest.size,
    maxHops: closest.size === 0 ? 0 : Math.max(...closest.values()),
    sources: ['scanner'],
    degraded: false,
    truncated,
  };
}

// Closest first, then by path so output is stable.
function sortEntries(closest: Map<string, number>): BlastEntry[] {
  return [...closest.entries()]
    .sort(([pa, ha], [pb, hb]) =>
      ha !== hb ? ha - hb : pa < pb ? -1 : pa > pb ? 1 : 0
    )
    .map(([path, hops]) => ({ path, hops }));
}
```

Then add `reach` to the `DepMap` interface and to the object returned by `buildDepMap`:

```ts
reach(files: string[], opts?: Partial<ReachOptions>): ReachResult {
  return reachOver(this, files, { ...DEFAULT_REACH, ...opts });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/reach.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/depmap.ts packages/server/test/reach.test.ts
git commit -m "feat(server): add a transitive reach walk with hop distance"
```

---

### Task 3: Union carto's distances with the scanner's

`createCartoDepMap.dependents()` round-robin merges carto and scanner results because neither dominates — but that merge deliberately does not order by distance. `reach` needs a different reconciliation: shortest hop wins.

**Files:**
- Modify: `packages/server/src/depmap.ts` (`createCartoDepMap`)
- Test: `packages/server/test/reach-carto.test.ts`

**Interfaces:**
- Consumes: `reachOver`, `ReachResult`, `DEFAULT_REACH` from Task 2; `normalizeBlastRadiusEntries` from Task 1; `CartoReader` from `@dispatch/core` — `{ blastRadius(file: string): CartoBlastRadius }`
- Produces: a `reach` implementation on the object `createCartoDepMap` returns

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/reach-carto.test.ts
import { expect, test } from 'bun:test';
import type { CartoBlastRadius } from '@dispatch/core';
import {
  DEFAULT_REACH,
  createCartoDepMap,
  reachOver,
  type DepMap,
} from '../src/depmap.js';

// A scanner-shaped DepMap whose reach() runs the real shared walk, so these
// tests exercise the union rather than a stubbed traversal.
function scannerOf(graph: Record<string, string[]>): DepMap {
  const map: DepMap = {
    dependents: (file) => graph[file] ?? [],
    mirrors: () => [],
    reach: (files, opts) =>
      reachOver(map, files, { ...DEFAULT_REACH, ...opts }),
  };
  return map;
}

// Minimal reader returning fixed carto answers per file.
function readerOf(answers: Record<string, CartoBlastRadius>) {
  return {
    blastRadius: (file: string) =>
      answers[file] ?? { count: 0, hops: 0, files: [] },
  };
}

test('a file both graphs reach is recorded at the shorter distance', () => {
  const scanner = scannerOf({ 'a.ts': ['near.ts'] });
  const reader = readerOf({
    'a.ts': { count: 1, hops: 2, files: [{ file: 'near.ts', hop_distance: 2 }] },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts']);
  expect(result.entries).toEqual([{ path: 'near.ts', hops: 1 }]);
});

test('carto-only files survive the union', () => {
  const scanner = scannerOf({ 'a.ts': [] });
  const reader = readerOf({
    'a.ts': { count: 1, hops: 3, files: [{ file: 'far.py', hop_distance: 3 }] },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts']);
  expect(result.entries).toEqual([{ path: 'far.py', hops: 3 }]);
  expect(result.sources).toEqual(['carto', 'scanner']);
});

test('a throwing reader degrades to the scanner and says so', () => {
  const scanner = scannerOf({ 'a.ts': ['b.ts'] });
  const reader = {
    blastRadius(): CartoBlastRadius {
      throw new Error('container half-written');
    },
  };
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts']);
  expect(result.entries).toEqual([{ path: 'b.ts', hops: 1 }]);
  expect(result.sources).toEqual(['scanner']);
  expect(result.degraded).toBe(true);
});
```

`createCartoDepMap`'s fourth argument is the optional `onDegrade` callback; these tests omit it, which is why the degradation case asserts on the returned `degraded` flag rather than on a spy.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/reach-carto.test.ts`
Expected: FAIL — the object from `createCartoDepMap` has no `reach`

- [ ] **Step 3: Implement the union**

Add `reach` to the object `createCartoDepMap` returns. It runs the scanner BFS via `reachOver` against `fallback`, collects carto's entries for each seed, and merges by shortest hop.

```ts
reach(files: string[], opts?: Partial<ReachOptions>): ReachResult {
  const options = { ...DEFAULT_REACH, ...opts };
  const scanner = reachOver(fallback, files, options);
  if (degraded) return { ...scanner, degraded: true };

  const seeds = new Set(files);
  const closest = new Map<string, number>();
  for (const entry of scanner.entries) closest.set(entry.path, entry.hops);

  for (const file of files) {
    let entries: BlastEntry[];
    try {
      entries = normalizeBlastRadiusEntries(
        reader.blastRadius(normalizeInputPath(file))
      );
    } catch (err) {
      degraded = true;
      onDegrade?.({ file, detail: (err as Error).message });
      return { ...scanner, degraded: true };
    }
    for (const entry of entries) {
      if (seeds.has(entry.path) || entry.hops > options.maxHops) continue;
      const existing = closest.get(entry.path);
      if (existing !== undefined && existing <= entry.hops) continue;
      if (existing === undefined && closest.size >= options.maxFiles) continue;
      closest.set(entry.path, entry.hops);
    }
  }

  const capped = closest.size >= options.maxFiles;
  return {
    entries: sortEntries(closest),
    count: closest.size,
    maxHops: closest.size === 0 ? 0 : Math.max(...closest.values()),
    sources: ['carto', 'scanner'],
    degraded: false,
    truncated: scanner.truncated || capped,
  };
}
```

Export `sortEntries` from `depmap.ts` so both implementations share it rather than each keeping a copy.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/reach-carto.test.ts test/reach.test.ts`
Expected: PASS

- [ ] **Step 5: Confirm `dependents()` is untouched**

Run: `cd packages/server && bun test test/depmap.test.ts test/carto-integration.test.ts test/orchestrator/review.test.ts`
Expected: PASS. `reach` is additive; `dependents()` must still round-robin merge.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/depmap.ts packages/server/test/reach-carto.test.ts
git commit -m "feat(server): union carto and scanner reach by shortest distance"
```

---

### Task 4: Subject resolution

Turns a file, a run, or a task into the file set `reach` walks. This is the only layer that differs between the three subjects.

**Files:**
- Create: `packages/server/src/impact.ts`
- Test: `packages/server/test/impact.test.ts`

**Interfaces:**
- Consumes: `DepMap`, `ReachResult`, `DEFAULT_REACH` from Tasks 2-3
- Produces:

```ts
export type ImpactSubject =
  | { kind: 'file'; path: string }
  | { kind: 'run'; runId: string }
  | { kind: 'task'; taskId: string };

export interface ImpactDeps {
  rootDir: string;
  depMap: () => DepMap;
  changedFilesForRun(runId: string): string[] | null;
  writesForTask(taskId: string): string[] | null;
  trackedFiles(): string[];
}

export type ImpactResult =
  | { ok: true; subject: ImpactSubject; seeds: string[]; reach: ReachResult }
  | { ok: false; reason: 'not-found' | 'outside-root' | 'no-declared-writes' };

export function computeImpact(
  subject: ImpactSubject,
  deps: ImpactDeps
): ImpactResult;
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/impact.test.ts
import { expect, test } from 'bun:test';
import type { DepMap } from '../src/depmap.js';
import { computeImpact, type ImpactDeps } from '../src/impact.js';

const depMap: DepMap = {
  dependents: (f) => (f === 'src/db.ts' ? ['src/api.ts'] : []),
  mirrors: () => [],
  reach: () => {
    throw new Error('replaced below');
  },
};

function deps(over: Partial<ImpactDeps> = {}): ImpactDeps {
  return {
    rootDir: '/repo',
    depMap: () => ({
      ...depMap,
      reach: () => ({
        entries: [{ path: 'src/api.ts', hops: 1 }],
        count: 1,
        maxHops: 1,
        sources: ['scanner'],
        degraded: false,
        truncated: false,
      }),
    }),
    changedFilesForRun: () => null,
    writesForTask: () => null,
    trackedFiles: () => ['src/db.ts', 'src/api.ts'],
    ...over,
  };
}

test('a file subject seeds itself', () => {
  const result = computeImpact({ kind: 'file', path: 'src/db.ts' }, deps());
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.seeds).toEqual(['src/db.ts']);
});

test('a path escaping the repo root is rejected before touching the graph', () => {
  const result = computeImpact({ kind: 'file', path: '../../etc/passwd' }, deps());
  expect(result).toEqual({ ok: false, reason: 'outside-root' });
});

test('a run subject seeds its changed files', () => {
  const result = computeImpact(
    { kind: 'run', runId: 'r-1' },
    deps({ changedFilesForRun: () => ['src/db.ts'] })
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.seeds).toEqual(['src/db.ts']);
});

test('an unknown run is not-found, not an empty result', () => {
  const result = computeImpact({ kind: 'run', runId: 'nope' }, deps());
  expect(result).toEqual({ ok: false, reason: 'not-found' });
});

test('a task subject expands its declared write globs against tracked files', () => {
  const result = computeImpact(
    { kind: 'task', taskId: 't-1' },
    deps({ writesForTask: () => ['src/*.ts'] })
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.seeds.sort()).toEqual(['src/api.ts', 'src/db.ts']);
});

test('a task with no declared writes says so rather than guessing', () => {
  const result = computeImpact(
    { kind: 'task', taskId: 't-1' },
    deps({ writesForTask: () => [] })
  );
  expect(result).toEqual({ ok: false, reason: 'no-declared-writes' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/impact.test.ts`
Expected: FAIL — cannot resolve `../src/impact.js`

- [ ] **Step 3: Implement resolution**

Write `packages/server/src/impact.ts`. It must:

1. For `file`: resolve the path against `rootDir` and reject anything escaping it (`outside-root`) before any graph call.
2. For `run`: call `changedFilesForRun`; `null` means `not-found`.
3. For `task`: call `writesForTask`; `null` means `not-found`, `[]` means `no-declared-writes`. Expand the globs against `trackedFiles()`.
4. Call `depMap().reach(seeds)` once and return `{ ok: true, subject, seeds, reach }`.

For glob matching, reuse the matcher the undeclared-write findings already use rather than adding a second one — find it by searching for where declared writes are checked against a diff (`grep -rn "writes" packages/server/src` and follow it). If it is not exported, export it; do not reimplement glob semantics, or the two will disagree about what a task declared.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/impact.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/impact.ts packages/server/test/impact.test.ts
git commit -m "feat(server): resolve file, run and task subjects to a reach query"
```

---

### Task 5: The HTTP route

**Files:**
- Create: `packages/server/src/api/impact.ts`
- Modify: the router (find it: `grep -rn "api/findings" packages/server/src/api.ts packages/server/src/index.ts`)
- Test: `packages/server/test/impact-api.test.ts`

**Interfaces:**
- Consumes: `computeImpact`, `ImpactSubject`, `ImpactResult` from Task 4
- Produces: `GET /api/impact?subject=file|run|task&id=<value>` returning `ReachResult` plus `{ subject, seeds }` on 200

- [ ] **Step 1: Write the failing test**

Follow the existing pattern in `packages/server/test/findings-api.test.ts` for harness setup and auth — read it first and mirror it, including `test/testAuth.ts`.

```ts
// packages/server/test/impact-api.test.ts
test('returns reach for a file subject', async () => {
  const res = await authedGet('/api/impact?subject=file&id=src/db/client.ts');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.reach.entries)).toBe(true);
  expect(body.reach.sources).toContain('scanner');
});

test('an unknown subject kind is a 400', async () => {
  const res = await authedGet('/api/impact?subject=banana&id=x');
  expect(res.status).toBe(400);
});

test('an unknown run is a 404, not a 500', async () => {
  const res = await authedGet('/api/impact?subject=run&id=r-nope');
  expect(res.status).toBe(404);
});

test('a path escaping the root is a 400', async () => {
  const res = await authedGet('/api/impact?subject=file&id=../../etc/passwd');
  expect(res.status).toBe(400);
});

test('a missing id is a 400', async () => {
  const res = await authedGet('/api/impact?subject=file');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/impact-api.test.ts`
Expected: FAIL — 404 on every case, the route does not exist

- [ ] **Step 3: Implement the route**

Map `ImpactResult`'s reasons to statuses: `not-found` → 404, `outside-root` → 400, `no-declared-writes` → 200 with an empty reach and the reason echoed (a task with nothing declared is a real answer, not an error). Wire `changedFilesForRun`, `writesForTask`, and `trackedFiles` from the daemon's existing accessors; reuse `DepMapCache.get` for `depMap`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/impact-api.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/impact.ts packages/server/test/impact-api.test.ts
git commit -m "feat(server): add GET /api/impact"
```

---

### Task 6: Client binding

**Files:**
- Modify: `packages/client/src/api.ts`
- Test: `packages/client/test/server-parity.test.ts` (existing — extend it)

**Interfaces:**
- Consumes: the route from Task 5
- Produces: `getImpact(subject: 'file' | 'run' | 'task', id: string): Promise<ImpactResponse>`

- [ ] **Step 1: Read the existing parity test**

`packages/client/test/server-parity.test.ts` exists to catch client/server drift. Read it and follow its pattern exactly — it is the reason a route rename cannot silently break the desktop app.

- [ ] **Step 2: Write the failing test**

Add a case asserting `getImpact` targets `/api/impact` with the subject and id as query parameters, matching however the existing tests assert URL shape.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/client && bun test`
Expected: FAIL — `getImpact` is not a function

- [ ] **Step 4: Implement the binding**

Follow the surrounding methods' conventions for auth headers and error handling. Every write declares a content type in this codebase; this is a read, so match the existing GET methods.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/client && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/client/src packages/client/test
git commit -m "feat(client): mirror GET /api/impact"
```

---

### Task 7: `ImpactPanel` — the compact surface

**Files:**
- Create: `apps/desktop/src/lib/impactSummary.ts`
- Create: `apps/desktop/src/lib/impactSummary.test.ts`
- Create: `apps/desktop/src/components/impact/ImpactPanel.tsx`

**Interfaces:**
- Consumes: `getImpact` from Task 6; `ReachResult` from the server types
- Produces: `summarizeImpact(reach: ReachResult, reviewCap: number): ImpactSummary` and `<ImpactPanel subject={...} id={...} />`

```ts
export interface ImpactSummary {
  total: number;
  direct: number; // hops === 1
  downstream: number; // hops > 1
  deepest: number;
  label: string; // e.g. "30 files · 5 hops" or "500+ files (capped)"
  sourceLabel: string; // e.g. "carto + scanner" or "scanner only (.ts/.tsx)"
  coverage: string | null; // e.g. "review scope covered 20 of 30"
}
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/impactSummary.test.ts
import { expect, test } from 'bun:test';
import { summarizeImpact } from './impactSummary.js';

const base = {
  entries: [
    { path: 'a.ts', hops: 1 },
    { path: 'b.ts', hops: 1 },
    { path: 'c.ts', hops: 3 },
  ],
  count: 3,
  maxHops: 3,
  sources: ['carto', 'scanner'] as ('carto' | 'scanner')[],
  degraded: false,
  truncated: false,
};

test('splits direct from downstream', () => {
  const s = summarizeImpact(base, 20);
  expect(s.direct).toBe(2);
  expect(s.downstream).toBe(1);
  expect(s.deepest).toBe(3);
});

test('a truncated result never reads as an exact count', () => {
  const s = summarizeImpact({ ...base, truncated: true }, 20);
  expect(s.label).toContain('+');
  expect(s.label).toContain('capped');
});

test('a scanner-only result states what it walks', () => {
  const s = summarizeImpact({ ...base, sources: ['scanner'] }, 20);
  expect(s.sourceLabel).toContain('.ts');
});

test('a degraded result is not presented as a plain scanner result', () => {
  const s = summarizeImpact({ ...base, sources: ['scanner'], degraded: true }, 20);
  expect(s.sourceLabel).toContain('unavailable');
});

test('coverage appears only when the review cap actually bit', () => {
  expect(summarizeImpact(base, 20).coverage).toBeNull();
  expect(summarizeImpact({ ...base, count: 30 }, 20).coverage).toContain(
    '20 of 30'
  );
});

test('an empty reach has no coverage line and reads as zero', () => {
  const s = summarizeImpact({ ...base, entries: [], count: 0, maxHops: 0 }, 20);
  expect(s.total).toBe(0);
  expect(s.coverage).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/lib/impactSummary.test.ts`
Expected: FAIL — cannot resolve `./impactSummary.js`

- [ ] **Step 3: Implement the summary**

Pure functions only — no React, no fetch. This is the file the tests cover; the component stays thin so its logic is testable without a DOM.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/lib/impactSummary.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Build the panel from existing primitives**

`ImpactPanel.tsx` composes: `chrome/Panel` for the shell, `ui/badge` for the source label and the capped marker, `ui/tooltip` for the scanner caveat, `ui/skeleton` while loading, and `chrome/CollapseBar` if the panel offers expansion. Use `chrome/EmptyState` for the zero case.

Do NOT hand-roll a primitive that exists. Do NOT use raw Tailwind palette hues — `scripts/check-chrome-utilities.ts` fails the build on them, and colour comes from tokens via `chrome/`. Compose the direct-vs-downstream bar from `chrome`; only run `bunx shadcn@latest add progress` if composition proves worse, and note the reason in your report.

- [ ] **Step 6: Verify the guard and the build**

Run from the repo root: `bun run lint && bun ws desktop tsc && bun test scripts/check-chrome-utilities.test.ts`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/impactSummary.ts apps/desktop/src/lib/impactSummary.test.ts apps/desktop/src/components/impact
git commit -m "feat(desktop): add the compact blast-radius panel"
```

---

### Task 8: `ImpactView` — the full surface, and its entry points

**Files:**
- Create: `apps/desktop/src/views/ImpactView.tsx`
- Create: `apps/desktop/src/lib/impactGroups.ts`
- Create: `apps/desktop/src/lib/impactGroups.test.ts`
- Modify: `apps/desktop/src/components/shell/Sidebar.tsx` (add the nav item)
- Modify: `apps/desktop/src/components/runs/ReviewCasePanel.tsx`, the task detail dialog, and the Git file pane (embed `ImpactPanel`)

**Interfaces:**
- Consumes: `summarizeImpact`, `ImpactPanel` from Task 7; `getImpact` from Task 6
- Produces: `groupByHop(entries: BlastEntry[]): HopGroup[]` where `interface HopGroup { hops: number; paths: string[] }`, and the `ImpactView` route

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/lib/impactGroups.test.ts
import { expect, test } from 'bun:test';
import { filterByPath, groupByHop } from './impactGroups.js';

const entries = [
  { path: 'src/a.ts', hops: 1 },
  { path: 'src/b.ts', hops: 1 },
  { path: 'test/c.ts', hops: 2 },
];

test('groups by hop distance, closest first', () => {
  expect(groupByHop(entries)).toEqual([
    { hops: 1, paths: ['src/a.ts', 'src/b.ts'] },
    { hops: 2, paths: ['test/c.ts'] },
  ]);
});

test('an empty list groups to nothing', () => {
  expect(groupByHop([])).toEqual([]);
});

test('the filter matches on any part of the path, case-insensitively', () => {
  expect(filterByPath(entries, 'SRC/')).toHaveLength(2);
  expect(filterByPath(entries, 'c.ts')).toHaveLength(1);
});

test('an empty filter returns everything rather than nothing', () => {
  expect(filterByPath(entries, '')).toHaveLength(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/lib/impactGroups.test.ts`
Expected: FAIL — cannot resolve `./impactGroups.js`

- [ ] **Step 3: Implement grouping and filtering**

Pure functions, no React.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/lib/impactGroups.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Build the view**

`ImpactView.tsx` composes `chrome/ViewHeader`, `ui/select` for the subject picker, `ui/input` for the path filter, `chrome/CollapseBar` per hop group, `chrome/PathCrumb` for each path, and `chrome/EmptyState` for the zero case. It renders the same `ReachResult` `ImpactPanel` does — do not add a second fetch shape.

Add the nav item to `Sidebar.tsx` following the existing items' pattern exactly.

- [ ] **Step 6: Wire the three entry points**

Embed `ImpactPanel` in the Review case panel, the task detail dialog, and the Git file pane, each passing its own subject. Each panel offers "open in Impact", which navigates to the view with that subject preselected.

- [ ] **Step 7: Full verification**

Run from the repo root:

```bash
bun run format && bun run lint && bun run tsc && bun run test
```

Expected: clean. Note that two timing tests (`sync/scheduler`, the watcher) are known to fail only under full-suite load — re-run those alone before blaming this change.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): add the Impact view and its entry points"
```

---

## Self-Review Notes

Checked against the spec:

- Preserving hop distance, `ReviewRunner` unaffected → Task 1
- `reach()` with cycles, diamonds, caps, ordering → Task 2
- Carto/scanner union by shortest, `sources`, degradation → Task 3
- Three subjects, glob reuse, no prose guessing → Task 4
- Route, error mapping (404/400, not 500) → Task 5
- Client binding with parity coverage → Task 6
- `ImpactPanel`, honesty labels, review-scope coverage → Task 7
- `ImpactView`, hop grouping, filter, three entry points → Task 8
- shadcn primitives and the chrome guard → Tasks 7 and 8

Two items deliberately deferred into their tasks rather than pinned here,
because both require reading current source and a wrong guess produces a
subtly incorrect result: the declared-writes glob matcher to reuse (Task 4,
Step 3) and the daemon accessors for run changed-files and tracked files
(Task 5, Step 3). Both steps name what to search for.

One risk worth stating: Task 3's union is the only place two graphs with
different semantics are reconciled. Its three tests cover shorter-wins,
carto-only survival, and degradation — but a real carto container is exercised
only by the existing `carto-integration.test.ts`, which is skipped when no
binary is present. `preflight` reports carto is not currently installed, so
that path will not run locally until it is.
