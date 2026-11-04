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
  built app. Its screenshots are macOS (`-darwin`) baselines, so the Linux CI
  job skips it; `moonx desktop:e2e-update --ignore-ci-checks` rewrites them on a
  Mac. See [End-to-end tests on macOS](#end-to-end-tests-on-macos).
- `cd apps/desktop/src-tauri && cargo test` — Rust unit tests (parsers, cost
  pricing, SQLite queries, tail/watcher logic). Not a moon task; CI runs it,
  with `cargo fmt --check` and `cargo clippy`, in its own Rust job.
- `cd apps/desktop/src-tauri && cargo build` — compile the Tauri binary without
  launching a window.

## End-to-end tests on macOS

The suite runs against the storefront fixture in `.agents/ignore/storefront` and
`.agents/ignore/storefront-home` (`e2e/paths.ts`). Build it, or rebuild it after
a run has changed it, with `moonx demo:demo -- reset --no-push`.

Without a Mac, run it in CI: `.github/workflows/desktop-macos.yml` runs on
`macos-15` by hand, and on a push to a working branch that changes the workflow
file. Since macOS minutes cost money, it never runs on a pull request, on a push
to main, on a tag or on Dependabot's branches. To refresh the baselines:

```bash
gh workflow run desktop-macos.yml -f update_snapshots=true
gh run list --workflow desktop-macos.yml   # the new run's id, once it shows
gh run watch <run-id>
gh run download <run-id> -n desktop-e2e-snapshots -D apps/desktop/e2e/views.spec.ts-snapshots
```

Open every PNG and compare it with the app before committing it: the run writes
whatever the app draws, so a broken view becomes a passing baseline. Without
`update_snapshots`, the run compares against the committed baselines, and
`desktop-e2e-test-results` holds the expected, actual and diff images of any
shot that failed.

The same job then runs a WebKit pass, since Tauri draws the app with WKWebView
on macOS. `DISPATCH_E2E_WEBKIT=1` switches `playwright.config.ts` to
Playwright's WebKit for both theme projects, leaves out `views.spec.ts` (its
baselines are Chromium's) and adds `e2e/webkit-views.spec.ts`, which opens Runs
with a live outcome, Live, the board and Usage's session detail with its diff
and saves full-page shots to `test-results/webkit/`. Usage reads the native
side, so that test stands in for it with a fake Tauri bridge. The pass compares
no pixels: its shots, in the `desktop-e2e-test-results` artifact, are for a
person to review. `DISPATCH_E2E_REPORT_DIR=<dir>` adds an HTML report in that
folder; the workflow keeps one per pass in `desktop-e2e-reports`. On a Mac,
`pnpm exec playwright install webkit` in `apps/desktop` once, then
`DISPATCH_E2E_WEBKIT=1 moonx desktop:e2e --ignore-ci-checks` runs the pass
locally.

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
never calls it.

The first frames of a launch come before the page's script, and the native side
cannot read the webview's `localStorage`, so the choice is also kept natively:
each choice the window is sent also goes to the `remember_window_theme` command
(`src-tauri/src/window_theme.rs`), which writes `light` or `dark` to
`window-theme` in the app config dir and removes it for System. tauri.conf.json
marks the window `create: false`, and setup builds it from that entry with the
remembered theme, so it opens in the chosen appearance. `localStorage` stays the
page's record of the choice; the native copy only removes the launch flash.

## Downloads

wry cancels an `<a download>` when the app sets no download handler, so in the
Tauri app the file preview's Download (`src/components/files/FilePreview.tsx`)
does not save a blob from the page. It hands the raw route's address
(`client.workspaceFileUrl`, no credential) to the `download_workspace_file`
command (`src-tauri/src/downloads.rs`), which accepts only a loopback daemon's
raw route, finds that daemon by its discovery file, verifies it as attach does,
reads the file with that daemon's agent token (straight to the daemon, never
through a proxy or after a redirect) and streams it to disk. No token crosses
that call and none goes in a URL, but this is no token boundary: the page holds
the daemon's tokens anyway, through `ensure_dispatchd`. What it keeps out of the
webview is the bytes. The file lands in the Downloads folder (`~/Downloads` when
the platform names none, never the home folder itself) under its own name, or
"name (1).ext" and so on when the name is taken; a leading dot becomes `_` and
bidirectional controls are dropped, so a download is never a hidden or startup
file and never disguises its extension. The bytes go to a `.download` sibling
first and take the real name only when complete, and a daemon silent for 30
seconds ends the download. The page says "Saved to …" in a status line that
stays mounted, with a Reveal in Finder action, and the outcome outlives the link
(another file opened mid-download). A connection to a teammate's daemon, whose
address is not loopback, is refused: the agent token never leaves the machine.
Exported reports and transcripts land in the same folder by the same rule. Every
native call to a daemon, not only this one, uses a client from
`src-tauri/src/loopback.rs` that ignores `HTTP_PROXY`, `HTTPS_PROXY` and
`ALL_PROXY` and follows no redirect, so no proxy sees a daemon token on the
app's own native calls.

In a browser opened on a daemon, the same Download asks the daemon for a
single-use ticket URL when it is clicked (`client.workspaceDownloadUrl`, which
posts to `/api/files/download-ticket`) and points a throwaway `<a download>` at
it, so the browser streams the file to disk itself. Only a daemon from before
tickets, which has no ticket route (its catch-all 404, or a 405), gets the old
way: the page reads the bytes through the client and saves them from memory, and
when that fails too the error line gives both reasons. Any other refusal (no
such file, a refused token, a server error, no answer) is shown as it is, so a
large file is never read into the tab. Minting a ticket is a read, so it stays
open while team sync turns on, as `GET /api/files/raw` does. A team-local page's
session cookie authenticates the raw route directly, so there the link's own
`href` is followed.

Every app command is granted by name: `src-tauri/build.rs` lists them for
tauri-build's app manifest, `src-tauri/capabilities/default.json` grants each
`allow-<command>` to the main window, and `src/lib/tauriCommands.test.ts` fails
when those lists and `generate_handler!` in `src-tauri/src/lib.rs` drift apart.
A new command needs all three.

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
