---
id: t-f8358c
title: "Warden tool registry: status + mutating action tools"
status: in-progress
kind: task
parent: e-1d70ca
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-04T18:06:37.196Z
updated: 2026-08-04T18:10:47.037Z
external: null
writes:
  - packages/server/src/orchestrator/wardenTools.ts
  - packages/server/test/orchestrator/wardenTools.test.ts
risk: elevated
---

## Description

New module implementing the warden's private tool surface against `OrchestratorContext` (store/cache/orchestrator/events) — status tools (live+recent runs, ready/blocked tasks, merge queue, pending approvals, open questions, ledger entries) reusing the same data `OverviewView`'s feed already reads, plus mutating tools (dispatch_task, approve_run, deny_run, cancel_run, dequeue_merge, message a live run). Mutating tools only build a `WardenAction` descriptor (id, tool name, input, human-readable summary) — none of them perform the real effect yet; a separate `applyAction(id)` does that, added here but not called by anything live until Task 2.

Acceptance criteria:

- New file (e.g. packages/server/src/orchestrator/wardenTools.ts) exports a status tool set and a mutating tool set, typed and zod-validated the same way packages/mcp/src/tools.ts validates its inputs
- Mutating tool calls never perform their effect directly — they return a pending WardenAction; applyAction(id) is the only path that calls the real orchestrator/store mutation
- Unit tests cover each status tool's shape and each mutating tool's pending-descriptor + applyAction execution, including a not-found/invalid-target case per mutating tool
- No changes to packages/mcp — this tool set is not registered there and is not reachable by task-running agents

## Acceptance Criteria

## Activity
- 2026-08-04T18:07:39.220Z dispatched (claude, branch dispatch/t-f8358c-warden-tool-registry-status-mutating-act-38d3e7) — none
- 2026-08-04T18:10:47.037Z Starting. Surveyed the seams this needs: OrchestratorContext (orchestrator.ts:76) carries store/cache/events but NOT mergeQueue/questions/ledgerStore — those live on ApiContext (api.ts:104). Plan: wardenTools.ts defines its own WardenToolContext bundling orchestrator + the three registries, so it stays constructible in tests without booting an API. Pending approvals are only reachable today via RunRegistry.getPendingApproval(runId) (no listing), so adding two additive read-only accessors to Orchestrator/RunRegistry. No packages/mcp changes. — none
