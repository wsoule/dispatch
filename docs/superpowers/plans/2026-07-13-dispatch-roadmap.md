# Dispatch Roadmap — Plan Index

Spec: `docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md`
Research: `docs/research/2026-07-13-landscape-research.md`

Each phase ships working, independently useful software and gets its own
detailed implementation plan, authored when the phase starts. **2026-07-20
direction change:** Dispatch is desktop-first — the vendored Relay app
(`apps/desktop`, Tauri + Rust + React) is the product shell; the Rust side is
the global observability plane over `~/.claude/projects/**/*.jsonl` (Claude
Code + Codex session logs), and the Bun `dispatchd` daemon is the per-project
work plane (tasks now, orchestration next), spawned as a sidecar.

**RELEASE BLOCKER — licensing:** `apps/desktop` is vendored from the unlicensed
github.com/TanmayDabhade/Relay (@ 399d6d4) on the user's assertion of
permission. A written grant or relicense must be recorded before any public
release, publish, or repo publication.

| Phase                    | Plan file                                | Delivers                                                                                                                                                                                                                                | Status                                                                                                                                                             |
| ------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Core + CLI tracker    | `2026-07-13-phase-1-core-cli-tracker.md` | `@dispatch/core` + `dispatch` CLI. Usable git-native tracker.                                                                                                                                                                           | ✅ Complete (merged 2026-07-17, config-driven statuses per spec §4 addendum)                                                                                       |
| 2. Daemon + Web UI       | `2026-07-19-phase-2-daemon-web-ui.md`    | `dispatchd` (`@dispatch/server`), `@dispatch/web`, `dispatch serve`/`ui`.                                                                                                                                                               | ✅ Complete (merged 2026-07-20). Deviations: Bun.serve instead of Hono; in-memory bun:sqlite cache instead of disk                                                 |
| 2R. Relay port + desktop | `2026-07-20-phase-2r-relay-port.md`      | Relay vendored as `apps/desktop` (Tauri shell, JSONL observability, design system); `@dispatch/client` extraction; `ensure_dispatchd` sidecar; Tasks tab + Tasks nav in the desktop app.                                                | ✅ Complete (merged 2026-07-20)                                                                                                                                    |
| 3. MCP server            | author at phase start                    | stdio MCP server (`task_list/get/save/comment/next` + `problems[]`), `workflow://onboarding` resource, `.mcp.json` registration in `dispatch init`. Deviation: direct core file access, no daemon proxy (filesystem is the sync point). | ✅ Complete (merged 2026-07-20)                                                                                                                                    |
| 4. Orchestrator MVP      | author at phase start                    | Worktree manager, Executor + Agent SDK executor in dispatchd, run lifecycle + log streaming, approvals, review surface **in the desktop app using Pierre's diff/tree components**; `run_list` awareness (spec §5 Agent collaboration).  | ✅ Complete (merged 2026-07-20; real Claude session verified end-to-end; open design tension: task_comment vs tracked-task-file merges — see phase 4 fixes report) |
| 5. Planner + parallelism | author at phase start                    | Plan-confirm flow, epic ready-queue dispatch with concurrency, PR flow + polling; `agent_message` + task-comment notifications (spec §5).                                                                                               | Pending                                                                                                                                                            |
| 6. Hardening + release   | author at phase start                    | Reconciliation edge cases, doctor completeness, docs, **Tauri bundling + `bun build --compile` dispatchd sidecar binary**, Rust CI, versioning, **licensing gate resolution**.                                                          | Pending                                                                                                                                                            |

Post-v1 (behind interfaces already in the spec): Linear/GitHub adapters, other
executors, TUI client, multi-dev sync UX, MCP `run_dispatch`, Windows/Linux
desktop builds.

Standing decisions:

- Diff views and file trees use Pierre's open-source components (spec §5 Review;
  first consumer Phase 4).
- `packages/web` is frozen as a browser fallback; new UI work happens in
  `apps/desktop`.
- SQLite cache + watcher shipped in Phase 2 (in-memory, one-way per spec §4);
  `.mcp.json` registration lands in Phase 3 with the MCP server.
