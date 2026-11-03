# @dispatch/desktop

Dispatch's desktop shell: a Tauri app that pairs a Rust "observability plane"
with the task/orchestration work of the rest of this monorepo.

## Architecture

Two planes, one app:

- **Observability plane (Rust):** watches `~/.claude/projects/**/*.jsonl`
  (Claude Code, Codex, Gemini, Cursor logs), persists to SQLite, and computes
  cost/tags/summaries. Read-only, global across every project on the machine.
  Talks to the frontend via Tauri IPC.
- **Work plane (Bun, Dispatch's own):** the `dispatchd` sidecar
  (`packages/server`), one instance per project root, serving git-native tasks
  over HTTP/WS.
- One React frontend (`src/`). Its design system is `@dispatch/ui`
  (`packages/ui/src/styles/tokens.css`, Gr8r Studio's tokens).

## License

FSL-1.1-ALv2, like the rest of this repository — see the root `LICENSE`.

## Dev workflow

```bash
pnpm install
moonx desktop:tauri-dev --ignore-ci-checks   # needs Rust stable (rustup) installed
```

Other useful commands, run from anywhere in the repo (they are this package's
moon tasks, `apps/desktop/moon.yml`):

- `moonx desktop:dev --ignore-ci-checks` — the Vite dev server alone, without
  the Tauri window.
- `moonx desktop:build` — `tsc -b && vite build` (frontend only).
- `moonx desktop:test` — frontend unit tests (`bun test`), after the build:
  `webkitFloor.test.ts` reads `dist/`.
- `moonx desktop:typecheck` — `tsc -b --noEmit`.
- `moonx desktop:e2e --ignore-ci-checks` — the Playwright suite against the
  built app. Its screenshots are macOS (`-darwin`) baselines, so CI skips it;
  `moonx desktop:e2e-update --ignore-ci-checks` rewrites them on a Mac.
- `cd apps/desktop/src-tauri && cargo test` — Rust unit tests (parsers, cost
  pricing, SQLite queries, tail/watcher logic). Not a moon task; CI runs it,
  with `cargo fmt --check` and `cargo clippy`, in its own Rust job.
- `cd apps/desktop/src-tauri && cargo build` — compile the Tauri binary without
  launching a window.

## Theme

The sidebar footer flips the theme between light and dark; Settings → General →
Appearance offers System, Light or Dark, and the palette's "Follow the system
theme" goes back to System. The choice is stored in `localStorage` under
`dispatch:theme` (`src/lib/theme.ts`) and applied before first paint by the
inline script `vite.config.ts` injects at the top of `<body>`. Storage is per
origin: the Tauri app has one origin, so the choice holds for every project; in
a browser (`dispatch ui`) each daemon port is its own origin and keeps its own
choice.

In the Tauri app the window's native appearance follows the choice too:
`followThemeInNativeWindow` (`src/lib/nativeTheme.ts`, started by `main.tsx`)
calls `getCurrentWindow().setTheme` with `'light'` or `'dark'` for a stored
choice and `null` (follow the OS) for System, once at startup and on every
change of `html[data-theme]`, so the footer toggle, Settings, the palette and
another window all reach it. That sets the window background where the page has
not painted, the area a resize exposes and native menus. It needs the
`core:window:allow-set-theme` capability in `src-tauri/capabilities/`; a browser
never calls it. The first frames of a launch, before the page's script runs,
still follow the OS: the choice lives in the webview's `localStorage`, which the
native side cannot read before it opens the window.

## Toolchain notes

- **Catalog reconciliation:** `react`, `react-dom` → `19.2.7`; `@types/react` →
  `19.2.17`; `@types/react-dom` → `19.2.3`; `@vitejs/plugin-react` → `6.0.3`.
  Every other dependency, the fonts (`@fontsource-variable/geist`,
  `@fontsource/geist-mono`) among them, comes from the root catalog too
  (`catalog:` in `package.json`). `typescript` stays on the monorepo's catalog
  `5.9.2`.
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
