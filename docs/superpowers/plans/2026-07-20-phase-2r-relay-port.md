# Phase 2R: Relay Port + Tauri Desktop Shell

> Direction change (user, 2026-07-20): Dispatch pivots desktop-now. The Relay
> app (cloned at `Relay/`, github.com/TanmayDabhade/Relay @ 399d6d4) is ported
> INTO this monorepo — its Tauri shell, views, styles, and JSONL observability
> become Dispatch's foundation; our git-native tasks + orchestration vision
> layers on top. Relay answers the "use `~/.claude/projects/**/*.jsonl`"
> question: that is its core data source, incl. Codex logs (multi-agent).

**LICENSING GATE (release blocker):** Relay carries no license. The user asserts
permission from the author is held/obtainable. Vendoring proceeds locally on
that basis, but **a written grant (or relicense) must be recorded before any
public release, npm publish, or repo publication.** Track in roadmap; note
provenance in `apps/desktop/README.md`.

**Resulting architecture (two planes, one app):**

- **Observability plane (Rust, from Relay):** watches `~/.claude/projects` JSONL
  (Claude Code + Codex), SQLite, cost, tags, summaries — read-only, global
  across all projects. Talks to the frontend via Tauri IPC.
- **Work plane (Bun, ours):** `dispatchd` sidecar per project root — git-native
  tasks now, orchestration (Agent SDK is TS-only) in Phases 4–5. Talks to the
  frontend via HTTP/WS (the Tauri-ready seam from Phase 2).
- One React frontend in `apps/desktop` (Relay's app + design system), gaining
  Dispatch task views.

## Slices

### R1: Vendor + toolchain integration

- Copy `Relay/{src,src-tauri,public,index.html,vite.config.ts,tsconfig*.json}` →
  `apps/desktop/`. EXCLUDE: `Relay/.git`, `landing-page/`, `package-lock.json`,
  `node_modules`. Keep `Relay/docs` → `apps/desktop/docs` (reference). Root
  `Relay/` dir stays untouched (source of the vendor; user's clone).
- `apps/desktop/package.json`: name `@dispatch/desktop`, private, catalog deps.
  Catalog reconciliation (root package.json): upgrade shared entries so ONE
  version serves web+desktop — react 19.2.7, react-dom 19.2.7, @types/react,
  @types/react-dom latest 19.2.x, @vitejs/plugin-react per Relay (6.x), vite:
  try unifying on Relay's 8.1.1 (verify @dispatch/web still builds; if vite 8
  breaks web, keep web on 7.1.9 via a direct pinned version in web with a
  comment — document whichever). typescript stays catalog 5.9.2 (Relay's ~6.0.2
  is dropped; fix any TS6-only syntax, expected none). Add Relay's remaining
  deps to catalog: @fontsource/inter, @fontsource/ibm-plex-mono,
  @tanstack/react-query, @tauri-apps/api, @tauri-apps/cli. DROP
  @supabase/supabase-js (vestigial post-auth-removal; clean vite-env.d.ts
  references).
- Strip anything network-calling except the optional Anthropic summarizer
  (verified: the "npm analytics" commit touched only landing-page; confirm no
  other telemetry in `src-tauri`).
- tsconfig: keep Relay's own app/node tsconfigs (browser + vite), renamed to
  extend our options where compatible; desktop is NOT added to root project
  references if tsgo chokes on its config — in that case give it `tsc: tsc -b`
  and document. oxlint: Relay already uses oxlint; our root lint covers
  `apps/**` (tsconfig.oxlint.json already includes it) — fix or locally
  disable-with-comment any violations.
- Scripts: `dev: vite`, `build: tsc -b && vite build`, `tauri: tauri`,
  `test: bun test` (frontend unit tests if any; else a placeholder test for the
  lib helpers), `tsc: tsc -b --noEmit`-equivalent. Rust: `cargo test` runs in
  `apps/desktop/src-tauri` (NOT wired into root bun scripts this phase; Phase 6
  adds CI).
- Verify: `bun install` clean; `bun run ws desktop build` green;
  `cd apps/desktop && bunx tauri dev` compiles and launches (manual smoke,
  capture startup log); `cargo test` green in src-tauri; root baseline
  (build/test/tsc/ format/lint) stays green for the existing packages.

### R2: dispatchd sidecar + Tasks in the desktop app

- Rust command `ensure_dispatchd(root: String) -> Result<u16>`: reuse the
  daemon-file discovery scheme (hash = sha256(rootDir) hex first 12,
  `~/.dispatch/daemons/<hash>.json`, honor `DISPATCH_HOME`); if healthy daemon
  exists return its port; else spawn
  `bun <repo>/packages/server/src/bin.ts --root <root>` (dev; packaged binary
  path comes in Phase 6), poll `/api/health` ≤5 s, track child for kill-on-exit.
  Unit-test the pure parts (hash/path/health-parse) in Rust; spawn path behind a
  trait for testability.
- Frontend: extract our reusable client into `packages/client`
  (@dispatch/client): api.ts + useTasks + connectEvents + shared task types
  (from @dispatch/web, made baseUrl-first). @dispatch/web consumes it (no
  behavior change); desktop consumes it with `http://127.0.0.1:<port>` base.
- ProjectDetail gains a **Tasks tab** when the project root contains
  `.dispatch/`: board-style column view + task detail + create + status change,
  restyled native to Relay's tokens.css design system (do NOT copy web's
  theme.css). Ready-lane affordance per our accent conventions adapted to
  Relay's palette. Config-driven statuses (from /api/config).
- A global "Tasks" nav item listing dispatch-enabled projects (from Relay's
  project list ∩ has-.dispatch) linking into the per-project tab.
- Tests: client package unit tests (URL building, WS reconnect logic with fake
  sockets); desktop lib-level tests for the has-.dispatch detection; manual
  tauri-dev smoke of the tab against a live repo.

### R3: Docs + review + merge

- `apps/desktop/README.md`: provenance (upstream repo + commit, vendor date,
  permission status + release gate), architecture (two planes), dev workflow.
- Roadmap rewrite: Phase 2 marked complete w/ deviations (Bun.serve vs Hono,
  in-memory cache); insert Phase 2R (this) as current; Phase 4/5 UI targets the
  desktop app; Phase 6 packaging = Tauri bundle + `bun build --compile` sidecar
  - Rust CI + LICENSE gate. Spec addendum §2/§3: desktop-now decision +
    two-plane architecture + JSONL observability source (supersedes parts of the
    2026-07-19 web-first note; keep both dated).
- Whole-branch review (most capable model), fix wave, merge.

## Standing UI requirement (user, 2026-07-20)

Diff views and file trees across the app use **Pierre's open-source components**
(pierre.co diff/tree renderers). First consumer is Phase 4's review surface;
R2's task views don't render diffs, but do not introduce a competing diff/tree
dependency in the meantime. Verify package names, React 19 compatibility, and
license at Phase 4 planning.

## Out of scope (explicitly)

- Packaging/signing (Phase 6). Windows/Linux (Relay is macOS-only today).
- Orchestrator/runs UI (Phase 4) — but R2's sidecar wiring is its foundation.
- Deleting `packages/web` — it stays as the browser fallback, frozen.
- The `Relay/` source dir: never modified, never committed (add to .gitignore).
