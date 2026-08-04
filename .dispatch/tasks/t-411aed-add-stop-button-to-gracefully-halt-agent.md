---
id: t-411aed
title: Add stop button to gracefully halt agent execution
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-03T23:37:38.604Z
updated: 2026-08-04T17:38:18.638Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Add a UI button that allows users to stop a running agent execution. When triggered, the agent should gracefully finish its current operation before stopping, rather than being forcefully terminated. This requires exploring existing agent lifecycle management patterns in the codebase, implementing a stop signal mechanism, adding the UI button in the appropriate location, and ensuring proper cleanup when an agent stops.

Acceptance criteria:

- A stop button appears in the UI while an agent is running
- Clicking the stop button signals the agent to stop gracefully
- The agent finishes its current operation before stopping (does not abort mid-work)
- Agent state correctly reflects the stopped status after completion
- No in-flight requests or cleanup operations are left dangling
- Manual tests confirm the feature works end-to-end for a sample agent execution

## Acceptance Criteria

## Activity
- 2026-08-03T23:37:50.131Z dispatched (claude, branch dispatch/t-411aed-add-stop-button-to-gracefully-halt-agent-aef398) — human:wsoule679
- 2026-08-03T23:43:40.264Z Design confirmed via ask_user: graceful Stop lands the run in its NORMAL terminal state (finished/failed) with a `stopRequestedAt` marker on RunMeta (so review/merge/auto-commit paths stay untouched); Stop sits ALONGSIDE the existing hard Cancel; and a stop auto-escalates to a hard cancel if the agent keeps calling tools past a timeout. — none
- 2026-08-04T00:43:54.589Z Done, committed as 5770f8e (server) + a621464 (desktop). Graceful stop: Orchestrator.requestStop records a `stopRequestedAt` marker (persisted on a transcript state line, so a restart mid-stop remembers), signals the executor, and arms a 2-min backstop that falls back to cancel() for an agent that ignores it. ClaudeExecutor implements it via the canUseTool gate — the in-flight tool call is untouched, every NEXT one is refused with a wrap-up instruction (checked ahead of the acceptEdits auto-allow), and the session is NOT interrupted, so the run reaches onFinish normally and handleFinish auto-commits its work. That is the whole difference from Cancel, which skips the auto-commit. ExecutorRun.requestStop is required, so ~14 test doubles got a no-op.

Self-review caught and fixed two things beyond the original scope: (1) a `provisioning` guard I had added was dead code — every creation path goes registry.create -> transition('running') -> startAndRegister in one synchronous block and reconcileOnBoot force-fails non-terminal replays, so no caller can observe that state; removed it rather than ship an untestable branch. (2) A real UI bug the browser check exposed: adding a second button pushed the run-detail header past the pane width and the old single-line row silently CLIPPED Cancel off the edge — Playwright's isVisible() reports clipped elements as visible, so only the screenshot showed it. Header now wraps; added an ancestor-clipping assertion to the manual check.

Note for whoever merges: run r-fd81a8 claims packages/server/src/api.ts, which this also touches (one new route block next to /cancel) — expect a trivial conflict there at most. Also, `DISPATCH_MCP_BIN` leaks into the environment from an installed Dispatch.app and breaks a pre-existing MCP-wiring assertion in claude-executor.test.ts; run the server suite with it unset. Unrelated to this change. — none
- 2026-08-04T00:44:11.535Z [run r-aef398] finished: finished — 34 files, $24.79 — agent:wsoule679/claude
- 2026-08-04T15:34:09.161Z [run r-d77386] finished: finished — 0 files, $5.33 — agent:wsoule679/claude
- 2026-08-04T16:40:15.163Z status → done — human:wsoule679
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
- 2026-08-04T17:38:18.638Z run r-aef398 merged into main — human:wsoule679
