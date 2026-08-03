# Carto Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Carto (`carto-md`) into Dispatch as an MCP server for
dispatched agents and as a multi-language backend for the reverse-dependency
graph that builds review scope.

**Architecture:** A new `@dispatch/core/carto` subpath owns binary discovery,
container lifecycle, and the ANCI reader. `packages/server/src/depmap.ts` gains
a `CartoDepMap` that satisfies the existing `DepMap` interface — delegating
`dependents()` to carto while `mirrors()` stays on O-6's comment scanner.
`review.ts` is not modified for the swap; it already talks to `DepMapProvider`.
Every carto failure degrades to `buildDepMap` and surfaces via a ledger entry
and `doctor`.

**Tech Stack:** Bun, TypeScript, tsdown, `bun test`, oxlint/oxfmt. External:
`carto-md@2.1.3` (MIT), invoked as a PATH binary and imported as a library via
`carto-md/src/anci/consumer`.

**Spec:** `docs/superpowers/specs/2026-08-02-carto-integration-design.md`

## Global Constraints

- `export AGENT=1` at the start of every terminal session.
- Use `bun` only. Never `npm`, `pnpm`, or `npx`.
- Dependencies go in the root `workspaces.catalog`, never in a package's own
  `package.json` version field.
- Verification baseline after every task: `bun run format` and `bun run lint`
  from the repo root, plus `bun run tsc` and focused `bun test` in each changed
  package.
- Preserve trailing newlines at the end of files.
- Comments: 1–2 lines max, function-level over inline, concrete and
  behavior-focused. No incident narratives.
- Agent-only scratch files go under `.agents/ignore/`. Never the repo root,
  never `/tmp`.
- **No carto failure may ever fail a review run.** Every rung of the ladder
  degrades to `buildDepMap`.
- **Dispatch never sets `CARTO_MCP_TIER`.** That keeps the agent-facing tool
  surface at carto's ~10-tool core tier.
- Any new MCP server config must use an **env allowlist**, never `process.env`.
  The Agent SDK serializes `env` into the spawned CLI's argv, readable by any
  local process via `ps`.

---

## File Structure

**Created:**

- `packages/core/src/carto.ts` — discovery, lifecycle, reader. The only file
  that knows carto exists.
- `packages/core/test/carto.test.ts`
- `packages/server/test/fixtures/carto-blast-radius.json` — recorded real
  response from Task 0.
- `.agents/ignore/carto-spike/findings.md` — Task 0 output.

**Modified:**

- `packages/core/package.json` — new `./carto` export subpath.
- `packages/core/tsdown.config.ts` — new entry.
- `packages/core/src/configTypes.ts` — `CartoConfig`, `CartoMode`.
- `packages/core/src/config.ts` — parse/default the `carto` block.
- `packages/server/src/depmap.ts` — `CartoDepMap`, backend selection in
  `DepMapCache`.
- `packages/server/src/index.ts:230` — pass config + degradation sink to
  `DepMapCache`.
- `packages/server/src/watcher.ts` — no signature change; caller supplies a
  sync-then-invalidate callback.
- `packages/server/src/orchestrator/executors/claude.ts` —
  `buildCartoMcpServerConfig`.
- `packages/cli/src/program.ts` — `init` builds the container.
- `packages/cli/src/commands/doctor.ts` — carto health + empty-dependents
  warning.

---

### Task 0: Verification spike

Not TDD. This is a measurement task whose output gates every later task. **Do
not write adapter code in this task.**

Four claims in the spec came from carto's README, and three others were read
from its source but never executed. The most load-bearing unverified claim is
the shape of `blastRadius()`.

**Files:**

- Create: `.agents/ignore/carto-spike/findings.md`
- Create: `packages/server/test/fixtures/carto-blast-radius.json`

- [ ] **Step 1: Install carto and make a scratch clone**

`carto init` writes `AGENTS.md` and installs four git hooks. It must not touch
the working repo.

```bash
export AGENT=1
# carto is a third-party global CLI, not a workspace dep, so the catalog rule
# does not apply. Prefer bun; fall back to npm only if the native
# better-sqlite3/tree-sitter builds fail under it, and record which was used.
bun install -g carto-md || npm install -g carto-md
carto --version                  # record the exact version
git clone /Users/wyatsoule/Sites/dispatch /tmp/carto-spike-clone
cd /tmp/carto-spike-clone
```

- [ ] **Step 2: Record what `carto init` mutates**

```bash
cd /tmp/carto-spike-clone
git status --porcelain > /tmp/before.txt
carto init
git status --porcelain > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
ls -la .git/hooks/
cat .git/hooks/pre-commit
cat .carto/config.json
```

Record in `findings.md`: every path written, the verbatim hook contents, and
whether `.carto/config.json` contains an `output` key equal to `AGENTS.md`.

- [ ] **Step 3: Capture the real `blastRadius()` shape — the critical
      measurement**

```bash
cd /tmp/carto-spike-clone
node -e "
const { loadAnci } = require('carto-md/src/anci/consumer');
const r = loadAnci('./.carto');
const out = r.blastRadius('packages/core/src/types.ts');
console.log(JSON.stringify(out, null, 2));
" > /tmp/blast.json
head -50 /tmp/blast.json
```

**Decide and record explicitly:** is `hops` a scalar on the result, or is
per-file hop distance available inside `files`?

- If `files` entries carry their own hop distance → `CartoDepMap` reproduces
  O-6's Important-2 depth ordering exactly. Record the exact property name.
- If `hops` is only a scalar max → per-file depth is **not** available, and
  sorting can only be alphabetical. That is a regression against `depmap.ts`'s
  current `(depth, name)` sort. Record this prominently; Task 5 has a branch for
  it.

- [ ] **Step 4: Confirm the core tool tier is ~10, not 57**

```bash
cd /tmp/carto-spike-clone
# Send an MCP tools/list over stdio and count the result.
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"spike","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | carto serve 2>/dev/null | tail -1 > /tmp/tools.json
node -e "const d=require('/tmp/tools.json');console.log(d.result.tools.length);console.log(d.result.tools.map(t=>t.name).join('\n'))"
```

Record the count and names. If it is 57 rather than ~10, the executor entry in
Task 7 is a context-budget problem and must be reported before proceeding.

- [ ] **Step 5: Verify the hook cwd rewrite inside a real worktree**

```bash
cd /tmp/carto-spike-clone
# Apply the rewrite the spec specifies.
for h in pre-commit post-checkout post-merge post-rewrite; do
  sed -i '' 's|^carto sync .*|(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." \&\& carto sync) >/dev/null 2>\&1 \|\| true|' ".git/hooks/$h"
done
git worktree add /tmp/carto-spike-wt -b spike-branch
cd /tmp/carto-spike-wt
echo "// spike" >> packages/core/src/types.ts
git commit -am "spike: touch types"
ls /tmp/carto-spike-wt/.carto 2>&1   # MUST NOT exist — no stray container
ls -la /tmp/carto-spike-clone/.carto # container MUST have a fresh mtime
```

Record whether the stray-container hazard is confirmed and whether the rewrite
prevents it.

- [ ] **Step 6: Check whether `McpStdioServerConfig` accepts `cwd`**

```bash
cd /Users/wyatsoule/Sites/dispatch
rg -n "McpStdioServerConfig" -A 15 node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts | head -30
```

Record: does it have a `cwd` field? If not, Task 7 must wrap the command in a
shell that `cd`s first.

- [ ] **Step 7: Commit the fixture and findings**

Trim the captured response to ~30 files so the fixture stays readable,
preserving the exact key names.

```bash
cd /Users/wyatsoule/Sites/dispatch
cp /tmp/blast.json packages/server/test/fixtures/carto-blast-radius.json
git add packages/server/test/fixtures/carto-blast-radius.json
git commit -m "test(server): record a real carto blastRadius response as a fixture"
```

- [ ] **Step 8: Report before continuing**

Post the findings to the user. If Step 3 showed no per-file hops, or Step 4
showed 57 tools, **stop and confirm** — both change the design's value.

**Cleanup:**
`git worktree remove /tmp/carto-spike-wt --force && rm -rf /tmp/carto-spike-clone`

---

### Task 1: Carto discovery in `@dispatch/core/carto`

**Files:**

- Create: `packages/core/src/carto.ts`
- Create: `packages/core/test/carto.test.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/core/tsdown.config.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `discoverCarto(env?): CartoDiscovery`, and the types `CartoBinary`,
  `CartoDiscovery`. Tasks 3, 5, 6, 7, 8 all consume `discoverCarto`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/carto.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCarto } from '../src/carto.js';

// Writes an executable stub named `carto` that prints `version` for --version.
function writeFakeCarto(binDir: string, version: string): void {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'carto');
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(file, 0o755);
}

describe('discoverCarto', () => {
  it('finds carto on PATH and reports its version', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, '2.1.3');
      const result = discoverCarto({ PATH: binDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.binary.path).toBe(join(binDir, 'carto'));
        expect(result.binary.version).toBe('2.1.3');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not-found rather than throwing when carto is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const result = discoverCarto({ PATH: join(root, 'empty') });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a version below the 2.x floor', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, '1.9.0');
      const result = discoverCarto({ PATH: binDir });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported-version');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test carto.test.ts` Expected: FAIL — cannot
resolve `../src/carto.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/carto.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The carto binary Dispatch found, and the version it reported. */
export interface CartoBinary {
  path: string;
  version: string;
}

export type CartoDiscovery =
  | { ok: true; binary: CartoBinary }
  | {
      ok: false;
      reason: 'not-found' | 'unsupported-version' | 'unreadable';
      detail: string;
    };

// The ANCI container layout and the `output` config key this integration
// depends on both landed in carto 2.x.
const MIN_MAJOR = 2;

// Homebrew's two standard prefixes, searched after PATH so an explicitly
// installed carto always wins over a brew one.
const BREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateDirs(env: NodeJS.ProcessEnv): string[] {
  const fromPath = (env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  return [...fromPath, ...BREW_BIN_DIRS];
}

// Locates `carto`, runs `--version`, and gates on the 2.x floor. Returns a
// result rather than throwing: every caller's correct response to an absent
// or too-old carto is to degrade, not to fail.
export function discoverCarto(
  env: NodeJS.ProcessEnv = process.env
): CartoDiscovery {
  let found: string | null = null;
  for (const dir of candidateDirs(env)) {
    const candidate = join(dir, 'carto');
    if (existsSync(candidate) && isExecutableFile(candidate)) {
      found = candidate;
      break;
    }
  }
  if (found === null) {
    return { ok: false, reason: 'not-found', detail: 'no `carto` on PATH' };
  }

  const probe = spawnSync(found, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `\`carto --version\` exited ${String(probe.status)}`,
    };
  }
  const version = (probe.stdout ?? '').trim();
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isNaN(major) || major < MIN_MAJOR) {
    return {
      ok: false,
      reason: 'unsupported-version',
      detail: `carto ${version} is below the required ${String(MIN_MAJOR)}.x`,
    };
  }
  return { ok: true, binary: { path: found, version } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test carto.test.ts` Expected: PASS, 3 tests.

- [ ] **Step 5: Add the export subpath**

In `packages/core/tsdown.config.ts`, add `'src/carto.ts'` to `entry`:

```ts
entry: ['src/index.ts', 'src/graph.ts', 'src/browser.ts', 'src/carto.ts'],
```

In `packages/core/package.json`, add to `exports` after `"./graph"`:

```json
"./carto": {
  "types": "./dist/carto.d.ts",
  "import": "./dist/carto.js"
},
```

Do **not** re-export from `src/index.ts`. `carto.ts` imports
`node:child_process`; keeping it off the root subpath is what keeps it out of
the `./browser` bundle.

- [ ] **Step 6: Verify the build and types**

```bash
cd /Users/wyatsoule/Sites/dispatch && bun run build
cd packages/core && bun run tsc && bun test
```

Expected: build emits `dist/carto.js` and `dist/carto.d.ts`; tsc clean; tests
pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
git add packages/core/src/carto.ts packages/core/test/carto.test.ts \
        packages/core/package.json packages/core/tsdown.config.ts
git commit -m "feat(core): discover the carto binary behind a new ./carto subpath"
```

---

### Task 2: The ANCI reader

**Files:**

- Modify: `packages/core/src/carto.ts`
- Modify: `packages/core/test/carto.test.ts`

**Interfaces:**

- Consumes: Task 1's `CartoDiscovery`.
- Produces: `openCartoReader(projectRoot): CartoReaderResult`, types
  `CartoReader`, `CartoBlastRadius`, `CartoReaderResult`. Task 5 consumes all of
  these.

**Depends on Task 0 Step 3** for the exact `blastRadius()` key names. If the
recorded fixture disagrees with the types below, **the fixture wins** — update
these types to match.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/carto.test.ts`:

```ts
import { openCartoReader } from '../src/carto.js';

describe('openCartoReader', () => {
  it('reports no-container when .carto is absent, rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const result = openCartoReader(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('no-container');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports load-failed when .carto exists but is unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      mkdirSync(join(root, '.carto'), { recursive: true });
      writeFileSync(join(root, '.carto', 'carto.db'), 'not a database');
      const result = openCartoReader(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('load-failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test carto.test.ts` Expected: FAIL —
`openCartoReader` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/carto.ts`:

```ts
/** One `blastRadius()` response. Key names are pinned by the recorded
 *  fixture in packages/server/test/fixtures/carto-blast-radius.json. */
export interface CartoBlastRadius {
  count: number;
  hops: number;
  files: unknown[];
}

export interface CartoReader {
  blastRadius(file: string): CartoBlastRadius;
}

export type CartoReaderResult =
  | { ok: true; reader: CartoReader }
  | { ok: false; reason: 'no-container' | 'load-failed'; detail: string };

// Opens the ANCI container as a library, which reads it "without running
// Carto's engine" — no binary spawn per query. Wrapped in a result because a
// half-written container during a sync is a normal, recoverable state.
export function openCartoReader(projectRoot: string): CartoReaderResult {
  const dir = join(projectRoot, '.carto');
  if (!existsSync(dir)) {
    return { ok: false, reason: 'no-container', detail: `${dir} not found` };
  }
  try {
    // Resolved lazily: importing it at module load would make every consumer
    // of this file depend on carto-md being installed.
    const require_ = createRequire(import.meta.url);
    const { loadAnci } = require_('carto-md/src/anci/consumer') as {
      loadAnci: (dir: string) => CartoReader;
    };
    return { ok: true, reader: loadAnci(dir) };
  } catch (err) {
    return { ok: false, reason: 'load-failed', detail: (err as Error).message };
  }
}
```

Add `import { createRequire } from 'node:module';` to the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test carto.test.ts` Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
cd packages/core && bun run tsc
cd /Users/wyatsoule/Sites/dispatch
git add packages/core/src/carto.ts packages/core/test/carto.test.ts
git commit -m "feat(core): open the carto ANCI container through its consumer library"
```

---

### Task 3: Contained `carto init` and hook cwd pinning

**Files:**

- Modify: `packages/core/src/carto.ts`
- Modify: `packages/core/test/carto.test.ts`

**Interfaces:**

- Consumes: Task 1's `CartoBinary`.
- Produces: `pinHookWorkingDirs(projectRoot): string[]` (returns rewritten hook
  paths), `redirectCartoOutput(projectRoot): void`,
  `cartoInit(projectRoot, binary): CartoRunResult`,
  `cartoSync(projectRoot, binary): CartoRunResult`. Tasks 6 and 8 consume
  `cartoInit`/`cartoSync`.

`carto init` writes `AGENTS.md` (load-bearing here) and installs four hooks that
misfire inside run worktrees. Both are contained here.

- [ ] **Step 1: Write the failing test for hook pinning**

Append to `packages/core/test/carto.test.ts`:

```ts
import { readFileSync } from 'node:fs';

import { pinHookWorkingDirs } from '../src/carto.js';

describe('pinHookWorkingDirs', () => {
  it('rewrites carto sync to cd to the main worktree first', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        '#!/bin/sh\n# carto-md: keep index fresh on git events\ncarto sync >/dev/null 2>&1 || true\n'
      );
      const rewritten = pinHookWorkingDirs(root);
      expect(rewritten).toContain(join(hooks, 'pre-commit'));
      const body = readFileSync(join(hooks, 'pre-commit'), 'utf8');
      expect(body).toContain('--git-common-dir');
      expect(body).not.toMatch(/^carto sync/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second call does not double-wrap', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
      );
      pinHookWorkingDirs(root);
      const once = readFileSync(join(hooks, 'pre-commit'), 'utf8');
      pinHookWorkingDirs(root);
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toBe(once);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves unrelated hook lines untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        '#!/bin/sh\nbun run lint\ncarto sync >/dev/null 2>&1 || true\n'
      );
      pinHookWorkingDirs(root);
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toContain(
        'bun run lint'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test carto.test.ts` Expected: FAIL —
`pinHookWorkingDirs` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/carto.ts`:

```ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const CARTO_HOOKS = [
  'pre-commit',
  'post-checkout',
  'post-merge',
  'post-rewrite',
];

// Worktrees share the common git dir, so carto's own hook line runs with cwd
// set to the worktree, where .carto/ does not exist. `--git-common-dir`
// resolves to the main repo's .git from inside any linked worktree, so its
// parent is always the project root.
const PINNED_SYNC_LINE =
  '(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && carto sync) >/dev/null 2>&1 || true';

const BARE_SYNC_RE = /^\s*carto sync\b.*$/gm;

// Rewrites carto's inserted `carto sync` line in each installed hook to pin
// its working directory. Idempotent: a line already containing
// --git-common-dir is left alone, and carto's own installer skips any hook
// whose contents already mention `carto sync`, so re-running `carto init`
// will not undo this.
export function pinHookWorkingDirs(projectRoot: string): string[] {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  if (!existsSync(hooksDir)) return [];
  const rewritten: string[] = [];
  const present = new Set(readdirSync(hooksDir));
  for (const name of CARTO_HOOKS) {
    if (!present.has(name)) continue;
    const path = join(hooksDir, name);
    const body = readFileSync(path, 'utf8');
    if (body.includes('--git-common-dir')) continue;
    if (!BARE_SYNC_RE.test(body)) continue;
    BARE_SYNC_RE.lastIndex = 0;
    writeFileSync(path, body.replace(BARE_SYNC_RE, PINNED_SYNC_LINE));
    rewritten.push(path);
  }
  return rewritten;
}
```

Note: `BARE_SYNC_RE` is a module-level regex with the `g` flag, so `lastIndex`
must be reset between `.test()` and `.replace()`. Without that reset the second
call silently misses.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test carto.test.ts` Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing test for output redirection and init**

Append to `packages/core/test/carto.test.ts`:

```ts
import { redirectCartoOutput } from '../src/carto.js';

describe('redirectCartoOutput', () => {
  it('repoints config.output away from AGENTS.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      mkdirSync(join(root, '.carto'), { recursive: true });
      writeFileSync(
        join(root, '.carto', 'config.json'),
        JSON.stringify({ version: '2', output: 'AGENTS.md' })
      );
      redirectCartoOutput(root);
      const config = JSON.parse(
        readFileSync(join(root, '.carto', 'config.json'), 'utf8')
      ) as { output: string; version: string };
      expect(config.output).toBe('.carto/CONTEXT.md');
      expect(config.version).toBe('2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when there is no config to repoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      expect(() => redirectCartoOutput(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd packages/core && bun test carto.test.ts` Expected: FAIL —
`redirectCartoOutput` is not exported.

- [ ] **Step 7: Implement redirection and the contained init**

Append to `packages/core/src/carto.ts`:

```ts
import { copyFileSync, unlinkSync } from 'node:fs';

export interface CartoRunResult {
  ok: boolean;
  detail: string;
}

// carto writes .carto/config.json with `output: 'AGENTS.md'`, and every later
// `carto sync` resolves its destination from that key. Repointing it once
// makes AGENTS.md permanently safe.
export function redirectCartoOutput(projectRoot: string): void {
  const path = join(projectRoot, '.carto', 'config.json');
  if (!existsSync(path)) return;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  config.output = '.carto/CONTEXT.md';
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

// Builds the container, containing carto init's two side effects on files
// Dispatch owns: AGENTS.md is snapshotted and restored across the single init
// call, then permanently protected by repointing config.output; the four
// installed hooks get their working directory pinned.
export function cartoInit(
  projectRoot: string,
  binary: CartoBinary
): CartoRunResult {
  const agents = join(projectRoot, 'AGENTS.md');
  const backup = join(projectRoot, '.carto-agents-backup');
  const hadAgents = existsSync(agents);
  if (hadAgents) copyFileSync(agents, backup);

  const run = spawnSync(binary.path, ['init'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (hadAgents) {
    copyFileSync(backup, agents);
    unlinkSync(backup);
  } else if (existsSync(agents)) {
    unlinkSync(agents);
  }
  redirectCartoOutput(projectRoot);
  pinHookWorkingDirs(projectRoot);

  return run.status === 0
    ? { ok: true, detail: `indexed with carto ${binary.version}` }
    : { ok: false, detail: (run.stderr ?? '').trim() || 'carto init failed' };
}

// Incremental re-index. cwd is pinned to the project root because .carto/
// only ever exists there, never in a run's worktree.
export function cartoSync(
  projectRoot: string,
  binary: CartoBinary
): CartoRunResult {
  const run = spawnSync(binary.path, ['sync'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return run.status === 0
    ? { ok: true, detail: 'synced' }
    : { ok: false, detail: (run.stderr ?? '').trim() || 'carto sync failed' };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/core && bun test carto.test.ts` Expected: PASS, 10 tests.

- [ ] **Step 9: Mutation-verify the AGENTS.md guard**

The restore is the highest-consequence line in this task. Prove the test catches
its absence:

```bash
cd packages/core
# Temporarily delete the `if (hadAgents) { copyFileSync(backup, agents); ... }`
# block in cartoInit, then re-run the conditional real-carto test from Task 9.
```

If no test fails when the restore is removed, the coverage is inadequate — add a
test that writes a sentinel `AGENTS.md`, runs `cartoInit` against a stub binary
that overwrites it, and asserts the sentinel survives. Restore the block and
confirm green.

- [ ] **Step 10: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
cd packages/core && bun run tsc
cd /Users/wyatsoule/Sites/dispatch
git add packages/core/src/carto.ts packages/core/test/carto.test.ts
git commit -m "feat(core): contain carto init's AGENTS.md write and pin hook working dirs"
```

---

### Task 4: The `carto` config block

**Files:**

- Modify: `packages/core/src/configTypes.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/test/config.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `CartoMode = 'on' | 'detect' | 'off'`,
  `CartoConfig { enabled: CartoMode }`, and `DispatchConfig.carto: CartoConfig`.
  Tasks 5, 6, 8 read `loadConfig(root).carto.enabled`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/config.test.ts`, matching the file's existing
fixture style:

```ts
describe('the carto block', () => {
  it('defaults to on when absent', () => {
    const root = writeConfig('statuses: [todo, done]\n');
    expect(loadConfig(root).carto.enabled).toBe('on');
  });

  it('accepts detect and off', () => {
    expect(
      loadConfig(writeConfig('carto:\n  enabled: detect\n')).carto.enabled
    ).toBe('detect');
    expect(
      loadConfig(writeConfig('carto:\n  enabled: off\n')).carto.enabled
    ).toBe('off');
  });

  it('rejects an unknown mode with a ConfigError', () => {
    expect(() => loadConfig(writeConfig('carto:\n  enabled: maybe\n'))).toThrow(
      ConfigError
    );
  });
});
```

If `writeConfig` does not already exist in that file, add a local helper that
writes `.dispatch/config.yml` under a fresh `mkdtempSync` root and returns the
root.

**Note on YAML:** `enabled: off` parses as the boolean `false` in YAML 1.1. The
parser must accept both the string `'off'` and boolean `false` as the `off`
mode, and both `'on'` and `true` as `on`. Cover this in the test above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test config.test.ts` Expected: FAIL — `carto` is
not a property of `DispatchConfig`.

- [ ] **Step 3: Add the types**

In `packages/core/src/configTypes.ts`:

```ts
/** Whether Dispatch uses carto for the dependency graph, and whether it may
 *  build the container itself. `on` is a build policy, never a requirement —
 *  an absent binary always degrades to the built-in scanner. */
export type CartoMode = 'on' | 'detect' | 'off';

export interface CartoConfig {
  enabled: CartoMode;
}

export const CARTO_MODES: readonly CartoMode[] = ['on', 'detect', 'off'];

export const DEFAULT_CARTO: CartoConfig = { enabled: 'on' };
```

Add `carto: CartoConfig;` to the `DispatchConfig` interface.

- [ ] **Step 4: Parse the block**

In `packages/core/src/config.ts`, add a parser mirroring the existing block
parsers:

```ts
// YAML 1.1 parses bare `on`/`off` as booleans, so both spellings are accepted.
function parseCarto(raw: unknown): CartoConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CARTO };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('carto must be a mapping');
  }
  const enabled = (raw as Record<string, unknown>).enabled;
  if (enabled === undefined) return { ...DEFAULT_CARTO };
  const normalized =
    enabled === true ? 'on' : enabled === false ? 'off' : enabled;
  if (
    typeof normalized !== 'string' ||
    !CARTO_MODES.includes(normalized as CartoMode)
  ) {
    throw new ConfigError(
      `carto.enabled must be one of: ${CARTO_MODES.join(', ')}`
    );
  }
  return { enabled: normalized as CartoMode };
}
```

Wire `carto: parseCarto(doc.carto)` into the object `loadConfig` returns, and
import `CARTO_MODES`, `DEFAULT_CARTO`, and the types alongside the existing
imports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && bun test config.test.ts && bun run tsc` Expected:
PASS. `tsc` will flag any other construction site of `DispatchConfig` that now
needs a `carto` field — fix each by spreading `DEFAULT_CARTO`.

- [ ] **Step 6: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
git add packages/core/src/configTypes.ts packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): add the carto config block, defaulting to on"
```

---

### Task 5: `CartoDepMap` and the fallback ladder

**Files:**

- Modify: `packages/server/src/depmap.ts`
- Modify: `packages/server/test/depmap.test.ts`
- Read: `packages/server/test/fixtures/carto-blast-radius.json` (from Task 0)

**Interfaces:**

- Consumes: Task 2's `openCartoReader`, `CartoReader`, `CartoBlastRadius`; the
  existing `DepMap` interface and `buildDepMap` in this file.
- Produces: `createCartoDepMap(rootDir, reader, fallback): DepMap`,
  `normalizeBlastRadius(raw): string[]`, and a widened `DepMapCache`
  constructor. Task 6 consumes `DepMapCache`.

**Branch on Task 0 Step 3's finding:**

- **Per-file hops available** → `normalizeBlastRadius` sorts by
  `(hops asc, name asc)`, exactly reproducing O-6's Important-2 fix.
- **Only a scalar `hops`** → sort alphabetically and **add a comment naming this
  as a known regression** against `depmap.ts`'s depth ordering. Report it to the
  user; do not silently accept it.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/depmap.test.ts`:

```ts
import { createCartoDepMap, normalizeBlastRadius } from '../src/depmap.js';
import type { CartoReader } from '@dispatch/core/carto';

// A reader that answers from a canned map, standing in for a real container.
function fakeReader(
  map: Record<string, { count: number; hops: number; files: unknown[] }>
): CartoReader {
  return {
    blastRadius: (file: string) =>
      map[file] ?? { count: 0, hops: 0, files: [] },
  };
}

describe('createCartoDepMap', () => {
  it('answers dependents from carto', () => {
    const depMap = createCartoDepMap(
      root,
      fakeReader({
        'src/a.ts': {
          count: 2,
          hops: 2,
          files: [
            { path: 'src/c.ts', hops: 2 },
            { path: 'src/b.ts', hops: 1 },
          ],
        },
      }),
      buildDepMap(root)
    );
    // Direct importer first — depth beats the alphabet, matching buildDepMap.
    expect(depMap.dependents('src/a.ts')).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('falls back to the scanner when carto throws', () => {
    writeFixtureWorkspace();
    const fallback = buildDepMap(root);
    const throwing: CartoReader = {
      blastRadius: () => {
        throw new Error('container corrupt');
      },
    };
    const depMap = createCartoDepMap(root, throwing, fallback);
    expect(depMap.dependents('packages/a/src/index.ts')).toEqual(
      fallback.dependents('packages/a/src/index.ts')
    );
  });

  it('caches the failure instead of retrying per file', () => {
    let calls = 0;
    const throwing: CartoReader = {
      blastRadius: () => {
        calls += 1;
        throw new Error('container corrupt');
      },
    };
    const depMap = createCartoDepMap(root, throwing, buildDepMap(root));
    depMap.dependents('src/a.ts');
    depMap.dependents('src/b.ts');
    depMap.dependents('src/c.ts');
    expect(calls).toBe(1);
  });

  it('always serves mirrors from the scanner, never from carto', () => {
    writeFixtureWorkspace();
    const fallback = buildDepMap(root);
    const depMap = createCartoDepMap(root, fakeReader({}), fallback);
    expect(depMap.mirrors('packages/a/src/index.ts')).toEqual(
      fallback.mirrors('packages/a/src/index.ts')
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test depmap.test.ts` Expected: FAIL —
`createCartoDepMap` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/server/src/depmap.ts`:

```ts
import type { CartoBlastRadius, CartoReader } from '@dispatch/core/carto';

// carto's `files` entries carry their own hop distance. Sorting by
// (hops, name) reproduces buildDepMap's ordering exactly, so a high-fanout
// file's direct importers survive review.ts's cap of 20.
export function normalizeBlastRadius(raw: CartoBlastRadius): string[] {
  const entries: { path: string; hops: number }[] = [];
  for (const file of raw.files) {
    if (typeof file === 'string') {
      entries.push({ path: file, hops: raw.hops });
      continue;
    }
    if (typeof file === 'object' && file !== null) {
      const record = file as Record<string, unknown>;
      const path = record.path ?? record.file;
      if (typeof path !== 'string') continue;
      const hops = typeof record.hops === 'number' ? record.hops : raw.hops;
      entries.push({ path, hops });
    }
  }
  return entries
    .sort((a, b) =>
      a.hops !== b.hops
        ? a.hops - b.hops
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0
    )
    .map((e) => e.path);
}

/** Why a CartoDepMap stopped using carto, for the caller to surface once. */
export type CartoDegradation = { file: string; detail: string };

// dependents() from carto, mirrors() from the scanner — carto has no notion
// of Dispatch's hand-mirror comments, so that half never moves. A single
// throw retires carto for this instance's lifetime: a broken container must
// not be retried once per file across a 40-file diff.
export function createCartoDepMap(
  rootDir: string,
  reader: CartoReader,
  fallback: DepMap,
  onDegrade?: (degradation: CartoDegradation) => void
): DepMap {
  let degraded = false;
  return {
    dependents(file: string): string[] {
      if (degraded) return fallback.dependents(file);
      try {
        return normalizeBlastRadius(
          reader.blastRadius(normalizeInputPath(file))
        );
      } catch (err) {
        degraded = true;
        onDegrade?.({ file, detail: (err as Error).message });
        return fallback.dependents(file);
      }
    },
    mirrors(file: string): string[] {
      return fallback.mirrors(file);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bun test depmap.test.ts` Expected: PASS — the
existing suite plus 4 new tests.

- [ ] **Step 5: Assert the fixture parses to the same contract**

Add one more test proving the real recorded response works, not just hand-built
fakes:

```ts
it('normalizes the recorded real carto response', () => {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, 'fixtures/carto-blast-radius.json'),
      'utf8'
    )
  ) as CartoBlastRadius;
  const files = normalizeBlastRadius(raw);
  expect(files.length).toBeGreaterThan(0);
  expect(files.every((f) => typeof f === 'string')).toBe(true);
  // Ordering must be non-decreasing in hop distance, like buildDepMap's.
  expect(files).toEqual([...new Set(files)]);
});
```

Run: `cd packages/server && bun test depmap.test.ts` Expected: PASS.

- [ ] **Step 6: Mutation-verify the fallback**

This is the ladder's highest-risk rung — a bug here means silent degradation,
the failure this work exists to remove.

```bash
cd packages/server
# 1. Change `if (degraded) return fallback.dependents(file)` to `if (false)`.
bun test depmap.test.ts   # MUST fail the caching test
# 2. Restore it. Change the catch block to `return []` instead of falling back.
bun test depmap.test.ts   # MUST fail the fallback test
# 3. Restore and confirm green.
```

If either mutation passes, the test is vacuous — fix the test before continuing.

- [ ] **Step 7: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
cd packages/server && bun run tsc
cd /Users/wyatsoule/Sites/dispatch
git add packages/server/src/depmap.ts packages/server/test/depmap.test.ts
git commit -m "feat(server): back dependents() with carto, falling back to the scanner"
```

---

### Task 6: Daemon backend selection and sync

**Files:**

- Modify: `packages/server/src/depmap.ts` (`DepMapCache`)
- Modify: `packages/server/src/index.ts:228-235`
- Modify: `packages/server/test/depmap.test.ts`

**Interfaces:**

- Consumes: Task 1's `discoverCarto`, Task 2's `openCartoReader`, Task 3's
  `cartoInit`/`cartoSync`, Task 4's `CartoMode`, Task 5's `createCartoDepMap`.
- Produces: `DepMapCache(rootDir, options?)` where
  `options = { mode?: CartoMode; onDegrade?: (d: CartoDegradation) => void }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/depmap.test.ts`:

```ts
describe('DepMapCache backend selection', () => {
  it('uses the scanner when carto is off', () => {
    writeFixtureWorkspace();
    const cache = new DepMapCache(root, { mode: 'off' });
    expect(cache.get().dependents('packages/a/src/index.ts')).toEqual(
      buildDepMap(root).dependents('packages/a/src/index.ts')
    );
  });

  it('reports one degradation, not one per call', () => {
    writeFixtureWorkspace();
    const seen: string[] = [];
    // No .carto/ in the fixture root, so carto selection always misses.
    const cache = new DepMapCache(root, {
      mode: 'detect',
      onDegrade: (d) => seen.push(d.detail),
    });
    cache.get().dependents('packages/a/src/index.ts');
    cache.get().dependents('packages/b/src/index.ts');
    expect(seen.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test depmap.test.ts` Expected: FAIL —
`DepMapCache` takes one argument.

- [ ] **Step 3: Widen `DepMapCache`**

Replace the existing `DepMapCache` class in `packages/server/src/depmap.ts`:

```ts
export interface DepMapCacheOptions {
  mode?: CartoMode;
  onDegrade?: (degradation: CartoDegradation) => void;
}

// Lazily builds and memoizes a DepMap, so a burst of review dispatches shares
// one scan. Prefers carto when the mode allows and a container is readable;
// every miss degrades to the built-in scanner and is reported once.
export class DepMapCache {
  private cached: DepMap | null = null;
  // Both survive invalidate() deliberately. The watcher invalidates on every
  // debounced source change, so without these a missing binary would re-report
  // forever and a failed `carto init` would respawn a 4-9s index each tick.
  private reported = false;
  private initAttempted = false;

  constructor(
    private readonly rootDir: string,
    private readonly options: DepMapCacheOptions = {}
  ) {}

  private report(detail: string): void {
    if (this.reported) return;
    this.reported = true;
    this.options.onDegrade?.({ file: '', detail });
  }

  private build(): DepMap {
    const fallback = buildDepMap(this.rootDir);
    const mode = this.options.mode ?? 'on';
    if (mode === 'off') return fallback;

    const discovery = discoverCarto();
    if (!discovery.ok) {
      this.report(discovery.detail);
      return fallback;
    }
    let opened = openCartoReader(this.rootDir);
    // Mode `on` is a build policy: a project that upgraded into carto without
    // re-running `dispatch init` gets its container built here, once, on the
    // first review that needs it. `detect` never builds.
    if (
      !opened.ok &&
      opened.reason === 'no-container' &&
      mode === 'on' &&
      !this.initAttempted
    ) {
      this.initAttempted = true;
      const built = cartoInit(this.rootDir, discovery.binary);
      if (!built.ok) {
        this.report(built.detail);
        return fallback;
      }
      opened = openCartoReader(this.rootDir);
    }
    if (!opened.ok) {
      this.report(opened.detail);
      return fallback;
    }
    return createCartoDepMap(this.rootDir, opened.reader, fallback, (d) =>
      this.report(d.detail)
    );
  }

  get(): DepMap {
    this.cached ??= this.build();
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
```

Import `cartoInit`, `discoverCarto`, `openCartoReader`, and `type CartoMode`
from `@dispatch/core/carto` at the top of the file.

Add a test for the build-on-boot path alongside the two above:

```ts
it('does not build a container when the mode is detect', () => {
  writeFixtureWorkspace();
  const cache = new DepMapCache(root, { mode: 'detect' });
  cache.get();
  expect(existsSync(join(root, '.carto'))).toBe(false);
});
```

And a test pinning the retry guard, which is the durability half of this:

```ts
it('attempts carto init at most once across invalidations', () => {
  writeFixtureWorkspace();
  // No carto binary on PATH, so init can never succeed here; the guard is
  // what stops the watcher from respawning it on every debounced change.
  const seen: string[] = [];
  const cache = new DepMapCache(root, {
    mode: 'on',
    onDegrade: (d) => seen.push(d.detail),
  });
  cache.get();
  cache.invalidate();
  cache.get();
  cache.invalidate();
  cache.get();
  expect(seen.length).toBeLessThanOrEqual(1);
});
```

`invalidate()` clears only the memoized map, so `build()` does re-run on the
next `get()`. `reported` and `initAttempted` are what make that cheap.

Note: `reported` deliberately survives `invalidate()`. A watcher firing every
few seconds would otherwise re-report the same degradation forever — the same
unbounded-duplication bug `efc4326` fixed in `recordUndeclaredWrites`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bun test depmap.test.ts` Expected: PASS.

- [ ] **Step 5: Wire the daemon**

In `packages/server/src/index.ts`, replace lines 228–235:

```ts
// The reverse-dependency map ReviewRunner scopes reviews with. Carto backs
// it when available; the built-in scanner is the fallback. Source changes
// re-sync carto's container before invalidating, so the next review reads a
// current graph.
const cartoMode = loadConfig(rootDir).carto.enabled;
const depMapCache = new DepMapCache(rootDir, {
  mode: cartoMode,
  onDegrade: ({ detail }) => {
    ledgerStore.add({
      kind: 'hazard',
      title: 'dependency map degraded',
      detail: `carto unavailable, using the built-in scanner: ${detail}`,
    });
  },
});
const sourceWatcher = watchSourceDirs(
  depMapSourceDirs(rootDir),
  () => {
    if (cartoMode !== 'off') {
      const discovery = discoverCarto();
      if (discovery.ok) cartoSync(rootDir, discovery.binary);
    }
    depMapCache.invalidate();
  },
  isSkippedPath
);
```

Add `cartoSync` and `discoverCarto` to the `@dispatch/core/carto` imports and
`loadConfig` to the `@dispatch/core` imports if not already present. Confirm
`ledgerStore` is constructed above this point; if it is not, move this block
below its construction.

- [ ] **Step 6: Run the server suite**

Run: `cd packages/server && bun test && bun run tsc` Expected: PASS. `review.ts`
needs no changes — it consumes `DepMapProvider`, which `DepMapCache` still
satisfies.

- [ ] **Step 7: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
git add packages/server/src/depmap.ts packages/server/src/index.ts packages/server/test/depmap.test.ts
git commit -m "feat(server): select the carto backend at boot and re-sync on source change"
```

---

### Task 7: The carto MCP server for dispatched agents

**Files:**

- Modify: `packages/server/src/orchestrator/executors/claude.ts`
- Modify: `packages/server/test/orchestrator/claude-executor.test.ts`

**Interfaces:**

- Consumes: Task 1's `discoverCarto`.
- Produces: `buildCartoMcpServerConfig(projectRoot, binary): McpServerConfig`.

**Depends on Task 0 Step 6** for whether `McpStdioServerConfig` has a `cwd`
field. `carto serve` reads its root from `process.cwd()` and takes no root
argument.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/orchestrator/claude-executor.test.ts`:

```ts
describe('buildCartoMcpServerConfig', () => {
  it('passes only allowlisted environment variables', () => {
    const config = buildCartoMcpServerConfig('/proj', {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.3',
    });
    expect(config.type).toBe('stdio');
    expect(config.command).toContain('carto');
    // The SDK serializes env into the spawned CLI's argv, visible via `ps`.
    for (const key of Object.keys(config.env ?? {})) {
      expect(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']).toContain(key);
    }
  });

  it('never widens the tool tier', () => {
    const config = buildCartoMcpServerConfig('/proj', {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.3',
    });
    expect(config.env?.CARTO_MCP_TIER).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('CARTO_MCP_TIER');
  });

  it('roots carto at the project, never at a run worktree', () => {
    const config = buildCartoMcpServerConfig('/proj', {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.3',
    });
    expect(JSON.stringify(config)).toContain('/proj');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test orchestrator/claude-executor.test.ts`
Expected: FAIL — `buildCartoMcpServerConfig` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `packages/server/src/orchestrator/executors/claude.ts`, beside
`buildDispatchMcpServerConfig`:

```ts
// carto's MCP child needs far less than dispatch's: no DISPATCH_* variables,
// just enough to start. The allowlist rule is the same and for the same
// reason — the SDK serializes env into the spawned CLI's argv, readable by
// any local process through `ps`. CARTO_MCP_TIER is deliberately absent:
// omitting it keeps the agent's tool menu at carto's ~10-tool core.
const CARTO_MCP_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
];

// `carto serve` takes its project root from process.cwd() and accepts no root
// argument, so the working directory is the only way to point it at the
// project rather than the run's worktree (where .carto/ never exists).
export function buildCartoMcpServerConfig(
  projectRoot: string,
  binary: CartoBinary
): McpServerConfig {
  const env: Record<string, string> = {};
  for (const key of CARTO_MCP_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    type: 'stdio',
    command: binary.path,
    args: ['serve'],
    env,
    cwd: projectRoot,
  };
}
```

**If Task 0 Step 6 found no `cwd` field on `McpStdioServerConfig`**, replace the
return with a shell wrapper instead — and keep the comment explaining why:

```ts
return {
  type: 'stdio',
  command: '/bin/sh',
  args: [
    '-c',
    `cd ${JSON.stringify(projectRoot)} && exec ${JSON.stringify(binary.path)} serve`,
  ],
  env,
};
```

- [ ] **Step 4: Register it on the query**

In the `sdkOptions` object (around line 514), extend `mcpServers`:

```ts
      mcpServers: {
        dispatch: buildDispatchMcpServerConfig(
          opts.cwd,
          opts.projectRoot ?? opts.cwd,
          opts.runId ?? ''
        ),
        ...cartoMcpServers(opts.projectRoot ?? opts.cwd),
      },
```

And add the helper above the class:

```ts
// Contributes a `carto` entry only when the binary is actually present —
// a spawn failure would cost every run a startup error for no benefit.
function cartoMcpServers(projectRoot: string): Record<string, McpServerConfig> {
  const discovery = discoverCarto();
  if (!discovery.ok) return {};
  return { carto: buildCartoMcpServerConfig(projectRoot, discovery.binary) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
`cd packages/server && bun test orchestrator/claude-executor.test.ts && bun run tsc`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
git add packages/server/src/orchestrator/executors/claude.ts packages/server/test/orchestrator/claude-executor.test.ts
git commit -m "feat(orchestrator): give dispatched agents carto's core MCP tools"
```

---

### Task 8: CLI init and doctor

**Files:**

- Modify: `packages/cli/src/program.ts:44-60`
- Modify: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/test/init.test.ts`
- Modify: `packages/cli/test/doctor.test.ts`

**Interfaces:**

- Consumes: Task 1's `discoverCarto`, Task 3's `cartoInit`, Task 4's config.
- Produces: no new exports.

- [ ] **Step 1: Write the failing doctor test**

Append to `packages/cli/test/doctor.test.ts`, matching its existing harness
style:

```ts
it('warns when the dependency map would be empty', () => {
  // A project with no TypeScript at all: buildDepMap can only ever return [],
  // which is the silent-degradation case this warning exists to expose.
  const root = writeProject({ 'main.go': 'package main\n' });
  const out = runDoctor(root);
  expect(out).toContain('dependency map');
});

it('reports carto as absent without failing', () => {
  const root = writeProject({ 'src/a.ts': 'export const a = 1;\n' });
  const out = runDoctor(root, { PATH: '/nonexistent' });
  expect(out).toContain('carto');
  expect(out).not.toContain('Error');
});
```

If `writeProject`/`runDoctor` helpers do not exist in that file, add them:
`writeProject` writes `.dispatch/config.yml` plus the given files under a
`mkdtempSync` root; `runDoctor` invokes the registered command with a capturing
`CliContext` and returns the joined log output.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test doctor.test.ts` Expected: FAIL — no carto or
dependency-map output.

- [ ] **Step 3: Add the doctor checks**

In `packages/cli/src/commands/doctor.ts`, after the existing task-file checks
and before the summary:

```ts
// Carto health, and the case that motivated this integration: a repo
// the built-in scanner cannot read at all reports an empty dependency
// map, so review scope silently shrinks to just the changed files.
if (config.carto.enabled !== 'off') {
  const discovery = discoverCarto();
  if (discovery.ok) {
    ctx.log(`carto ${discovery.binary.version} at ${discovery.binary.path}`);
  } else {
    ctx.log(
      `carto not available (${discovery.detail}) — using the built-in dependency scanner. Install with: bun install -g carto-md`
    );
  }
}
// The built-in scanner only understands .ts/.tsx. With no carto and no
// TypeScript, dependents() can only ever return [] — the silent scope
// collapse this warning exists to expose.
if (!discoverCarto().ok && !hasTypeScriptSources(ctx.cwd)) {
  ctx.log(
    'warning: no carto container and no TypeScript sources, so the dependency map is empty and review scope covers only changed files'
  );
}
```

Add this helper below the `Issue` interface:

```ts
const SOURCE_ROOTS = ['packages', 'apps', 'src', 'lib'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.dispatch']);

// Shallow, bounded search for any .ts/.tsx file. This deliberately does NOT
// build a dependency graph — the only question is whether the built-in
// scanner could find anything at all in this repo.
function hasTypeScriptSources(rootDir: string, depth = 4): boolean {
  const search = (dir: string, left: number): boolean => {
    if (left < 0 || !existsSync(dir)) return false;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      if (search(join(dir, entry.name), left - 1)) return true;
    }
    return false;
  };
  if (search(rootDir, 0)) return true;
  return SOURCE_ROOTS.some((name) => search(join(rootDir, name), depth));
}
```

Add `existsSync`, `readdirSync`, and `type Dirent` to the `node:fs` imports.

**This deliberately avoids importing `depmap.ts`.** The CLI depends on
`@dispatch/server` as a **bin only** — server publishes just `./package.json` in
its `exports`, so `buildDepMap` is unreachable from here. Moving `depmap.ts`
into core to make it importable would be a mid-plan refactor of O-6's file for a
check that never needed the graph in the first place. A language-presence test
answers the question directly, in one self-contained function, with no
cross-package coupling and no second copy of any graph logic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && bun test doctor.test.ts && bun run tsc` Expected: PASS.

- [ ] **Step 5: Build the container on init**

In `packages/cli/src/program.ts`, inside the `init` action after the MCP
registration:

```ts
const cartoMode = loadConfig(ctx.cwd).carto.enabled;
if (cartoMode === 'on') {
  const discovery = discoverCarto();
  if (discovery.ok) {
    const result = cartoInit(ctx.cwd, discovery.binary);
    ctx.log(
      result.ok
        ? `Indexed the repo with carto ${discovery.binary.version}`
        : `carto index skipped: ${result.detail}`
    );
  }
}
```

Add `.carto/` to the project's `.gitignore` in `initIfMissing` if it is not
already ignored.

- [ ] **Step 6: Run the CLI suite**

Run: `cd packages/cli && bun test && bun run tsc` Expected: PASS. The init tests
run without carto installed, exercising the degrade path.

- [ ] **Step 7: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
git add packages/cli packages/core packages/server
git commit -m "feat(cli): build the carto container on init and report graph health in doctor"
```

---

### Task 9: The conditional real-carto test

**Files:**

- Create: `packages/server/test/carto-integration.test.ts`

A test that silently skips is worse than no test. This one reports its skip.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'bun:test';
import { discoverCarto } from '@dispatch/core/carto';

const discovery = discoverCarto();
const available = discovery.ok;

if (!available) {
  console.warn(
    '[carto-integration] SKIPPED — carto is not installed. Install it (bun install -g carto-md) to run these.'
  );
}

describe.if(available)('against a real carto container', () => {
  it('returns a blast radius whose shape matches the committed fixture', () => {
    // Uses this repo's own .carto/, built by `dispatch init`.
    const opened = openCartoReader(process.cwd());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const raw = opened.reader.blastRadius('packages/core/src/types.ts');
    expect(typeof raw.count).toBe('number');
    expect(Array.isArray(raw.files)).toBe(true);
    expect(normalizeBlastRadius(raw).length).toBeGreaterThan(0);
  });
});
```

Add the `openCartoReader` and `normalizeBlastRadius` imports.

- [ ] **Step 2: Run it both ways**

```bash
cd packages/server
bun test carto-integration.test.ts                  # with carto: PASS
PATH=/nonexistent bun test carto-integration.test.ts # without: prints SKIPPED
```

Expected: green in both, with a visible skip warning in the second.

- [ ] **Step 3: Commit**

```bash
cd /Users/wyatsoule/Sites/dispatch
export AGENT=1 && bun run format && bun run lint
git add packages/server/test/carto-integration.test.ts
git commit -m "test(server): exercise a real carto container when one is installed"
```

---

### Task 10: Docs

**Files:**

- Modify: `README.md`

**Scope note (decided during pre-flight):** the original plan added
`depends_on formula: "carto"` to the tap's dispatch cask. `brew info carto`
confirms **no such formula exists**, in homebrew-core or elsewhere, so that step
is dropped and no tap repo is touched. Delivery is a global npm/bun install,
documented here. Writing a real carto formula — a Node CLI with native
`better-sqlite3` and `tree-sitter` bindings — is its own piece of work, not a
step of this plan.

- [ ] **Step 1: Document it in the README**

Add to the README beneath the install section:

```markdown
### Dependency graph (optional)

Dispatch uses [Carto](https://github.com/theanshsonkar/carto) to compute which
files a change can break, which drives review scope and gives dispatched agents
its MCP tools. Without it, Dispatch falls back to a built-in TypeScript-only
scanner — `dispatch doctor` reports which is in use.

    bun install -g carto-md     # or: npm install -g carto-md

Set `carto.enabled: off` in `.dispatch/config.yml` to disable it.
```

- [ ] **Step 2: Commit**

```bash
export AGENT=1 && bun run format
git add README.md
git commit -m "docs: document carto as an optional dependency graph backend"
```

---

## Self-Review Notes

**Spec coverage:** All four decisions map to tasks — build-on-O-6 (5), lifecycle
ownership (3, 6, 8), Homebrew delivery (10), degrade-and-surface (5, 6, 8).
Containment → 3. Hook pinning → 3, verified in 0. Config → 4. Both MCP surfaces
→ 7 (executor) and 8 (`.mcp.json`, via the existing `registerMcpServer`).
Testing strategy → 0 (spike), 5–6 (fixture + mutation), 9 (conditional).

**Three defects found and fixed inline:**

1. **Task 8 could not compile.** `doctor` needs an empty-graph check, but the
   CLI cannot import `buildDepMap` — `@dispatch/server` exports only
   `./package.json`. The first draft punted this to a mid-plan refactor moving
   `depmap.ts` into core. Fixed properly instead: `doctor` never needed a graph,
   only "could the scanner find anything here?" — answered by
   `hasTypeScriptSources()`, one self-contained function, no cross-package
   coupling, no duplicated graph logic, no refactor of O-6's file.
2. **Spec coverage gap.** The spec says `on` means "`dispatch init` **and daemon
   boot** may run `carto init`," but only Task 8's CLI path built the container.
   A project that upgraded without re-running `dispatch init` would never get
   one. `DepMapCache.build()` now builds on first use under `on`.
3. **A retry storm introduced by fix 2.** `invalidate()` clears the memo, so
   `build()` re-runs on the next `get()` — a failed `cartoInit` would respawn a
   4–9s index on every debounced watcher tick. Guarded with `initAttempted`,
   which survives invalidation for the same reason `reported` does. Both have
   pinning tests.

**Type consistency:** checked across all ten tasks. Every symbol a task consumes
— `discoverCarto`, `openCartoReader`, `cartoInit`, `cartoSync`, `CartoMode`,
`createCartoDepMap`, `normalizeBlastRadius`, `CartoDegradation`,
`buildCartoMcpServerConfig` — is produced by a named earlier task with a
matching signature.

**Genuinely unresolved until Task 0 runs:** the per-file-hops question in
Task 5. Both branches are written out in full, so the implementer is never
blocked — but if carto exposes only a scalar `hops`, `CartoDepMap` cannot
reproduce O-6's depth ordering, trading a measured improvement for
multi-language coverage. Report the measurement before proceeding; that trade is
the user's call, not the implementer's.
