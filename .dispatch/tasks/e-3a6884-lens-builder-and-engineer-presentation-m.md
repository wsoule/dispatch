---
id: e-3a6884
title: "Lens: builder and engineer presentation modes"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - lovable-direction
  - lens
priority: medium
assignee: none
created: 2026-08-22T16:43:43.247Z
updated: 2026-08-22T16:43:43.247Z
external: null
writes: []
---

## Description

Spec: docs/design/lovable-workstreams.md (2026-08-22), from docs/design/lovable-direction.md. Lens is which surfaces you see: builder (prompt box + live preview are the stage) or engineer (board, diffs, findings, merge queue; preview docked beside the diff). Lens is per-project, set by which front door created the project (prompt → builder, cloned repo → engineer), with a settings escape hatch to switch any time; both lenses read the same state so switching migrates nothing. Mixed teams (different members in different lenses on one project simultaneously) are explicitly out of scope.

This epic is the decomposition only: a lens field on the project, an engineer preset that is exactly today's UI, and a builder shell whose stage is prompt box + preview. The builder shell ships empty-but-real — the builder front-door epic fills it.

## Acceptance Criteria

## Activity
