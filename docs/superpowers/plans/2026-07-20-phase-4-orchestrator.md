# Phase 4: Orchestrator MVP Implementation Plan

**Goal:** Dispatch an agent on a task from the desktop app: worktree
provisioned, Claude Code runs via the Agent SDK, live log + approval cards
stream into the UI, and a finished run gets a review surface (Pierre diff + file
tree) with merge / discard / request-changes. Plus the Phase-4 half of agent
collaboration: `run_list` awareness.

**Spec basis:** §5 Dispatch/Review flows, §5 Agent collaboration (awareness
half), §7 error handling, research §3 (SDK capabilities, Vibe Kanban patterns).
Executor abstraction isolates the SDK exactly as spec §2 requires.

## Global Constraints

- Runs are machine-local (spec §4): run metadata + normalized-entry JSONL
  transcripts under `DISPATCH_HOME`-aware
  `~/.dispatch/runs/<rootHash>/<runId>.jsonl`; registry in-memory in dispatchd,
  transcripts survive restart for read-only replay (boot reconciliation marks
  interrupted runs `failed`). Nothing run-related is written into the repo
  except task Activity lines.
- Worktrees: `~/.dispatch/worktrees/<rootHash>/<runId>` on branch
  `dispatch/<taskId>-<slug>`, base = repo's current default branch. Vibe Kanban
  hygiene: prune stale worktrees + retry-once on add, orphan cleanup at boot.
- Run lifecycle states (exact strings):
  `provisioning → running → awaiting-approval ⇄ running → finished | failed | cancelled`.
  Terminal runs keep worktrees until review action (merge/discard) removes them;
  `request-changes` resumes into the same worktree/branch.
- Run ids: `r-` + 6 hex (core `generateTaskId` pattern — add `generateRunId()`
  to core ids.ts).
- On run finish: task Activity gains
  `- <iso> [run <runId>] finished: <state> — <files changed> files, $<cost>` and
  task status → `in-review` (only from `in-progress`); on dispatch: status →
  `in-progress`, Activity `dispatched (<executor>, branch <branch>)`.
- Catalog additions: `@anthropic-ai/claude-agent-sdk` (pin exact latest
  0.3.x/newer — check bun info), `@pierre/diffs` `1.2.12`, `@pierre/trees`
  `1.0.0-beta.5`.
- The SDK executor must run under Bun (dispatchd's runtime). If the SDK proves
  Bun-incompatible at implementation time, STOP and report (fallback design
  exists: spawn `claude -p --output-format stream-json` directly behind the same
  Executor interface) — do not silently ship a broken executor.
- Default permission mode `acceptEdits` **[spec assumption, still
  user-unconfirmed]**; per-run caps from `.dispatch/config.yml` new optional
  block
  `orchestrator: { maxTurns?: number, maxBudgetUsd?: number, permissionMode?: string }`
  (config loader extends with validation; defaults: 100 turns, no budget cap,
  acceptEdits).

## Slice O1: orchestrator core in @dispatch/server (FakeExecutor only)

**New modules:**
`src/orchestrator/{types.ts,registry.ts,worktree.ts,transcript.ts,orchestrator.ts,executors/fake.ts}`,
API additions in api.ts, events in events.ts.

**Executor interface (the load-bearing seam):**

```ts
export interface ExecutorRun {
  interrupt(): Promise<void>;
  send(message: string): void; // mid-run user message
  approve(requestId: string, allow: boolean): void;
}
export interface ExecutorEvents {
  onEntry(e: NormalizedEntry): void; // assistant_text | tool_use | thinking | usage
  onApprovalRequest(r: {
    requestId: string;
    toolName: string;
    input: unknown;
  }): void;
  onFinish(f: {
    state: 'finished' | 'failed';
    costUsd?: number;
    turns?: number;
    sessionId?: string;
    error?: string;
  }): void;
}
export interface Executor {
  start(
    opts: {
      cwd: string;
      prompt: string;
      resumeSessionId?: string;
      permissionMode: string;
      maxTurns: number;
      maxBudgetUsd?: number;
    },
    events: ExecutorEvents
  ): ExecutorRun;
}
```

NormalizedEntry:
`{ ts, kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage', text?, toolName?, toolInput?, status?: 'running'|'done'|'error' }`
— the Vibe Kanban pattern; every entry appended to the run transcript JSONL and
broadcast as WS `run.log`.

**Endpoints:** `POST /api/tasks/:id/runs` (409 if task already has a live run;
body `{ executor?: 'fake' | 'claude' }` default claude — O1 registers only fake,
claude arrives O2) · `GET /api/runs` (live + recent, incl. task id/title, state,
branch, cost) · `GET /api/runs/:id` (meta + transcript entries) ·
`POST /api/runs/:id/approval` `{ requestId, allow }` ·
`POST /api/runs/:id/message` `{ text }` (live run → send; finished run +
`{ resume: true }` → request-changes: re-dispatch same worktree/branch with
resumeSessionId) · `POST /api/runs/:id/cancel` · `GET /api/runs/:id/diff` →
`{ patch: string, files: { path, status }[] }` (unified diff
`git diff <mergeBase>...HEAD` in the worktree + name-status) ·
`POST /api/runs/:id/review` `{ action: 'merge' | 'discard' }` — merge:
squash-merge branch into base in the MAIN checkout (refuse with 409 if main
checkout dirty), task → done, worktree+branch removed; discard: worktree+branch
removed, task → todo, Activity note. **WS events:** `run.changed` (any
lifecycle/registry change), `run.log` `{ runId, entry }`, `approval.requested`
`{ runId, requestId, toolName }`. **Boot reconciliation:** transcripts with
non-terminal last state → mark failed (resumable later via sessionId in
transcript header); worktree dir scan → prune orphans not in any transcript.
**Tests (FakeExecutor, real temp git repos with an initial commit):** full
lifecycle happy path incl. Activity/status writes; approval round-trip; cancel;
request-changes resume reuses branch; merge squashes into base and closes task
(assert real git log); merge refused on dirty main checkout; discard restores
todo; diff endpoint returns a real patch; boot reconciliation; 409
double-dispatch.

## Slice O2: ClaudeExecutor + run_list awareness

- `executors/claude.ts`: Agent SDK `query()` with streaming input; map SDK
  stream → NormalizedEntry; `canUseTool` → approval flow (respecting
  permissionMode: acceptEdits auto-allows edits, everything else per SDK
  semantics; deny reasons sent back); capture sessionId for resume;
  maxTurns/maxBudgetUsd passed through; result usage → cost. Prompt assembly:
  task file content + parent epic title/description + acceptance criteria + repo
  conventions pointer + collaboration note ("other agents may be working: check
  `run_list` via the dispatch MCP server; log progress with task_comment; the
  task's Activity is the shared record") + instruction to commit work before
  finishing. Worktrees inherit the project's committed `.mcp.json`, so the
  dispatch MCP tools are already available to the agent — the prompt references
  them, no extra wiring.
- Stop-hook safety net: on finish, if worktree has uncommitted changes,
  auto-commit `wip(dispatch): uncommitted changes from run <runId>`.
- `run_list` MCP tool (packages/mcp): discovers the project's daemon via the
  daemon file; healthy → GET /api/runs proxied into `{ runs: [...] }`; no daemon
  → `{ runs: [], note: 'dispatchd not running' }`. readOnlyHint. Tests with a
  live startServer instance + DISPATCH_HOME override.
- Bun-compat gate: a `test.skipIf(!process.env.DISPATCH_CLAUDE_SMOKE)`
  integration test that runs a trivial real prompt end-to-end; plus a scripted
  manual smoke documented in the report. CI never needs credentials.
- Config: orchestrator block parsing + validation (loud ConfigError like the
  rest).

## Slice O3: desktop Runs & Review UI

- Catalog: add @pierre/diffs 1.2.12, @pierre/trees 1.0.0-beta.5 (Apache-2.0 —
  record in README deps note; import their `/react` subpaths).
- Tasks tab: Dispatch button on ready tasks (executor picker later — claude
  only), live-run indicator on cards; Runs rail listing live runs (state, cost
  ticker via usage entries).
- Run view (drawer or route within project detail): chat-style normalized log
  (collapsible tool entries — follow Relay's design system), approval card
  (allow/deny with tool name + input preview), follow-up message box while
  running, cancel.
- Review view for finished runs: `PatchDiff` (unified patch from /diff) with
  `WorkerPoolContext`, changed-files `FileTree` (paths from /diff files,
  `setGitStatus` decoration), actions merge / discard / request-changes
  (textarea → /message resume). Theme the Pierre CSS vars from Relay tokens
  (Shadow DOM keeps isolation).
- WS: subscribe run.changed/run.log/approval.requested → react-query
  invalidations + live log append.
- Tests: lib-level (log entry grouping, cost accumulation helper); build green.
  Manual tauri smoke with FakeExecutor via a hidden `executor: 'fake'` dev
  toggle (keep the API param).

## Wrap-up (controller)

Roadmap/spec notes (incl. any SDK-under-Bun findings), whole-branch review
(empirical: real dispatch with FakeExecutor through the API, review actions on
real git), fix wave, merge.
