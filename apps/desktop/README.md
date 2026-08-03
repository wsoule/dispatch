# @dispatch/desktop

Dispatch's desktop shell: a Tauri app that pairs a Rust "observability plane"
with the git-native task/orchestration work of the rest of this monorepo.

## Architecture

Two planes, one app:

- **Observability plane (Rust):** watches `~/.claude/projects/**/*.jsonl`
  (Claude Code, Codex, Gemini, Cursor logs), persists to SQLite, and computes
  cost/tags/summaries. Read-only, global across every project on the machine.
  Talks to the frontend via Tauri IPC.
- **Work plane (Bun, Dispatch's own):** the `dispatchd` sidecar
  (`packages/server`), one instance per project root, serving git-native tasks
  over HTTP/WS.
- One React frontend (`src/`), with its design system in
  `src/styles/tokens.css`.

## License

Apache-2.0, like the rest of this repository.

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

## Toolchain notes

- **Catalog reconciliation:** `react`, `react-dom` → `19.2.7`; `@types/react` →
  `19.2.17`; `@types/react-dom` → `19.2.3`; `@vitejs/plugin-react` → `6.0.3`.
  This package's remaining deps (`@fontsource/inter`,
  `@fontsource/ibm-plex-mono`, `@tanstack/react-query`, `@tauri-apps/api`,
  `@tauri-apps/cli`, `@types/node`) live in the root catalog. `typescript` stays
  on the monorepo's catalog `5.9.2`.
- **vite 7 vs 8:** the whole monorepo is unified on vite 8 (catalog `8.1.4`).
  `@dispatch/web` (packages/web) was rebuilt and re-typechecked against vite 8
  with no changes needed — no fallback pin to vite 7 was required.
- **Dropped `@supabase/supabase-js`:** vestigial after auth removal.
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
- **tsconfig:** `tsconfig.app.json`/`tsconfig.node.json` are this package's own
  configs, not merged into the monorepo's `tsconfig.options.json` — they don't
  turn on `strict`/`strictNullChecks`, and retrofitting that onto UI code not
  authored against it risks behavior changes. The desktop package therefore opts
  out of the monorepo's shared `tsgo`-based `tsc` script and uses plain
  TypeScript's `tsc -b`/`tsc -b --noEmit` instead (see `package.json` scripts);
  it's still wired into the root `tsconfig.json` project references and the root
  `bun run tsc` shortcut runs it like every other package.
- **Lint:** `tsconfig.oxlint.json` covers `apps/**`, so this package is linted
  with the repo's type-aware oxlint rules.
  `typescript/strict-boolean-expressions` and
  `typescript/prefer-nullish-coalescing` are disabled for `apps/desktop/**`
  only, via a documented override in the root `.oxlintrc.json` — see the comment
  there for why (same `strictNullChecks` mismatch as above).
