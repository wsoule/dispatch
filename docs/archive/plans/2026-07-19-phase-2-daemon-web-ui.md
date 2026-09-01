# Phase 2: Daemon + Web UI Implementation Plan

> **For agentic workers:** execute slice-by-slice (S1→S3), full verification
> baseline after each slice
> (`bun run build && bun run test && bun run tsc && bun run format && bun run lint`
> from root). Spec: §3–§7 of
> `docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md`.

**Goal:** `dispatchd` — a local daemon exposing the task store over REST +
WebSocket with a derived SQLite cache and file watcher — plus a React web UI
(board / list / detail / create) served by the daemon, and `dispatch serve` /
`dispatch ui` CLI commands.

**Architecture:** New packages `@dispatch/server` (Bun-only runtime:
`Bun.serve`, `bun:sqlite`, `fs.watch`) and `@dispatch/web` (React 19 + Vite, no
CSS framework). Server wraps `@dispatch/core`'s TaskStore for all mutations;
reads are served from an **in-memory bun:sqlite cache derived one-way from
files** (boot + watcher refresh — rebuildable by construction, honoring spec §4;
on-disk cache is a later optimization). UI talks only HTTP/WS with a
configurable base URL (Tauri-ready per spec §2).

**Deviations from spec (record in roadmap):** Bun.serve native routing instead
of Hono (zero deps, WS built in); in-memory sqlite instead of `~/.dispatch` disk
cache (same one-way rule, boot rebuild is O(task count)).

## Global Constraints

- Template conventions bind: catalog deps only, `bun test`, tsdown where a
  package builds JS for Node consumers (server is Bun-run from TS — **no build
  step**; web builds via vite), `tsgo --noEmit` typecheck, oxlint/oxfmt clean,
  ESM, strict TS.
- `@dispatch/server` may use `bun:` APIs. `@dispatch/cli` must stay
  Node-runnable (spawns `bun` for the daemon). `@dispatch/web` browser code
  imports core **types only** (`import type`).
- All mutations go through `TaskStore` (files are truth); the cache never writes
  files.
- Loopback bind only. Daemon discovery file:
  `~/.dispatch/daemons/<sha256(rootDir).slice(0,12)>.json` →
  `{ port, pid, rootDir, startedAt }`, removed on clean shutdown.
- New catalog entries (root package.json): `react` 19.2.0, `react-dom` 19.2.0,
  `@types/react` 19.2.2, `@types/react-dom` 19.2.1, `vite` 7.1.9,
  `@vitejs/plugin-react` 5.0.4. Adjust patch versions only if `bun install`
  rejects.

## Slice S1: `@dispatch/server`

**Files:** `packages/server/{package.json,tsconfig.json}`,
`src/{index.ts,cache.ts,watcher.ts,events.ts,api.ts,daemonfile.ts,bin.ts}`,
`test/{api.test.ts,cache.test.ts,watcher.test.ts,daemonfile.test.ts}`.

**Package:** name `@dispatch/server`, private, no build script
(`"build": "echo 'run directly with bun'"` or omit — ws runner tolerates missing
scripts), `test: bun test`, `tsc: tsgo --noEmit --pretty`. Deps:
`@dispatch/core` workspace:\*. Bin: `"dispatchd": "./src/bin.ts"` with
`#!/usr/bin/env bun` shebang (Bun runs TS directly).

**Interfaces (exported from src/index.ts):**

```ts
export interface ServerHandle {
  port: number;
  stop(): Promise<void>; // closes WS clients, watcher, removes daemon file
}
export function startServer(opts: {
  rootDir: string;
  port?: number; // default 0 = ephemeral
  webDistDir?: string | null; // default resolves ../../web/dist; null disables static
  writeDaemonFile?: boolean; // default true; tests pass false
}): Promise<ServerHandle>;
```

**cache.ts:** in-memory `bun:sqlite` `Database(':memory:')`, table
`tasks(id TEXT PRIMARY KEY, title, status, kind, parent, priority, assignee, created, updated, json TEXT)`
where `json` is the serialized TaskDoc. `rebuild(store: TaskStore)` truncates +
inserts from `store.list()`.
`query(filter: { status?, kind?, parent? }): TaskDoc[]` via SQL WHERE, ordered
`created, id`. `ready(): TaskDoc[]` delegates to core `readyTasks` over all
cached docs (graph logic stays in core — do NOT reimplement in SQL).

**watcher.ts:** `watchTasks(tasksDir, onChange: () => void): { close(): void }`
— `fs.watch(tasksDir)` with a 100 ms debounce collapsing bursts into one
`onChange`. On change the server rebuilds the cache and broadcasts. Full-rescan
rebuild is acceptable at v1 scale; note it.

**events.ts:** WS protocol, one message shape:
`{ type: 'task.changed' } | { type: 'hello', version: string }`. Server
broadcasts `task.changed` after any API mutation AND any watcher-detected change
(dedupe: mutations touch files → watcher would double-fire; suppress watcher
events for 200 ms after own mutation, or accept the duplicate — client treats it
as "refetch", so duplicates are harmless; choose the simple option and say so in
a comment).

**api.ts (Bun.serve routes, all JSON):**

- `GET /api/health` → `{ ok: true, version }`
- `GET /api/config` → DispatchConfig
- `GET /api/tasks?status=&kind=&parent=` → TaskDoc[] (cache)
- `GET /api/tasks/ready` → TaskDoc[] (cache + readyTasks)
- `GET /api/tasks/:id` → TaskDoc | 404 `{ error }`
- `POST /api/tasks` body CreateInput → 201 TaskDoc (validates like CLI:
  non-empty title, status against config.statuses; 400 `{ error }` on bad input)
- `PATCH /api/tasks/:id` body UpdatePatch (+ status validated against config) →
  TaskDoc | 404/400
- `GET /ws` upgrade → WS (hello on open)
- static: serve `webDistDir` files, SPA fallback to index.html for non-/api
  paths (when webDistDir exists) Errors: TaskParseError/ConfigError → 422
  `{ error: message }`; never a stack trace in the response.

**Tests (bun test, real temp repos, port 0, writeDaemonFile:false):** CRUD
round-trip via fetch; filter + ready queries; 404/400/422 paths; WS receives
`task.changed` on POST/PATCH; watcher test — write a task file directly via
TaskStore(second instance) → WS event fires and GET reflects it (poll ≤2 s);
daemonfile write/remove test with a fake HOME (`DISPATCH_HOME` env override —
daemonfile.ts reads `process.env.DISPATCH_HOME ?? os.homedir()`).

## Slice S2: CLI `serve` + `ui`

**Files:** `packages/cli/src/commands/daemon.ts` (new,
`registerDaemonCommands`), register in `program.ts`;
`packages/cli/test/daemon-cmd.test.ts`.

- `dispatch serve [--port <n>]` — requireStore, then
  `spawn('bun', [<abs path to packages/server/src/bin.ts>, ...])` foreground,
  inheriting stdio; clear CliError if `bun` is not on PATH
  (`error: dispatch serve requires bun (https://bun.sh)`). Path resolution:
  `createRequire(import.meta.url).resolve('@dispatch/server/package.json')` →
  sibling `src/bin.ts`. Add `"exports": { "./package.json": "./package.json" }`
  to server package.json for this.
- `dispatch ui [--port]` — if daemon file for this root exists and `/api/health`
  responds, open browser at `http://127.0.0.1:<port>`; else spawn serve
  (detached) then poll health ≤5 s, then open. Browser open: `open` (darwin) /
  `xdg-open` (linux) via child_process — isolate in a `openBrowser(url)` helper
  injected through CliContext so tests stub it.
- bin.ts (server) accepts `--root <dir>` (default cwd) and `--port <n>`, prints
  `dispatchd listening on http://127.0.0.1:<port>` to stdout.
- Tests: `serve` errors when store missing; helper-level test for daemon-file
  discovery; `ui` with stubbed openBrowser + a fake daemon file pointing at a
  live test server → calls openBrowser with right URL. (Do not spawn real `bun`
  subprocesses in unit tests beyond one smoke that `--help` includes the new
  commands.)

## Slice S3: `@dispatch/web`

**Files:**
`packages/web/{package.json,tsconfig.json,vite.config.ts,index.html}`,
`src/{main.tsx,App.tsx,api.ts,useTasks.ts,theme.css}`,
`src/components/{Board.tsx,ListView.tsx,TaskCard.tsx,TaskDetail.tsx,CreateTask.tsx,TopBar.tsx}`,
`test/api-url.test.ts` (pure helpers).

**Package:** private; scripts `build: vite build`, `dev: vite`,
`test: bun test`, `tsc: tsgo --noEmit --pretty`. `vite.config.ts`: react plugin,
dev proxy `/api` + `/ws` → `http://127.0.0.1:4771` (default dev daemon port;
document `bun run dev` workflow in README).

**api.ts:** `baseUrl` = `import.meta.env.VITE_DISPATCH_URL ?? ''` (empty = same
origin — the Tauri-ready seam). Typed fetchers for every endpoint;
`connectEvents(onChange)` opens WS (`ws(s)://` derived from baseUrl/location)
with 1 s-backoff reconnect.

**useTasks.ts:** fetch all tasks + config; refetch on any `task.changed`; expose
`{ tasks, config, readyIds, refresh, error }`. Derive board columns from
`config.statuses` (config-driven statuses — never hardcode the six built-ins).

**UI behavior:**

- TopBar: project name (rootDir basename from `/api/health` — add `rootDir` to
  health payload), view toggle (Board/List), New Task button.
- Board: one column per config status, cards show id (mono), title, priority
  chip, blocked badge (blockedBy with unresolved blockers), epic tag (parent).
  Click card → detail. No drag-and-drop in this phase (YAGNI; status changes
  happen in detail view).
- List: table sorted by status then priority; same click-through.
- TaskDetail: right-side drawer — full frontmatter, status select (PATCH on
  change), priority select, editable title (blur to save),
  Description/Acceptance/Activity rendered as plain sections (no markdown lib —
  `white-space: pre-wrap`), activity append box.
- CreateTask: modal — title (required), kind, priority, status, parent (select
  of epics), description. POST then close.
- Empty/error states: "not initialized" and "daemon unreachable" full-screen
  notices.

**Design direction (hand to implementer verbatim):** dark-first, ink-on-graphite
palette (bg #101114, panel #17181c, line #26282e, text #e6e7ea, dim #9a9ca3),
one accent used sparingly (electric chartreuse #c8f04a for ready-to-start
affordances and primary buttons), status pill colors mapped by name with a
neutral fallback for custom statuses; Inter or system-ui at 13–14 px base with
tabular-nums for ids; 8 px spacing grid; density over whitespace
(Linear-adjacent, not a clone); subtle 120 ms ease-out transitions on
hover/drawer; no gradients, no glassmorphism, no emoji in chrome.

**Server static integration test (in server package):** after
`bun run ws web build`, `startServer` with `webDistDir` → GET `/` returns HTML
containing `<div id="root">`; GET `/api/health` still JSON. (Guard: skip test
with a clear message if dist missing; root `build` script order builds web
before server tests run in CI — verify `scripts/ws.ts` ordering or make the e2e
build web itself in `beforeAll` with a 120 s timeout.)

## Wrap-up (controller)

- Root README dev section: `bun run ws web dev` + `bun ws server ...` workflow,
  `dispatch ui` flow.
- Roadmap: Phase 2 status + deviations (Bun.serve vs Hono; in-memory cache).
- Full baseline green; phase review (code-reviewer agent, whole branch); fixes;
  merge to main.
