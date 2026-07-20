# Phase 5: Planner + Parallelism Implementation Plan

**Goal:** The big-prompt flow (prompt → proposed epic/tasks → confirm → files
written), epic-level parallel dispatch with a concurrency-limited ready queue,
the PR review path, and the messaging half of agent collaboration
(`agent_message`).

**Spec basis:** §5 Plan flow (confirm-before-write is sacred), §5 Dispatch step
6 (epic ready-queue, concurrency default 3 [assumed]), §5 Review (PR via `gh` +
polling), §5 Agent collaboration (messaging half).

## Global Constraints

- Planner proposals are NEVER written without an explicit confirm call. Proposal
  shape:
  `{ epic?: { title, description }, tasks: { title, description, acceptanceCriteria: string[], blockedByIndices: number[], priority }[] }`
  — indices refer within the proposal; ids are minted only at confirm time.
- Planner runs one-shot in the MAIN checkout, read-only (SDK
  `permissionMode: 'plan'`, no worktree, structured output via the SDK's
  json-schema output). Separate seam from the task Executor:
  `src/orchestrator/planner.ts` with a `Planner` interface + `FakePlanner`
  (tests) + `ClaudePlanner` (SDK). CI never calls the real one.
- Epic dispatch engine lives in the orchestrator:
  `startEpic(epicId, { concurrency = 3 })` dispatches ready child tasks up to
  the limit; on each run reaching terminal state, newly-ready children
  auto-dispatch while the epic session is active; `stopEpic` halts new
  dispatches (live runs continue). Engine state is registry-only
  (machine-local); epic Activity gets start/stop/complete lines.
- PR review action: capability-detected (`gh` on PATH +
  `git remote get-url origin` succeeds → health payload gains `pr: boolean`).
  Action `{ action: 'pr' }` on a finished run: push branch,
  `gh pr create --title "<task title>" --body <generated>`, PR URL → task
  Activity + run meta; poller (60s) flips task → done + cleanup when merged. No
  remote/gh → 409 with clear message.
- Messaging: MCP tool `agent_message` `{ runId?, taskId?, text }` (exactly one
  target) — daemon-proxied like run_list; daemon injects into the live run via
  the existing ExecutorRun.send() (which the SDK streaming-input already
  supports). taskId targets that task's live run. No live target → clean error
  listing live runs. Sender identity: the calling agent's own run is unknown to
  MCP — messages are injected prefixed `[message from another agent] <text>`;
  deliver-to-self is fine (harmless). Deviation from spec (record):
  watcher-based comment notifications deferred — `task_comment` remains
  file-only; `agent_message` is the live channel.
- New endpoints: `POST /api/plan` `{ prompt }` → 202 `{ planId }` + WS
  `plan.changed` events → `GET /api/plan/:id` (state: running|ready|failed,
  proposal?) → `POST /api/plan/:id/confirm` `{ proposal }` (server validates
  shape + re-validates statuses/priorities, writes epic+tasks with wired
  blockedBy, returns created ids) · `POST /api/epics/:id/dispatch`
  `{ concurrency? }` / `POST /api/epics/:id/stop` ·
  `GET /api/epics/:id/progress` (children by status, live runs) · run review
  action gains `'pr'` · `POST /api/runs/:id/inject` `{ text }` used by
  agent_message (distinct from /message which is the human channel — inject
  prefixes the another-agent marker).
- Config: `orchestrator.epicConcurrency?` (default 3, validated ≥1).

## Slice P1: server (planner, epic engine, PR, messaging)

Modules: `orchestrator/planner.ts` (+ `planners/fake.ts`, `planners/claude.ts`),
`orchestrator/epic.ts`, PR bits in `orchestrator/review.ts` (or wherever O1 put
review actions — follow its structure), api.ts/events.ts additions, MCP
`agent_message`. Tests (FakePlanner/FakeExecutor, real git repos): plan
lifecycle (prompt → ready proposal → confirm writes epic+tasks with correct
blockedBy wiring from indices; confirm validates + rejects bad shapes;
double-confirm 409); epic engine (concurrency respected under 5 ready children
with limit 2 — assert never >2 live; unblock cascade dispatches; stop halts new,
running finishes; epic completion Activity); PR path with a STUBBED gh/git
(inject a command-runner seam into the PR module — assert push+create
invocations + URL capture; poller flips on merged state via stub; capability
detection both ways); inject/message routing (runId + taskId targeting,
no-live-target error, prefix applied); MCP agent_message both daemon states.

## Slice P2: desktop UI

- Plan flow in the Tasks tab: prompt composer ("Plan work…"), progress state,
  proposal review screen — editable titles/descriptions/priorities, removable
  tasks, visible dependency arrows (indices), confirm/cancel. Confirm → board
  refresh (tasks appear).
- Epic cards: "Work this epic" (concurrency stepper, default from config), live
  progress (x/y done, active runs), stop.
- PR: button on finished-run review surface when health.pr; PR link chip on task
  detail; merged-state auto-refresh.
- Follow Relay tokens; reuse run components from O3. Client package gains
  plan/epic/inject APIs.
- Tests: client API units; proposal-editing reducer logic unit-tested; build
  green.

## Wrap-up (controller)

Roadmap/spec deviation notes (comment-notify deferral), whole-branch review
(empirically drive plan→confirm→epic dispatch→messaging with fakes), fix wave,
merge.
