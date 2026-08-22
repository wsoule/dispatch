---
id: e-16ef06
title: "Builder front door: prompt box over the planner, locally"
status: todo
kind: epic
parent: null
milestone: null
blocked-by:
  - e-3a6884
  - e-a27691
labels:
  - lovable-direction
  - builder
priority: high
assignee: none
created: 2026-08-22T16:44:05.657Z
updated: 2026-08-22T16:44:05.657Z
external: null
writes: []
---

## Description

Spec: docs/design/lovable-workstreams.md (2026-08-22) — cell 2 of docs/design/lovable-direction.md, the sleeper. The empty/first-run state becomes a single prompt box — "what do you want to change?" — over the existing planner (packages/server/src/orchestrator/planner.ts), showing the proposed task graph inline and dispatching on confirm. Mostly information architecture over machinery that exists; no Modal, no code.storage. This is the free tier's viral surface.

Decisions: the prompt box files REAL tasks through the normal store, so a builder project's work is inspectable from the engineer lens with zero translation; the graph preview shows what will be created (milestone + tasks, writes, order) and dispatches only on confirm — autonomy stays scoped and recorded; after dispatch the per-run preview is the stage. Blocked by the lens epic (builder shell) and the preview epic (the stage).

## Acceptance Criteria

## Activity
