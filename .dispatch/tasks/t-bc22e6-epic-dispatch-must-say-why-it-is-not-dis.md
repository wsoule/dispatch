---
id: t-bc22e6
title: Epic dispatch must say why it is not dispatching
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - ui
priority: medium
assignee: none
created: 2026-08-11T17:28:24.573Z
updated: 2026-08-11T17:28:24.573Z
external: null
writes: []
---

## Description

Live repro 2026-08-11: e-b7ca6f's epic dispatch started (concurrency 3) and then went silent for an hour — its only ready child (t-e1548f) had `writes: []`, so fillQueue's conservative rule ("an undeclared task waits on ANY live claim") parked it while six unrelated agents held claims. Nothing surfaced this: the epic activity showed "dispatch started" and nothing else; the board showed todo; no session line said "waiting: t-e1548f blocked by claims from r-2d522b, r-b23d3a…".

When fillQueue skips every ready child, append/emit why — per skipped task, name the rule (undeclared writes vs a concrete claim conflict) and the run(s) holding the claims — to the epic's activity or the session record so the LiveRail/epic view can show "waiting on claims" instead of silence. Also worth a nudge in the task-create/plan flow toward declaring writes, since `writes: []` is what triggers the blanket wait.

## Acceptance Criteria

## Activity
