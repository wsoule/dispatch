---
id: t-5fca01
title: "Builder shell: prompt-and-preview stage layout behind the lens switch"
status: todo
kind: task
parent: e-3a6884
milestone: null
blocked-by:
  - t-fb96ec
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:44:12.600Z
updated: 2026-08-22T16:44:42.890Z
external: null
writes:
  - apps/desktop/src/**
---

## Description

App-side lens switch: engineer lens is exactly today's UI, selected explicitly; builder lens renders a minimal stage layout — prompt area and preview surface front and center, board/diff/findings reachable but demoted. Settings gains the lens escape hatch. Ships empty-but-real: the prompt area is inert until the builder front-door epic wires the planner in. Both lenses read the same daemon state; switching re-renders, migrates nothing.

## Acceptance Criteria

## Activity
