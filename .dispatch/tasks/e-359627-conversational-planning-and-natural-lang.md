---
id: e-359627
title: Conversational planning and natural-language task creation
status: done
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-26T19:06:42.656Z
updated: 2026-08-03T23:19:05.590Z
external: null
writes: []
---

## Description

Today the planner is one-shot (Planner.plan(prompt) -> PlanProposal in packages/server/src/orchestrator/planner.ts, surfaced in apps/desktop/src/views/PlansView.tsx) and plain task creation is a structured form (apps/desktop/src/components/tasks/CreateTaskModal.tsx opened from the header button, board column "+", and command palette). The user wants two things: (1) the ability to converse with the planner agent — refine a proposal across multiple turns instead of a single prompt-in/proposal-out call; and (2) a better, Linear-style task-adding experience where you open a full page and describe what you want in natural language, mirroring the planner page rather than filling out a modal form. Both features replace one-shot/structured input with multi-turn, natural-language input driven by the Agent SDK, so they share a conversation backend. This epic delivers the shared backend, the conversational planner UI, and the natural-language full-page task creator, while keeping the existing modal as a quick-add fallback.

## Acceptance Criteria

## Activity
- 2026-07-26T19:06:54.991Z [epic] epic dispatch started (concurrency 5)
