---
id: e-ac6705
title: "Run-lifecycle resilience: no state may lie about whether work happened"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - resilience
priority: high
assignee: none
created: 2026-08-23T15:11:43.264Z
updated: 2026-08-23T15:11:43.264Z
external: null
writes: []
---

## Description

Groups the resilience bugs surfaced by the 2026-08-22/23 dogfooding marathon, all one family: a run/loop/request state that reads as success or simply vanishes when the underlying work did not happen. Members: t-350f21 (fix-loop settles complete after its review run died), t-ed735b (zero-turn resume finishes green), t-b2d83a (pending scope/approval requests lost on daemon restart), t-8f336a (resume silently starts a fresh session, losing conversation), t-bb4d21 (daemon main-thread busy-loop, unresponsive but alive). t-050819 (boot auto-resume, merged 2026-08-23) was the first of the family. Common thread: terminal-state bookkeeping is stamped optimistically (at dispatch/attempt time) rather than confirmed against what actually ran — fix the family with shared invariants and tests, not five point patches.

## Acceptance Criteria

## Activity
