# Design: Dispatch — Git-Native Agent Orchestration Platform

Date: 2026-07-13 Status: Draft — written autonomously while user was AFK; every
decision below is overridable. Decisions made on the user's behalf are marked
**[assumed]**. Research basis: `docs/research/2026-07-13-landscape-research.md`

"Dispatch" is a **working title** — rename freely; nothing in the architecture
depends on it.

## 1. Vision & scope

An open-source, local-first orchestration platform for agentic coding. One app
where you:

- see every task/epic in the project and what agents are working on right now
- turn a big prompt into a confirmed epic-with-tasks (or a single task) via a
  planning agent
- dispatch agents to work tasks in isolated git worktrees, in parallel
- review results (diff, agent conversation, cost) and merge / request changes /
  open a PR — all in one place
- do all of the above equally from web UI, CLI, or MCP (any agent can drive the
  tracker)

**Git is the backbone**: tasks are files in the repo, worktrees isolate agent
work, branches/PRs carry results, and future multi-developer sync is
`git push`/`git pull` — no server required.

### v1 scope (single developer, single machine)

Open app → status of all tasks → create tasks → spawn agents on tasks/epics →
review results. Claude Code is the only executor in v1.

### Explicitly deferred (architected-for, not built)

- Multi-developer real-time sync beyond git push/pull
- Linear / GitHub Issues / Jira adapters (import + bidirectional sync)
- Additional executors (Codex, Gemini CLI, etc.)
- Tauri desktop shell, TUI client, mobile/remote access
- Agent-dispatching-agents via MCP (`run_dispatch` tool)

## 2. Approaches considered

### Storage (the load-bearing decision)

|                   | A. Markdown files in repo                                                  | B. SQLite-first + git export                               | C. Git-refs op-log (git-bug style)                       |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Sync between devs | free (git push/pull, PRs)                                                  | export/import ceremony                                     | free but custom refs — forks/hosting/CI don't carry them |
| Agent legibility  | grep/read/edit with file tools                                             | needs API/MCP always                                       | opaque; needs API always                                 |
| Merge behavior    | per-task file conflicts only; rare, human-resolvable                       | n/a locally, painful across machines                       | conflict-free by construction                            |
| Query speed       | needs derived cache                                                        | native                                                     | needs derived cache                                      |
| Field evidence    | backlog.md thriving; Beads-classic died of _bidirectional_ sync, not files | Vibe Kanban (dead, and its non-git storage is a cited gap) | git-bug alive-but-niche for a decade                     |

**Chosen: A**, with hash-based short IDs (every sequential-ID scheme in the
field failed across branches) and a gitignored SQLite cache derived **one-way**
from files (files → cache, never back — the exact arrow Beads-classic got
wrong). C's ideas (append-only activity, content-hash IDs) inform the format,
but custom refs would break the "agents just read files" property that makes
this LLM-native.

### Agent execution

|                      | A. Claude Agent SDK (TS)                                             | B. Raw `claude -p` stream-json pipes       | C. Fork Vibe Kanban (Rust)              |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| Effort               | low — query()/hooks/canUseTool/resume built in                       | high — hand-roll control protocol VK-style | inherit 100k lines of unmaintained Rust |
| Multi-executor later | add raw-pipe executors behind same interface                         | same work anyway                           | built in, but for a dead codebase       |
| Risk                 | SDK churn (mitigate: pin version, isolate behind Executor interface) | protocol churn                             | maintenance burden, wrong storage model |

**Chosen: A** behind a narrow `Executor` interface so B-style executors for
other agent CLIs slot in later.

### Form factor

**Chosen: localhost daemon + browser UI first [user-confirmed 2026-07-19], with
a Tauri 2 desktop shell as the planned follow-on once the UI is fleshed out.**
Field consensus for OSS infra tools; zero packaging; the daemon doubles as
API/MCP/WebSocket host. CLI works without the daemon for core task ops (direct
file access), so the tracker is usable even when nothing is running.

The web UI must stay Tauri-ready: all UI↔daemon communication goes through the
HTTP/WS API (no server-rendered pages, no reliance on being served from the
daemon's origin beyond a configurable base URL), so the later desktop shell is
packaging — the same React app in an OS webview, with the daemon bundled as a
`bun build --compile` sidecar binary (opcode / Vibe Kanban precedent). Dock
badge, tray status, and native notifications arrive with that shell.

## 3. Architecture

```
┌────────────┐  ┌────────────┐  ┌──────────────────────┐
│  Web UI    │  │    CLI     │  │ Any MCP client       │
│ React/Vite │  │ dispatch * │  │ (Claude Code, etc.)  │
└─────┬──────┘  └─────┬──────┘  └──────────┬───────────┘
      │ HTTP+WS       │ HTTP (or direct    │ stdio shim
      │               │ file access when   │ (npx dispatch mcp)
      │               │ daemon is down)    │
      └──────────┬────┴────────────────────┘
          ┌──────▼───────────────────────────────┐
          │        dispatchd (local daemon)      │
          │  REST + WebSocket (Hono, loopback)   │
          │ ┌───────────┐  ┌───────────────────┐ │
          │ │ Task Store│  │   Orchestrator    │ │
          │ │ (core)    │  │ runs · worktrees  │ │
          │ │ files ⇒   │  │ Executor: Agent   │ │
          │ │ SQLite    │  │ SDK (Claude Code) │ │
          │ │ cache     │  │ approvals · logs  │ │
          │ └─────┬─────┘  └─────────┬─────────┘ │
          └───────┼──────────────────┼───────────┘
                  ▼                  ▼
      .dispatch/ in repo      ~/.dispatch/ (machine-local)
      tasks as markdown       worktrees, run logs, SQLite,
      (source of truth,       agent sessions (all ephemeral/
      synced via git)         rebuildable, never in git)
```

### Package layout (TypeScript monorepo, pnpm workspaces, Node ≥ 22) **[assumed]**

- `packages/core` — task file format (parse/serialize), hash IDs, dependency
  graph + ready-work query, task store (file CRUD), SQLite cache derivation,
  file watcher, git helpers. Zero HTTP. Everything else consumes this.
- `packages/server` — `dispatchd`: Hono REST + WebSocket on loopback, event bus,
  the Orchestrator (run lifecycle, worktree manager, Executor interface + Claude
  Agent SDK executor, approval routing, normalized log streaming), boot
  reconciliation.
- `packages/cli` — `dispatch` command; talks HTTP to a running daemon, falls
  back to direct `core` file access for task CRUD when no daemon.
- `packages/mcp` — stdio MCP server (official TS SDK): thin shim proxying to the
  daemon when up, direct `core` access when not.
- `packages/web` — React + Vite SPA served by the daemon: board/list, task
  detail, run view (live normalized log), review view (diff + actions), planner
  confirm flow.
- `packages/adapters` _(deferred)_ — Linear/GitHub sync behind an `Adapter`
  interface; external IDs map via `external:` frontmatter field.

License: **Apache-2.0 [assumed]** (patent grant; matches Vibe
Kanban/Cyrus/Terragon-oss so their code is minable).

## 4. Data model

### Task files — source of truth, in the target repo

```
.dispatch/
  config.yml            # statuses, defaults, executor config, autoCommit
  tasks/
    t-3fa9c2-fix-login-redirect.md
    e-8b21d0-auth-overhaul.md
  docs/                  # optional: PRDs, decisions the planner links to
```

One markdown file per task/epic. Filename = `<id>-<slug>.md`. Example:

```markdown
---
id:
  t-3fa9c2 # "t-" task / "e-" epic + 6-hex content hash (from
  #  creation timestamp+title+nonce) — no cross-branch
  #  collisions, short enough for agents to type
title: Fix login redirect loop
status: todo # backlog | todo | in-progress | in-review | done | cancelled
kind: task # task | epic
parent: e-8b21d0 # optional epic membership
blocked-by: [t-91c4aa] # dependency edges ("blocked" is derived, not a status)
labels: [bug, auth]
priority: high # urgent | high | medium | low | none
assignee: agent # agent | human | none
created: 2026-07-13T18:04:00Z
updated: 2026-07-13T18:04:00Z
external: null # future: "linear:ENG-123" for adapter sync
---

## Description

...what and why...

## Acceptance Criteria

- [ ] redirect loop no longer occurs when session expires
- [ ] regression test added

## Activity

- 2026-07-13T19:22Z [run r-77ab12] dispatched (claude-code, branch
  dispatch/t-3fa9c2)
- 2026-07-13T19:40Z [run r-77ab12] finished: in-review — 2 files changed, $0.84
```

Rules:

- **Files → cache, one way.** The SQLite cache (in `~/.dispatch/`, keyed by repo
  path) is rebuilt from files at boot and kept fresh by a file watcher;
  `dispatch doctor --rebuild` recreates it from scratch. Nothing ever writes
  cache → files.
- All mutations (UI, CLI, MCP) go through the store API, which writes the file,
  bumps `updated`, then updates the cache. Concurrent external edits (user in
  $EDITOR, git pull) are picked up by the watcher; last-writer-wins by `updated`
  on frontmatter, append-union on Activity.
- Epics are tasks with `kind: epic`; children point at them via `parent`.
  Progress = derived rollup of children.
- **Ready-work query** (the agent-facing killer feature, per Beads):
  `status in (todo)` AND no incomplete `blocked-by` — exposed as
  `dispatch task next`, MCP `task_next`, and a UI lane.
- **Status decision (Phase 1 final review, 2026-07-17):** `config.yml`'s
  `statuses` list is the source of truth for valid statuses; the six built-ins
  are defaults, not a closed set. `TaskMeta.status` is typed `string`; CLI
  create/status/list validate against config; `parseTaskFile` stays
  status-tolerant; `doctor` flags statuses not in config.
  `todo`/`done`/`cancelled` carry the ready/done semantics regardless of custom
  additions. Phase 2+ consumers (daemon, MCP) must validate against config, not
  the built-in union.
- `autoCommit: false` by default: `.dispatch/` changes ride the user's normal
  commits. `autoCommit: true` makes the daemon commit task-file changes with
  `chore(dispatch): ...` messages **[assumed default: off]**.

### Runs — machine-local, never in git

A run = one agent execution attempt on one task. SQLite tables (`runs`,
`run_events`) plus JSONL transcript per run in `~/.dispatch/`. Rationale: logs
are huge, machine-specific, and replayable; what teammates need — outcome,
branch name, cost — is appended to the task file's Activity section, which
_does_ sync via git.

Run lifecycle:
`queued → provisioning (worktree) → running → awaiting-approval ⇄ running → finishing → finished | failed | cancelled`.
The run records: task id, executor, session id (for resume), worktree path,
branch, base branch, cost, turn count, exit state.

## 5. Core flows

### Create tasks

UI form / `dispatch task create` / MCP `task_save`. Direct and instant — no
agent involved.

### Plan: big prompt → epic + tasks (confirm before write)

1. User submits a prompt (UI "Plan" box or `dispatch plan "<prompt>"`).
2. Planner run: Agent SDK `query()` in the repo (read-only tools),
   `outputFormat: json_schema` forcing
   `{epic?, tasks[]: {title, description, acceptance_criteria[], blocked_by_indices[], priority}}`.
   Planner decides epic-with-tasks vs single task based on scope.
3. Proposal renders in UI (or CLI table) — user edits/deletes/approves.
   **Nothing is written until confirmed.**
4. On confirm: store writes the files, graph edges wired, board updates.

### Dispatch: run an agent on a task

1. Trigger: UI button on a task / `dispatch run t-3fa9c2` / auto-dispatch toggle
   on an epic ("work the ready queue, N at a time").
2. Orchestrator provisions worktree at
   `~/.dispatch/worktrees/<repo-hash>/<run-id>` on branch
   `dispatch/<task-id>-<slug>` off the configured base (default: repo's current
   default branch), with Vibe Kanban-style hygiene: prune stale worktrees,
   retry-once, reconcile orphans at boot.
3. Executor (Agent SDK) starts a session in the worktree. Prompt assembly: task
   file content + epic context + acceptance criteria + repo conventions +
   instructions to update Activity via MCP. In-process MCP server injects the
   task tools; `canUseTool` routes permission asks to the UI/CLI as approval
   cards (per-run permission mode: `plan` / `acceptEdits` / `bypassPermissions`,
   default `acceptEdits` **[assumed]**); per-run caps: `maxBudgetUsd`,
   `maxTurns` from config.
4. Live view: normalized entries (assistant text, tool calls with status,
   thinking, token/cost) streamed over WebSocket, chat-style with collapsible
   tool calls. Interrupt and mid-run follow-up messages supported
   (streaming-input mode).
5. On Stop hook: orchestrator verifies the worktree has committed work
   (uncommitted → instruct agent to commit or auto-commit **[assumed: agent is
   instructed to commit; safety-net auto-commit before finish]**), appends run
   summary to the task Activity, sets task `in-review`.
6. Epic dispatch = dispatch the epic's ready queue with a concurrency limit
   (default 3 **[assumed]**); as tasks complete, newly-unblocked tasks
   auto-dispatch if the toggle is on.

### Review: one place to close the loop

Per finished run: diff view (`git diff <base>...<branch>`, Monaco-style
side-by-side), agent conversation replay, cost/turns. Actions:

- **Request changes** — free-text feedback resumes the same session (`resume` +
  session id) in the same worktree.
- **Merge** — squash-merge branch into base locally (configurable strategy),
  delete worktree+branch, task → `done`.
- **Open PR** — `gh pr create` from the branch; task carries the PR URL; daemon
  polls PR state and flips task → `done` on merge. Works without `gh`/remote
  (button simply hidden).
- **Discard** — remove worktree + branch, task back to `todo` with a note.

### Status at a glance

Board (columns = status) and list views; epic rollups; a "Running now" rail
showing live runs with cost tickers; blocked tasks show their blockers.
Everything updates over WebSocket.

### Agent collaboration (requirement added 2026-07-19)

Agents must be able to work _with_ each other, not just in parallel: an agent
working a task should be able to discover that other agents are running, see
what they are working on, and exchange messages with them.

Design (daemon as the hub — no direct agent-to-agent transport):

- **Awareness.** The daemon's run registry is exposed to agents via MCP:
  `run_list` returns every live run (task id, title, branch, worktree, status,
  started-at). Dispatched agents get a prompt note telling them the tool exists
  and when to check it (e.g., before touching shared files). Task frontmatter
  (`status: in-progress`, `assignee: agent`) plus the Activity log remain the
  durable, git-visible record of who is doing what.
- **Messaging.** Two channels, both mediated by the daemon:
  1. **Task-scoped (durable):** `task_comment` on any task — the shared
     blackboard. An agent blocked on a neighbor's work comments on that
     neighbor's task; the daemon notifies the addressee's live session.
  2. **Direct (ephemeral):** `agent_message(run_id, text)` — daemon-routed
     mailboxes, delivered by injecting a user-turn message into the target run's
     streaming-input session (the Agent SDK supports mid-run message injection).
     Undelivered messages queue until the run's next turn; messages to finished
     runs bounce with a pointer to the task's Activity.
- **Conflict avoidance.** Worktree isolation already prevents file-level
  collisions; awareness + messaging handle the semantic ones (interface
  contracts, shared task files, sequencing). The ready-queue remains the only
  scheduler — agents coordinate, they do not dispatch each other (MCP
  `run_dispatch` stays deferred).

Precedent: Claude Code's experimental agent teams use exactly this shape (shared
task list + mailbox messaging). Phasing: awareness (`run_list`, prompt note)
lands in Phase 4 with the orchestrator; messaging (`agent_message`, comment
notifications) lands in Phase 5 alongside parallel epic dispatch, where it first
becomes load-bearing.

## 6. Interfaces

### CLI (`dispatch`)

`init` (scaffold .dispatch/ + config.yml, register the MCP server in .mcp.json)
· `ui` (start daemon if needed, open browser) · `serve` (daemon foreground) ·
`task create|list|show|edit|status|next` · `plan "<prompt>"` · `run <task-id>` ·
`runs [--watch]` · `mcp` (stdio MCP server) · `doctor [--rebuild]` (cache
rebuild, orphan cleanup, env checks). JSON output via `--json` on every read
command (agents love this — Beads' lesson).

### MCP (stdio, official TS SDK)

Consolidated tools (small surface beats API mirror): `task_list` (filters +
pagination), `task_get`, `task_save` (upsert, `idempotentHint`), `task_comment`
(append to Activity), `task_next` (ready-work). All reads `readOnlyHint`;
structured content + `outputSchema`. MCP resources: `workflow://onboarding` (how
to use the tracker — backlog.md's proven pattern) and `task:///{id}`.
`dispatch init` writes the server into the project's `.mcp.json` so any Claude
Code session in the repo can use it. Run-control tools (`run_dispatch`)
deferred.

### REST/WS (loopback only)

`/api/tasks…`, `/api/runs…`, `/api/plan`, `/ws` (events: task.updated,
run.event, run.log-entry, approval.requested). Loopback bind + random token
handshake from CLI-to-daemon to keep other local processes out. This API is the
contract future TUI/Tauri clients build against.

## 7. Error handling & recovery

- **Daemon crash / reboot**: boot reconciliation marks in-flight runs `failed`
  (resumable via session id), prunes orphaned worktrees (VK pattern), rebuilds
  cache if schema/hash mismatch.
- **Agent failure/timeout/budget-hit**: run → `failed` with reason; task stays
  previous status with Activity note; worktree preserved for inspection; "retry"
  = new run, same branch, resumed or fresh session.
- **Cache corruption**: cache is disposable by design — `doctor --rebuild`.
- **Merge conflicts on task files** (multi-dev, later): per-task files make
  conflicts rare and local; ID hash scheme prevents collisions; Activity merges
  as append-union via `.gitattributes` union driver.
- **Port conflicts**: daemon picks a free port, records it in
  `~/.dispatch/daemon.json`; clients discover from there.

## 8. Testing strategy

- `core`: vitest unit tests — frontmatter round-trip, ID generation/uniqueness,
  graph/ready-work logic, cache derivation, watcher debounce. Property-ish tests
  on parse(serialize(x)) = x.
- `server`: integration tests against temp git repos with a **FakeExecutor**
  (scripted normalized-entry streams + scripted worktree commits) — run
  lifecycle, approvals, reconciliation, review actions, no API keys needed in
  CI.
- `mcp`/`cli`: golden-output tests over temp repos.
- E2E smoke (opt-in, real Claude Code, local only): plan → dispatch → review on
  a toy repo.

## 9. Build phases (each independently useful)

1. **Core + CLI tracker** — task format, IDs, graph, store, cache, watcher;
   `init/task */next/doctor`. Usable as a git-native tracker on day one.
2. **Daemon + Web UI** — REST/WS, board/list/detail, create/edit. "Open the app,
   see everything."
3. **MCP server** — agents can read/write tasks; `.mcp.json` wiring.
4. **Orchestrator MVP** — single dispatch: worktree, Agent SDK executor, live
   log view, approvals, Stop handling, review (diff +
   merge/discard/request-changes). _The product moment._
5. **Planner + parallelism** — plan-confirm flow, epic dispatch with ready-queue
   concurrency, PR flow + polling.
6. **Hardening + release** — doctor, reconciliation edge cases, docs, `npx`
   packaging, license/CI.

Adapters, multi-dev sync UX, other executors, TUI/Tauri: post-v1, all behind
interfaces named above.

## 10. Open questions for the user

1. Name. "Dispatch" is a placeholder.
2. ~~Form factor~~ — settled 2026-07-19: web first, Tauri 2 desktop shell after
   the UI is fleshed out (see §2 Form factor).
3. Default permission mode for runs: `acceptEdits` (assumed) vs
   `bypassPermissions` (VK's default posture) vs always-ask.
4. `autoCommit` for task-file changes: off (assumed) vs on.
5. Apache-2.0 (assumed) vs MIT.
6. ~~Runtime~~ — settled 2026-07-19: Bun (bun-typescript-monorepo template
   adopted at repo root).
