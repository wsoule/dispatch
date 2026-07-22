# @dispatch/desktop

Dispatch's desktop shell: a Tauri app that pairs a Rust "observability plane"
(vendored from Relay) with the git-native task/orchestration work of the rest of
this monorepo. This package is the R1 vendor + toolchain-integration slice of
Phase 2R — see `docs/superpowers/plans/2026-07-20-phase-2r-relay-port.md` at the
repo root for the full plan.

## Provenance

The Rust backend (`src-tauri/`), React frontend (`src/`), static assets
(`public/`, `index.html`), and build config (`vite.config.ts`, `tsconfig*.json`)
in this package were vendored from:

- Upstream:
  [github.com/TanmayDabhade/Relay](https://github.com/TanmayDabhade/Relay)
- Commit: `399d6d4952690bb529e06b640afa97bb36cf3c46`
- Vendored: 2026-07-20

Relay's own `docs/` (its original planning docs) is kept at `apps/desktop/docs`
for reference. The clone this was vendored from lives at the repo-root `Relay/`
directory — that directory is gitignored, is **never modified**, and is not part
of this package; it exists purely as read-only source material for comparing
against future re-vendoring passes.

### Licensing

Relay's upstream repository carries no license file. Permission to include,
modify, and publish the vendored code in this repository was granted by the
upstream author, Tanmay Dabhade, to Wyat Soule (grant reported and recorded here
2026-07-22). The Dispatch-authored portions of this package are covered by the
repository's Apache-2.0 license; the vendored Relay portions are used with the
author's permission as described above.

## Architecture

Two planes, one app:

- **Observability plane (Rust, from Relay):** watches
  `~/.claude/projects/**/*.jsonl` (Claude Code, Codex, Gemini, Cursor logs),
  persists to SQLite, and computes cost/tags/summaries. Read-only, global across
  every project on the machine. Talks to the frontend via Tauri IPC.
- **Work plane (Bun, Dispatch's own):** the `dispatchd` sidecar
  (`packages/server`), one instance per project root, serving git-native tasks
  over HTTP/WS. Lands in R2 of this phase; not wired into this app yet.
- One React frontend (`src/`, Relay's own design system in
  `src/styles/tokens.css`) that will gain Dispatch's task views in R2.

## Dev workflow

```bash
bun install
bun ws desktop tauri dev   # needs Rust stable (rustup) installed
```

Other useful commands, run from the repo root:

- `bun ws desktop build` — `tsc -b && vite build` (frontend only).
- `bun ws desktop test` — frontend unit tests (`bun test`).
- `bun ws desktop tsc` — `tsc -b --noEmit` typecheck.
- `cd apps/desktop/src-tauri && cargo test` — Rust unit tests (parsers, cost
  pricing, SQLite queries, tail/watcher logic). Not wired into the root
  `bun run tsc`/`test` scripts this phase — Rust CI lands in Phase 6.
- `cd apps/desktop/src-tauri && cargo build` — compile the Tauri binary without
  launching a window.

## R1 toolchain-adaptation notes

- **Catalog reconciliation:** `react`, `react-dom` → `19.2.7`; `@types/react` →
  `19.2.17`; `@types/react-dom` → `19.2.3`; `@vitejs/plugin-react` → `6.0.3`.
  Relay's remaining deps (`@fontsource/inter`, `@fontsource/ibm-plex-mono`,
  `@tanstack/react-query`, `@tauri-apps/api`, `@tauri-apps/cli`, `@types/node`)
  were added to the root catalog at Relay's pinned versions. `typescript` stayed
  on the monorepo's catalog `5.9.2` (Relay's local `~6.0.2` was dropped; no
  TS6-only syntax needed fixing).
- **vite 7 vs 8:** unified the whole monorepo on Relay's vite 8 line (catalog
  `8.1.4`, one patch above Relay's own `^8.1.1`). `@dispatch/web` (packages/web)
  was rebuilt and re-typechecked against vite 8 with no changes needed — no
  fallback pin to vite 7 was required.
- **Dropped `@supabase/supabase-js`:** vestigial in Relay post-auth-removal.
  `src/vite-env.d.ts`'s `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`/
  `VITE_LANDING_URL` ambient env-var types were removed along with it; nothing
  in `src-tauri` referenced Supabase.
- **Network egress audit:** the only outbound HTTP call anywhere in `src-tauri`
  is the optional Anthropic session-summarizer
  (`src-tauri/src/summarize/mod.rs`,
  `POST https://api.anthropic.com/v1/messages`), gated behind an API key the
  user must supply (`ANTHROPIC_API_KEY` or `app_data_dir/config.json`) and
  disabled by default when absent. No other telemetry, analytics, or phone-home
  code exists in the Rust backend.
- **tsconfig:** `tsconfig.app.json`/`tsconfig.node.json` were kept as Relay's
  own configs (not merged into this monorepo's `tsconfig.options.json`) —
  Relay's configs don't turn on `strict`/`strictNullChecks`, and retrofitting
  that onto vendored UI code not authored against it risked behavior changes
  well beyond an R1 vendor slice. The desktop package therefore opts out of the
  monorepo's shared `tsgo`-based `tsc` script and uses plain TypeScript's
  `tsc -b`/`tsc -b --noEmit` instead (see `package.json` scripts); it's still
  wired into the root `tsconfig.json` project references and the root
  `bun run tsc` shortcut runs it like every other package.
- **Lint:** `tsconfig.oxlint.json` already covered `apps/**`, so this is the
  first time Relay's code was linted with this repo's type-aware oxlint rules.
  Real findings (floating promises, unnecessary type assertions,
  promise-returning `onClick` handlers, an import-sort issue in the new test
  file) were fixed directly. `typescript/strict-boolean-expressions` and
  `typescript/prefer-nullish-coalescing` are disabled for `apps/desktop/**`
  only, via a documented override in the root `.oxlintrc.json` — see the comment
  there for why (same `strictNullChecks` mismatch as above).
- **Rebranding scope:** only `src-tauri/tauri.conf.json` (`productName`, window
  `title`, `identifier`) and `src-tauri/Cargo.toml` (`package.name`) were
  changed, to `Dispatch` / `dev.dispatch.app` / `dispatch-desktop` respectively
  — the minimum needed to build and launch this app as "Dispatch" rather than
  "Relay". In-app UI copy (sidebar brand text, footer version string, etc.)
  still reads "Relay"; full UI rebranding is out of scope for R1 and is expected
  to land alongside R2/R3's Dispatch-specific views.
