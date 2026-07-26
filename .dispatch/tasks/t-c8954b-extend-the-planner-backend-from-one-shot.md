---
id: t-c8954b
title: Extend the planner backend from one-shot to a multi-turn conversation
status: done
kind: task
parent: e-359627
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-07-26T19:06:42.660Z
updated: 2026-07-26T21:45:28.997Z
external: null
---

## Description

Evolve the Planner seam in packages/server/src/orchestrator/planner.ts (and its implementations planners/claude.ts and planners/fake.ts) plus PlanManager/plan.ts so a plan is a durable conversation, not a single plan(prompt) call. Keep per-plan message history and allow follow-up user messages that refine the working PlanProposal across turns, reusing the claude-agent-sdk session/resume capability already used by ClaudePlanner (permissionMode 'plan'). Preserve the existing validatePlanProposal contract so the final confirmed proposal shape is unchanged. FakePlanner must implement the same conversational interface for tests.

Acceptance criteria:

- The Planner interface supports sending a follow-up message to an existing plan and returning the assistant's turn plus the updated/working PlanProposal, in addition to (or replacing) the initial one-shot plan() call
- PlanManager persists per-plan conversation state (message history + latest working proposal) in the plan registry alongside the existing running/ready/failed states
- ClaudePlanner reuses the Agent SDK session so follow-up turns retain prior context; FakePlanner provides a deterministic conversational stand-in
- validatePlanProposal remains the authority for the confirmed proposal and still enforces acyclic blockedByIndices, priority enum, and non-empty titles
- Existing planner unit tests pass and new tests cover a multi-turn refine-then-confirm flow

## Acceptance Criteria

## Activity
- 2026-07-26T19:06:55.018Z dispatched (claude, branch dispatch/t-c8954b-extend-the-planner-backend-from-one-shot-6c8639)
- 2026-07-26T19:11:08.382Z Starting work. Explored the planner seam: Planner.plan(prompt), PlanManager registry (running/ready/failed), ClaudePlanner (one-shot json_schema query, permissionMode 'plan'), FakePlanner (fixed proposal/error), plus client type mirrors and API routes. Plan: evolve Planner to start()+sendMessage() returning a PlannerTurn (assistant reply + working proposal + resume session id); persist per-plan message history + working proposal + sessionId on PlanRecord; ClaudePlanner resumes the SDK session per turn; FakePlanner becomes a stateless scripted conversational stand-in keyed off round-tripped sessionId. Adding POST /api/plan/:id/message route + client mirror. validatePlanProposal contract untouched. TDD, new multi-turn refine-then-confirm tests.
- 2026-07-26T19:25:36.648Z Done — committed 02bcb74 on the task branch. Summary:

- Planner seam (planner.ts): replaced plan(prompt) with start(prompt) + sendMessage(sessionId, message), both returning a new PlannerTurn { reply, proposal, sessionId }.
- ClaudePlanner: each turn is a discrete SDK query(); follow-ups pass the prior session as `resume` so context carries across turns. json_schema output now wraps { message, proposal } so one structured turn yields both the assistant reply and the plan (proposal sub-schema unchanged).
- FakePlanner: stateless deterministic conversational stand-in — supports the old single-proposal script (backward compat) and a new turns[] script; turn position rides in the round-tripped sessionId so one instance is safe across all plans.
- PlanManager (plan.ts): PlanRecord now carries messages[] transcript, plannerName, sessionId, latest working proposal; added sendMessage() (404 unknown / 409 mid-turn or confirmed) sharing a runTurn() helper with startPlan(). Every turn's proposal is re-validated via validatePlanProposal (unchanged authority — acyclic/priority/non-empty still enforced).
- HTTP + client: new POST /api/plan/:id/message (202, mirrors startPlan's watch-plan.changed contract) and client sendPlanMessage(); PlanRecord/PlanMessage mirrors updated.

Tests: new fake-planner.test.ts (6), rewritten claude-planner.test.ts for start/sendMessage/resume, +7 PlanManager multi-turn tests (refine-then-confirm, history growth, 404/409 guards), +3 HTTP tests for the message route. Full server suite 246 pass / 0 fail, client 23 pass. Verification baseline (format + lint 0 errors, tsc across server/client/desktop/cli) clean. Frontend conversational UI is out of scope (sibling epic task); this delivers the shared backend.
- 2026-07-26T19:25:49.353Z [run r-6c8639] finished: finished — 11 files, $7.73
- 2026-07-26T21:45:28.997Z run r-6c8639 merged into main
