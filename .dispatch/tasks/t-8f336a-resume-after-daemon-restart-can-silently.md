---
id: t-8f336a
title: Resume after daemon restart can silently start a fresh session, losing
  all conversation context
status: todo
kind: task
parent: e-ac6705
milestone: null
blocked-by: []
labels:
  - orchestrator
  - resilience
priority: high
assignee: none
created: 2026-08-23T15:11:23.949Z
updated: 2026-08-23T15:11:43.998Z
external: null
writes: []
---

## Description

Incident 2026-08-23: r-6dd770 (t-880ce2) was force-failed by a daemon restart mid-conversation (a design Q&A and a pending scope request were in its session). The user's 'ask again' message resumed it as r-ab889f — which started over from the base task prompt with NO memory of the conversation: the answered design question, the granted-in-principle scope request, and the binding amendments were all gone, silently. This is the third failure mode of the same seam: (1) t-ed735b zero-turn instant-finish, (2) lost pending approvals t-b2d83a, (3) this fresh-session-masquerading-as-resume. Root suspicion: the resume handle/session id persisted on a state line is lost or unusable across a daemon restart, and the fallback is a fresh session with resumedFrom still set — the run LOOKS like a resume in the registry but isn't one. A resume that cannot actually reattach its session must either fail loudly or explicitly re-inject the prior transcript, never silently start over. Related: t-050819 (merged), t-ed735b, t-b2d83a, t-bb4d21.

## Acceptance Criteria

## Activity
