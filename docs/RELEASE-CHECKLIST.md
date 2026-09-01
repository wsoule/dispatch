# Release Checklist

Gates a public release of Dispatch (npm publish, repo publication, or a
distributed desktop build) must clear, in order — later gates assume earlier
ones already passed.

## 1. CI green, including the Rust job

All jobs in `.github/workflows/ci.yml` must pass on the release commit: `verify`
(format/lint/stylelint/build/tsc/tests), `desktop` (JS build+test), `rust`
(`cargo test` for `apps/desktop/src-tauri`), `pinned-actions`. Note: `rust` only
runs `cargo test` today — `cargo fmt --check`/`clippy -D warnings` aren't
enforced yet (`apps/desktop/src-tauri` isn't clean against either) — don't treat
local fmt/clippy failures as blockers until CI itself gates on them.

## 2. `bun run build:sidecar` smoke passes

```bash
bun run build:sidecar
```

Compiles `packages/server/src/bin.ts` into `dist-sidecar/dispatchd` via
`bun build --compile` (current platform only) and smoke-boots it against a fresh
tmp project root (`--port 0`, `DISPATCH_HOME` redirected to a tmp dir),
confirming it prints its listening line and answers `/api/health` before being
killed. Must exit 0. Groundwork only — `ensure_dispatchd`
(`apps/desktop/src-tauri/src/sidecar.rs`) still spawns dispatchd via
`bun <bin.ts>` in dev; wiring the compiled binary into a packaged bundle's
resources is a separate follow-up (see that file's "Phase 6 TODO").

## 3. Tauri bundle build

```bash
bun ws desktop tauri build
```

Produces the platform-native bundle (`.app`/`.dmg` on macOS) under
`apps/desktop/src-tauri/target/release/bundle/`. **Signing/notarization are not
automated** — they need an Apple Developer ID (plus, for notarization, an
app-specific password or API key) this repo doesn't have configured. An unsigned
build runs locally but is Gatekeeper-blocked for anyone else; don't distribute
an unsigned bundle as "the release."

## 4. Version bumps + changelog note

Bump `version` in every published package changed since the last release
(`core`, `cli`, `client`, `server`, `mcp`; `web` and `desktop` stay
private/unpublished). Package versions track the app version
(`apps/desktop/src-tauri/tauri.conf.json` + the release tag) — aligned at 0.24.0
as of 2026-08-23; bump the constants `CORE_VERSION`
(`packages/core/src/index.ts`) and `MCP_SERVER_VERSION`
(`packages/mcp/src/server.ts`) with them. Write a short changelog note grouped
by the conventional-commit types already used in this repo's history (`feat`,
`fix`, `docs`, ...) — no changelog-generation tool is wired up, so this is a
manual pass over `git log` since the last release tag.

## 5. npm publish order

Publish in dependency order: **core → {client, server, mcp} → cli**.
`client`/`server`/`mcp` can go in any order relative to each other once `core`
is out; `cli` depends on all of them and must go last. Before publishing `cli`,
note `dispatch init`'s `.mcp.json` registration writes `command: 'dispatch'`
(`packages/cli/src/mcpConfig.ts`) — this **assumes `dispatch` is on the
installer's `PATH`**; a packaged-installer story that doesn't guarantee that is
a later-phase problem, not one this publish order fixes.
