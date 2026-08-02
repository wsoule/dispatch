# Carto integration — design

**Date:** 2026-08-02 **Status:** approved, pending implementation plan

Integrate [Carto](https://github.com/theanshsonkar/carto) (`carto-md`, MIT) into
Dispatch on two surfaces: as an MCP server available to dispatched agents, and
as a backend for the reverse-dependency graph that builds review scope.

## Why

Task O-6 built `packages/server/src/depmap.ts` — a reverse-import graph over the
workspace, consumed by `ReviewRunner` to tell a reviewer which files outside the
diff might break. Its own report
(`.superpowers/sdd/2026-08-02-orchestration-capabilities/task-6-report.md`)
records four limitations. Carto closes two of them outright, helps with a third,
and cannot help with the fourth:

| O-6 concern                                                                                                                                                           | Carto                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| #2 — regex over raw text still false-positives inside multi-line string literals; author declined to add a parser                                                     | **Closed.** tree-sitter tokenizes, so `from '...'` inside a fixture string is not an edge             |
| #4 — assumes `packages/*`/`apps/*` layout and `.ts`/`.tsx` only; the non-monorepo fallback resolves relative imports only and was never tested against a real project | **Closed.** 17 languages, no workspace-layout assumption                                              |
| Important 2 — cap starvation: `types.ts` has 284 dependents; first `cli`/`mcp`/`server` hits land at indices 56/78/89, past the cap of 20                             | **Helped.** `get_predictive_risk` supplies a per-file ranking signal `depmap.ts` has no equivalent of |
| #1 — `mcp-stdio-e2e.test.ts` → `tools.ts` has zero import edge (subprocess spawn)                                                                                     | **Not closed.** No static analysis finds this. The report is correct                                  |

The most consequential of these is #4. `DepMapCache` is constructed with the
_user's_ project root (`packages/server/src/index.ts:230`), so on a Go, Python,
or Rust repo `dependents()` returns `[]` on every call and review scope silently
degrades to the changed files alone — with no warning. That is a correctness gap
in the review pipeline, not a performance one.

**`mirrors()` is out of scope for replacement.** It reads Dispatch's own prose
convention (`// Mirrors <path>`) and caught the real Case 2 win in O-6 —
`packages/cli/src/apiClient.ts:133`'s hand-mirror of
`packages/server/src/events.ts`. No parser-based tool supplies it, because it is
not a language feature. Carto replaces the `dependents()` half only.

## Decisions

1. **Build on O-6's work.** `dependents()` gains a pluggable backend;
   `depmap.ts` stays as both the fallback and the permanent home of `mirrors()`.
2. **Dispatch owns carto's lifecycle end-to-end** — `init`, `sync`, and wiring.
3. **Delivery via a Homebrew formula alongside the cask**, with PATH resolution
   at runtime. Carto's native bindings (`better-sqlite3@11.7.0`,
   `tree-sitter@0.25.0` with per-language grammars) cannot survive
   `bun build --compile`, so it cannot ride the `scripts/build-sidecar.ts` path
   that bundles `DISPATCH_MCP_BIN`. Linux users install it from npm; `doctor`
   prints the line.
4. **Degrade and surface.** Any carto failure falls back to `depmap.ts`, and the
   degradation is visible via a ledger entry and a `doctor` warning. No carto
   failure ever fails a review run.

## Constraints discovered in carto's source

Carto's README disagreed with its source three times. Everything below was read
from the code, not the docs, and everything carto-side remains **unverified
until the spike runs** (see Testing).

- **`carto impact` has no `--json` and no `--root`** (`src/cli/impact.js`). It
  prints human-readable text with emoji risk badges. The CLI is usable for
  `init`/`sync` but is not a programmatic interface.
- **The programmatic interface is the ANCI consumer library**, documented under
  README § "Build on Carto":
  ```js
  const { loadAnci } = require('carto-md/src/anci/consumer');
  const reader = loadAnci('./.carto');
  reader.blastRadius('src/auth/session.ts'); // { count, hops, files: [...] }
  ```
  It reads the container "without running Carto's engine."
- **Tool count is tiered.** README says ≈10; `src/mcp/server.js` registers 57;
  `docs/api/README.md` catalogs 86. The core tier (~10, with parameterized
  families — `impact(mode=)`, `memory(kind=)`, `history(view=)`,
  `patterns(kind=)`) is the default. The ~30 former sibling tools
  (`get_blast_radius`, …) are deprecated shims. **Dispatch never sets
  `CARTO_MCP_TIER`**, which keeps the agent-facing surface at the core tier.
- **`carto serve` takes its project root from `process.cwd()`** — no `--root`.
- **`.carto/carto.db` is `path.join(projectRoot, '.carto')`**
  (`src/store/sqlite-store.js`).
- **`carto init` also generates `AGENTS.md`, installs four git hooks, and wires
  every AI tool it finds.** `AGENTS.md` is owned by Dispatch and load-bearing
  here; the destination is redirectable via `.carto/config.json`'s `output` key.
  The `.mcp.json` write is a non-destructive merge and needs no containment. The
  hooks need their working directory pinned. See Containment and Sync.

## Architecture

One new module, two consumers, two surfaces.

```
packages/core/src/carto.ts        →  @dispatch/core/carto   (new export subpath)
  ├─ discover()      locate `carto` on PATH, then brew prefix; version-gate
  ├─ ensureIndexed() run `carto init` (guarded) / `carto sync`
  └─ openReader()    loadAnci(<projectRoot>/.carto) → { blastRadius }

consumers
  packages/cli/src/program.ts     →  init (build the graph), doctor (health)
  packages/server/src/depmap.ts   →  CartoDepMap.dependents()
  packages/server/src/orchestrator/executors/claude.ts → carto MCP entry
```

### Why core, and why a subpath

`@dispatch/server` publishes only `./package.json` in its `exports` map — the
CLI depends on it as a **bin** (it spawns `dispatchd`) and cannot import from
it. That is precisely why `packages/cli/src/apiClient.ts:5` hand-mirrors
server's types. Since both `dispatch init`/`doctor` and the daemon need carto,
`core` is the only shared point.

Core's `exports` already has a deliberately Node-free `./browser` subpath.
Landing carto on its own `@dispatch/core/carto` subpath keeps
`node:child_process` out of the browser bundle; putting it in `.` would not.

`discover()` returns a discriminated result (`{ok:true,…} | {ok:false,reason}`)
rather than throwing — every caller's correct response to "carto is unavailable"
is to degrade, not to fail.

### CartoDepMap

Lives in `depmap.ts` beside `buildDepMap`, implementing the existing `DepMap`
interface by composition:

```ts
dependents(file) → reader.blastRadius(file)        // carto
mirrors(file)    → buildDepMap(rootDir).mirrors()  // O-6's scanner, unchanged
```

`blastRadius()` returns `hops`, so `CartoDepMap` reproduces O-6's Important-2
fix exactly rather than approximating it: sort `files` by `(hops asc, name asc)`
and return paths. `capDependencyList`'s preserve-order contract in `review.ts`
keeps working untouched, and `count` lets truncation be reported from a real
number instead of inferred.

`review.ts` is not modified for the swap. It already talks to `DepMapProvider`
(`review.ts:721`), so it cannot tell which backend answered.

### Surface 1 — agents

`buildCartoMcpServerConfig()` mirrors `buildDispatchMcpServerConfig()`
(`executors/claude.ts:98`): stdio, and its own env **allowlist**. The allowlist
is not stylistic — the SDK serializes each server's `env` into the spawned CLI's
argv, readable by any local process via `ps`, which is why `MCP_ENV_PASSTHROUGH`
exists. A second server inherits that constraint.

`query()` does not auto-load `.mcp.json` (`executors/claude.ts:507`), so the
executor's hardcoded `mcpServers` map is the only path that reaches dispatched
runs. `dispatch init` separately merges a `carto` entry into `.mcp.json` for
interactive `claude` sessions — two distinct surfaces, both wanted.

Because `carto serve` reads `process.cwd()` and takes no root argument, the
entry must be spawned with the project root as its working directory. **Whether
`McpStdioServerConfig` exposes `cwd` is a spike item**; if it does not, the
entry wraps the command.

`.carto/` is gitignored build output and runs get a plain `git worktree add`
(`worktree.ts:100`), so it does not exist in a worktree. Carto is always pointed
at the _project_ root — the same worktree-vs-project split
`buildDispatchMcpServerConfig` already handles via `--root` plus
`DISPATCH_PROJECT_ROOT`.

### Containment of `carto init`

`carto init` has one flag, `--no-temporal`, which does not help here. But it
writes `.carto/config.json` with an `output` key, and **every later `carto sync`
resolves its destination from it**:

```js
// src/cli/init.js — written fresh by init
const config = { version: '2', framework, language, projectRoot,
                 output: 'AGENTS.md', generated: … };
// …read back on every sync:
path.resolve(projectRoot, config.output || 'AGENTS.md')
```

So `AGENTS.md` is at risk exactly once — during the single `carto init` call —
and is permanently safe afterwards. Containment is therefore:

1. Snapshot `AGENTS.md`.
2. Run `carto init`.
3. Restore `AGENTS.md`.
4. Rewrite `.carto/config.json`'s `output` to `.carto/CONTEXT.md`.

After step 4 no `carto sync` ever targets `AGENTS.md` again, so this is a
one-time guard rather than a permanent snapshot-restore dance around every
invocation. Carto's generated context lands inside `.carto/`, which it owns and
which gets a `.gitignore` line.

**`.mcp.json` needs no containment.** Carto's `mergeMcpJson()` reads the
existing file, sets `config[key].carto = entry` under `mcpServers` (or
`servers`), and writes back — a non-destructive merge that preserves the
`dispatch` entry. This corrects an earlier assumption in this design: there is
no collision with `mcpConfig.ts`, and `dispatch init` can merge its own entry
before or after carto's without ordering constraints.

### Sync, and the worktree hook hazard

`carto init` installs four hooks — `pre-commit`, `post-checkout`, `post-merge`,
`post-rewrite` — each appended non-destructively under the marker
`# carto-md: keep index fresh on git events`, running:

```sh
carto sync >/dev/null 2>&1 || true
```

Worktrees share the common git dir, so **an agent committing inside a run's
worktree fires these hooks with `cwd` set to the worktree**, where `.carto/`
does not exist. `carto sync` would index the worktree or create a stray
container there; the `|| true` and redirected output mean it fails silently
either way, which is worse, not better.

The fix is to pin the hook's working directory to the main worktree rather than
to remove the hooks. After `carto init`, Dispatch rewrites the carto-inserted
line in each of the four hooks to:

```sh
(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." \
  && carto sync) >/dev/null 2>&1 || true
```

`--git-common-dir` resolves to the _main_ repository's `.git` from inside any
linked worktree, so its parent is always the project root. This is durable
against re-initialisation: carto's installer skips any hook whose contents
already include `carto sync`, so a later `carto init` leaves the rewritten line
alone.

This is strictly better than declining the hooks. An agent committing inside a
run's worktree now correctly refreshes the _project's_ container, which is
behaviour Dispatch would otherwise have to build. The daemon's watcher still
runs `carto sync` (cwd pinned to the project root) for uncommitted edits, then
invalidates `depMapCache` — sync is incremental, so the two paths overlapping is
harmless.

The exact hook-rewrite is a spike item: the line must be verified against a real
`carto init` on a repo with pre-existing hooks, and against a commit made inside
an actual run worktree.

### Config

One optional block on `DispatchConfig`. **Absent behaves as `on`** — carto is on
by default wherever the binary is present.

```yaml
carto:
  enabled: on # on | detect | off
```

- **`on`** (default) — use carto, and build the container when it is missing:
  `dispatch init` and daemon boot may run `carto init`, subject to Containment.
  This never hardens into a requirement. If the binary is absent it degrades
  exactly as the failure ladder describes, because decision 4 says no carto
  failure fails a run. `on` selects a build policy, not a dependency.
- **`detect`** — use carto only when both the binary and `.carto/` are already
  present; never run `carto init`. For a repo where the one-time `carto init`
  side effects (hook installation, the `AGENTS.md` write in step 2 of
  Containment) are unwanted.
- **`off`** — `buildDepMap` only. No discovery, no MCP entry, no sync.

Defaulting to `on` means an existing project's first daemon boot after upgrade
performs a one-time 4–9s index and installs four git hooks. That is a real
first-run side effect on a repo the user did not explicitly opt in, and it is
the deliberate cost of on-by-default: `doctor` reports what was done, and
`detect` or `off` opts out.

## Failure handling

Every rung degrades; none fails a run.

| Failure                                 | Behavior                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `carto` not on PATH                     | `buildDepMap` serves everything; `doctor` prints the install line                                                            |
| `.carto/` missing, or `loadAnci` throws | Per-call fallback, **failure cached** so a broken container does not retry on every file in a diff                           |
| `carto sync` exits non-zero             | Keep serving the stale container — stale beats empty — plus a `doctor` warning                                               |
| Container built at an older commit      | Accepted; the container's source commit is recorded in the review's ledger entry so staleness is visible rather than guessed |
| `carto serve` fails to spawn            | Run proceeds with dispatch tools only                                                                                        |

Degradation is surfaced **once per daemon boot** as a ledger entry, not per
call. A 40-file diff must not file 40 identical hazards — that is the exact bug
`efc4326` had to fix in `recordUndeclaredWrites`, where undeduped per-round
filing made the fix loop structurally unable to reach `complete`.

This is also where the pre-existing silent gap closes: a repo whose
`dependents()` always returns `[]` becomes a `doctor` warning whether or not
carto is installed.

## Testing

CI cannot assume `carto` is installed, and a carto-dependent test that silently
skips is worthless. The strategy splits accordingly.

1. **A verification spike runs before any adapter code.** Install carto, run it
   against a scratch clone of this repo, and capture:
   - a real `blastRadius()` response — the `{count, hops, files}` shape is the
     one remaining load-bearing claim taken from docs rather than source;
   - the real file-mutation set of `carto init`, confirming `AGENTS.md` is the
     only Dispatch-owned file written and that `.carto/config.json`'s `output`
     redirect actually governs subsequent syncs;
   - the four installed hooks verbatim, then the rewritten `--git-common-dir`
     line exercised by a commit made **inside a real run worktree**;
   - the `carto serve` core-tier tool list, confirming ~10 rather than 57;
   - whether `McpStdioServerConfig` accepts `cwd`.

   Commit the `blastRadius()` response as a fixture. Every docs-derived shape in
   this document is pinned to observed reality before anything is built on it.
   The spike runs against a scratch clone specifically because `carto init`
   installs hooks and writes `AGENTS.md` — it must not be the first thing tried
   on the working repo.

2. **Unit tests use the recorded fixture, no binary needed.** `CartoDepMap`
   takes a reader interface; tests hand it the captured `{count, hops, files}`
   and assert its `(hops, name)` ordering matches what `buildDepMap` produces
   for the same graph. That equivalence is the contract keeping `review.ts`
   backend-agnostic.
3. **The fallback ladder is mutation-verified.** It is the highest-risk surface
   — a bug there means silent degradation, the exact failure this work removes.
   Following the O-6 report's own practice (it reverted its dedup guard to
   `if (false && …)` to prove the test caught the bug), each rung is broken
   deliberately and the test confirmed red before being confirmed green.
4. **One conditional real-carto test**, gated on binary presence: green locally,
   skipped in CI, and _reported as skipped_ rather than counted as passing.
5. **`review.ts` needs no new tests for the swap.** It already injects a fake
   `DepMapProvider`; if both backends satisfy one contract its existing coverage
   holds. New review tests cover only the ledger entry on degradation.

Verification baseline per `AGENTS.md`: `bun run format` and `bun run lint` from
the root, plus `bun run tsc` and focused tests in `packages/core`,
`packages/server`, and `packages/cli`.

## Out of scope

- Replacing `mirrors()`. It stays in `depmap.ts` permanently.
- O-6 concern #1 (subprocess-spawn edges). No static tool finds these.
- Carto's episodic/temporal/brain tool families beyond what the core MCP tier
  exposes to agents by default. Risk-ranked cap ordering via
  `get_predictive_risk` is a plausible follow-up, deliberately not in this pass.
- Bundling carto into the packaged desktop app. Native bindings make this
  infeasible; delivery is Homebrew plus npm.
