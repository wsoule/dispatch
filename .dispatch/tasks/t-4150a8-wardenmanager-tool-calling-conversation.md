---
id: t-4150a8
title: "WardenManager: tool-calling conversation session"
status: in-progress
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-f8358c
labels: []
priority: high
assignee: none
created: 2026-08-04T18:06:37.198Z
updated: 2026-08-04T19:02:30.750Z
external: null
writes:
  - packages/server/src/orchestrator/warden.ts
  - packages/server/test/orchestrator/warden.test.ts
risk: elevated
---

## Description

New session manager mirroring PlanManager's start/sendMessage/running-ready-failed bookkeeping and in-memory transcript, but driving a real Claude Agent SDK tool-calling loop against Task 1's tool registry instead of PlanManager's structured-JSON-proposal turn. Any mutating tool call a turn produces is collected as `pendingActions` on the record rather than auto-executed. Exposes `confirmAction(id, approve)`: on approve, calls the registry's applyAction and appends the real result to the transcript; on deny, appends a denial note and never calls it.

Acceptance criteria:

- New WardenManager class (e.g. packages/server/src/orchestrator/warden.ts) with start(prompt)/sendMessage(id, text)/confirmAction(id, actionId, approve)/get(id), all in-memory like PlanManager (no durability requirement across a daemon restart)
- A turn that calls a mutating tool leaves the record in a state exposing that pending action's summary and required confirmation, with the tool call itself not yet applied
- confirmAction(..., approve: true) calls applyAction and folds its real result into the transcript; confirmAction(..., approve: false) never calls applyAction and records a denial
- A fake/stub tool-calling backend (mirrors planners/fake.ts) lets tests exercise the full turn + confirm flow deterministically, without a live LLM call

## Acceptance Criteria

## Activity
- 2026-08-04T18:56:39.331Z dispatched (claude, branch dispatch/t-4150a8-wardenmanager-tool-calling-conversation-96f433) — none
- 2026-08-04T19:01:19.788Z dispatched (claude, branch dispatch/t-4150a8-wardenmanager-tool-calling-conversation-02a09e) — human:wsoule679
- 2026-08-04T19:01:31.740Z [run r-02a09e] stop requested — human:wsoule679
- 2026-08-04T19:01:53.572Z [run r-02a09e] cancelled — human:wsoule679
- 2026-08-04T19:02:30.750Z Design settled after reading plan.ts/planner.ts/planners/{fake,claude}.ts and Task 1's wardenTools.ts. Shape: `orchestrator/wardenBackend.ts` (the seam — WardenBackend.start/sendMessage taking a WardenToolset the manager owns), `orchestrator/warden.ts` (WardenManager: start/sendMessage/confirmAction/get/list, in-memory, running->ready|failed like PlanManager), `orchestrator/wardens/fake.ts` (scripted tool calls + replies), `orchestrator/wardens/claude.ts` (real Agent SDK loop via createSdkMcpServer + tool(), the registry's zod schemas wired in-process, no Read/Bash/Edit at all). The manager owns the toolset callback so a mutating call routes to registry.callMutatingTool (queues a WardenAction, returns "awaiting human confirmation" to the model) and only confirmAction(...,true) ever reaches applyAction. Reusing config.models.plan for the model role rather than adding a `warden` role to core's ModelConfig (avoids a cross-package config/settings change this task doesn't need). — none
