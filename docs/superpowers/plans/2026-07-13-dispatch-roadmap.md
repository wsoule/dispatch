# Dispatch Roadmap — Plan Index

Spec: `docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md`
Research: `docs/research/2026-07-13-landscape-research.md`

Each phase ships working, independently useful software and gets its own
detailed implementation plan, authored when the phase starts (so it plans
against real interfaces, not guesses). Phase order matches spec §9.

| Phase                    | Plan file                                                | Delivers                                                                                                                                                                  | Status                                                                                         |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. Core + CLI tracker    | `2026-07-13-phase-1-core-cli-tracker.md`                 | `@dispatch/core` (task files, IDs, graph, store) + `dispatch` CLI (init/create/list/show/edit/status/next/doctor). A usable git-native tracker.                           | **✅ Complete** (merged 2026-07-17, 66 tests; statuses are config-driven per spec §4 addendum) |
| 2. Daemon + Web UI       | `phase-2-daemon-web-ui.md` (author at phase start)       | `dispatchd` (Hono REST + WS on loopback, SQLite cache derived one-way from files, watcher), React board/list/detail, `dispatch ui`.                                       | Pending                                                                                        |
| 3. MCP server            | `phase-3-mcp-server.md` (author at phase start)          | stdio MCP server (`task_list/get/save/comment/next`), `workflow://onboarding` resource, `.mcp.json` registration in `dispatch init`.                                      | Pending                                                                                        |
| 4. Orchestrator MVP      | `phase-4-orchestrator-mvp.md` (author at phase start)    | Worktree manager, Executor interface + Claude Agent SDK executor, run lifecycle + normalized log streaming, approvals, review view (diff, merge/discard/request-changes). Agent awareness: `run_list` MCP tool + dispatched-agent prompt note (spec §5 "Agent collaboration"). | Pending                                                                                        |
| 5. Planner + parallelism | `phase-5-planner-parallelism.md` (author at phase start) | Plan-confirm flow (prompt → structured epic/tasks proposal), epic ready-queue dispatch with concurrency limit, PR flow + polling. Agent messaging: `agent_message` + task-comment notifications (spec §5 "Agent collaboration").                                              | Pending                                                                                        |
| 6. Hardening + release   | `phase-6-hardening-release.md` (author at phase start)   | Boot reconciliation edge cases, doctor completeness, docs site/README, npm packaging (`npx dispatch`), CI, versioning.                                                    | Pending                                                                                        |

Post-v1 (behind interfaces already in the spec): Linear/GitHub adapters, other
executors, TUI/Tauri clients, multi-dev sync UX, MCP `run_dispatch`.

Known deviations from spec, decided during Phase 1 planning:

- SQLite cache + file watcher move from Phase 1 to Phase 2 (spec §9 listed them
  in Phase 1). Rationale: the CLI does fast directory scans at v1 scale
  (backlog.md precedent); the daemon is the cache's first real consumer. The
  files→cache one-way rule in spec §4 is unchanged.
- `.mcp.json` registration in `dispatch init` lands in Phase 3 with the MCP
  server itself.
