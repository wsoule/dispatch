---
id: t-fc60f4
title: "Builder progress stage: the preview is the primary feedback surface"
status: todo
kind: task
parent: e-16ef06
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:45:00.362Z
updated: 2026-08-22T16:45:00.362Z
external: null
writes:
  - apps/desktop/src/**
---

## Description

After confirm-dispatch in the builder lens, the stage shows the per-run preview (from the preview epic) as the primary surface, with compact run progress (current task, verify state, gates awaiting decision per policy) alongside. The running thing is the artifact: the user judges the agent by looking at the app, not by reading a diff — the diff stays one click away, not gone.

## Acceptance Criteria

## Activity
