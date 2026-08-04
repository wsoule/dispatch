---
id: t-d6c287
title: Add a natural-language single-task creation endpoint
status: done
kind: task
parent: e-359627
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-26T19:06:42.666Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Add a backend path that turns a free-text description of one task into a structured task (title, description, acceptance criteria, priority) by reusing the existing planner/Agent-SDK infrastructure constrained to a single task, exposed via api.ts and the @dispatch/client SDK. This is the natural-language equivalent of what CreateTaskModal collects manually and feeds the same TaskStore.create path used by handleCreate in useDispatchProject.ts.

Acceptance criteria:

- An API route accepts a free-text task description and returns a single structured task draft (title, description, acceptanceCriteria, priority) the user can review before saving
- The draft is produced by reusing the existing planner/Agent-SDK code rather than a parallel implementation, and validates against the same priority enum and required-field rules
- The @dispatch/client SDK exposes a typed method for it and useDispatchProject.ts surfaces it next to handleCreate
- The returned draft can be saved through the existing createTask/handleCreate path with no schema changes
- A test covers free-text-in / structured-task-out using the fake planner

## Acceptance Criteria

## Activity
- 2026-07-26T19:06:55.525Z dispatched (claude, branch dispatch/t-d6c287-add-a-natural-language-single-task-creat-020122)
- 2026-07-26T19:09:57.149Z Starting: NL single-task draft endpoint. Design: reuse the existing Planner seam (ClaudePlanner/FakePlanner) via a new PlanManager.draftTask(prompt) that calls the registered planner, validates the proposal with the same validatePlanProposal rules, and returns the first task as a TaskDraft {title, description, acceptanceCriteria[], priority}. Exposed at POST /api/tasks/draft, added to @dispatch/client as draftTask() + a pure taskDraftToCreateInput() mapper (acceptanceCriteria[] -> bullet string), and surfaced as handleDraftTask next to handleCreate in useDispatchProject.ts. No core schema changes. Tests use FakePlanner (server unit + api round-trip, client SDK).
- 2026-07-26T19:18:14.402Z Done, committed df728f5. Implemented:
- POST /api/tasks/draft (api.ts) — free text -> single TaskDraft {title, description, acceptanceCriteria[], priority}; optional `planner` field with same 400-on-unknown contract as startPlan/createRun.
- PlanManager.draftTask (plan.ts) reuses the registered Planner seam (ClaudePlanner/FakePlanner) + validatePlanProposal; returns the proposal's first task; 400s on no-task/invalid-priority. New TaskDraft type in planner.ts.
- @dispatch/client: typed draftTask() + pure taskDraftToCreateInput() mapper (folds acceptanceCriteria into description because TaskStore.create only renders the description section — mirrors buildTaskDescription; no core/store schema change). Exported from index.ts.
- useDispatchProject.ts: handleDraftTask surfaced next to handleCreate (read-only, no cache invalidation until save).
Tests (all FakePlanner-backed): PlanManager.draftTask unit tests; POST /api/tasks/draft integration incl. free-text-in/structured-out + draft->createTask round trip asserting the rendered task body; taskDraftToCreateInput mapper tests.
Verification: server 237 pass / client 25 pass; tsc clean for server/client/desktop; format + lint 0 errors (pre-commit hooks green). NOTE: worktree needed `bun install` + `bun run build` first (dist/ was absent) for @dispatch/* resolution.
- 2026-07-26T19:18:29.738Z [run r-020122] finished: finished — 9 files, $5.94
- 2026-07-26T22:09:46.953Z run r-020122 merged into main
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
