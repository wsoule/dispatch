---
id: t-332ffe
title: Expose planner conversation over the server API and client SDK
status: in-review
kind: task
parent: e-359627
milestone: null
blocked-by:
  - t-c8954b
labels: []
priority: high
assignee: none
created: 2026-07-26T19:06:42.662Z
updated: 2026-07-26T20:40:34.084Z
external: null
---

## Description

Add HTTP endpoints in packages/server/src/api.ts to post a follow-up message to an existing plan and receive the assistant turn plus the updated working proposal (streaming if the existing infra supports it, otherwise turn-based polling consistent with how planRecord is fetched today). Mirror these with typed methods in @dispatch/client so apps/desktop can call them the same way it calls handleSubmitPrompt/handleConfirmPlan via useDispatchProject.ts.

Acceptance criteria:

- A new API route accepts a follow-up message for a given plan id and returns the assistant response plus the current working PlanProposal
- The @dispatch/client SDK exposes a typed method (e.g. sendPlanMessage) matching the new route, alongside the existing plan/confirm methods
- useDispatchProject.ts surfaces the conversation call so views can invoke it, following the existing handleSubmitPrompt pattern
- Error and 'plan not found' cases return actionable messages consistent with OrchestratorClientError conventions
- Server-side test covers the new endpoint round-trip against FakePlanner

## Acceptance Criteria

## Activity
- 2026-07-26T20:28:00.150Z dispatched (claude, branch dispatch/t-332ffe-expose-planner-conversation-over-the-ser-3a34e9)
- 2026-07-26T20:31:07.961Z Starting. Reviewed api.ts, plan.ts, planner.ts, FakePlanner/ClaudePlanner, client SDK, and useDispatchProject.ts. The multi-turn conversation backend (sibling t-c8954b) is not merged into main, so this task's Planner interface is still one-shot. Plan: extend the Planner seam with a `converse()` method (implemented in both FakePlanner + ClaudePlanner), add PlanManager.sendMessage (stores conversation on PlanRecord, requires state 'ready'), expose it as POST /api/plan/:id/message returning {message, proposal}, mirror as client `sendPlanMessage`, surface `handleSendPlanMessage` in useDispatchProject, and cover the round-trip with a FakePlanner server test. Turn-based (awaited reply), consistent with how confirm() works today.
- 2026-07-26T20:40:18.282Z Done — committed 57c2000 on the task branch. Added a multi-turn conversation seam: Planner.converse() (FakePlanner scriptable + ClaudePlanner real SDK), PlanManager.sendMessage() storing the conversation on PlanRecord (state 'ready' + not-confirmed required; reply proposal re-validated), POST /api/plan/:id/message → {message, proposal} (400/404/409 via existing typed-error mapping), client SDK sendPlanMessage + PlanRecord.messages/PlanMessageResult types, and handleSendPlanMessage in useDispatchProject. Turn-based (awaits the planner turn like confirm()), broadcasts plan.changed. Tests: PlanManager.sendMessage unit + POST /api/plan/:id/message HTTP round-trip vs FakePlanner. Verified: full server suite (241 pass) + client (23 pass), tsc clean on server/client/desktop, format + lint (0 errors). NOTE: this task's base branch does not include the sibling backend task t-c8954b (blockedBy), so the conversation backend here is self-contained; integration with t-c8954b's seam may need reconciliation at merge time.
- 2026-07-26T20:40:34.084Z [run r-3a34e9] finished: finished — 10 files, $6.44
