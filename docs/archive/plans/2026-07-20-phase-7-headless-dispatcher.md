# Phase 7: Headless Dispatcher CLI

> User directive (2026-07-20): "this is an agent dispatcher" — the full
> orchestration loop must be drivable with zero GUI. The desktop app keeps
> everything it has; this phase gives the `dispatch` CLI complete parity with
> it: dispatch agents, watch them live, approve tools, review diffs,
> merge/discard/PR, plan epics, run epic sessions — all from a terminal. Tracker
> task: t-28f2f1. (The desktop-identity redesign is t-df3a1e, deliberately NOT
> this phase.)

## Architecture

The CLI (Node) talks to dispatchd over the existing REST/WS API — no new server
capabilities except where noted. Commands that need a daemon auto-start one
(extract `dispatch ui`'s ensure-daemon logic into a shared
`ensureDaemon(ctx): Promise<{ port }>` helper — spawn detached
`bun <server bin>`, poll health ≤5s, reuse healthy existing daemon via the
daemon file). Node ≥22's global WebSocket covers `--watch` streaming; every read
command supports `--json`.

## Command surface (packages/cli, new `commands/orchestrate.ts` + `commands/plan.ts`)

- `dispatch run <task-id> [--executor claude|fake] [--watch] [--json]` — POST
  /api/tasks/:id/runs; `--watch` streams WS `run.log` for that run as compact
  lines (`[assistant] …`, `[tool ✓|✗|…] Name`, `[system] state →`), renders
  `approval.requested` prominently with the exact approve/deny command to copy,
  exits when the run reaches a terminal state (exit code 0 finished / 1 failed /
  130 cancelled).
- `dispatch runs [--json]` — table: run id, task, state, branch, cost.
- `dispatch run show <run-id> [--json]` — meta + last 20 entries;
  `dispatch run watch <run-id>` — attach to a live run's stream.
- `dispatch approve <run-id> <request-id> [--deny]`
- `dispatch message <run-id> <text...> [--resume]` — live send, or
  request-changes resume on a finished run.
- `dispatch cancel <run-id>`
- `dispatch diff <run-id>` — raw unified patch to stdout (pipe-friendly);
  `--files` lists changed files with status.
- `dispatch review <run-id> <merge|discard|pr>` — surfaces the API's 409 reasons
  verbatim (dirty checkout, staged index, wrong branch, open PR).
- `dispatch plan <prompt...> [--planner claude|fake] [--json] [--yes]` —
  submits, polls to ready (WS or poll), prints the proposal as a numbered table
  with dependency arrows; `--yes` confirms immediately; otherwise prints
  `dispatch plan confirm <plan-id> [--file proposal.json]` guidance. `confirm`
  with `--file` sends an edited proposal JSON.
- `dispatch epic start <epic-id> [--concurrency N] [--executor]` /
  `dispatch epic stop <epic-id>` / `dispatch epic status <epic-id> [--json]`
  (progress endpoint; `--watch` streams run/task events until session ends).

## Server-side enablers (small)

- `packages/server/src/bin.ts`: register FakeExecutor + FakePlanner when
  `DISPATCH_ENABLE_FAKES=1` (test/e2e hook; check what bin already registers —
  the desktop dev toggle implies fake may already be wired; align and document).
  Production default registers claude only.
- If any listed CLI need lacks an endpoint field (e.g. runs table lacking cost
  or task title), extend the API response — additive only.

## Testing contract (the user asked for as much as possible)

1. Unit: command parsing/rendering helpers (entry formatting, proposal table,
   exit codes) — pure functions, bun test in packages/cli.
2. Integration (the bulk): spawn a REAL daemon
   (`bun packages/server/src/bin.ts --root <tmp> --port 0` with
   `DISPATCH_ENABLE_FAKES=1`, DISPATCH_HOME override) from CLI tests; drive the
   BUILT CLI as a subprocess for the full loop: create →
   `run --executor fake --watch` (scripted approval round-trip via a second CLI
   invocation mid-run) → `diff` → `review merge` → task done in `task list`.
   Same for `plan --planner fake --yes` → `epic start` → completion. Failure
   paths: no daemon + autostart, 409s rendered, watch reconnect, `--json`
   shapes.
3. Full-suite regression: root baseline + desktop build stay green.
4. REAL-agent e2e (controller runs post-merge, t-5dfaf6): real ClaudeExecutor
   headless loop on a toy repo — dispatch, watch, review diff, merge — with
   maxTurns/budget caps. Not in CI.

## Out of scope

Desktop identity redesign (t-df3a1e). TUI dashboards. Shell completions.
