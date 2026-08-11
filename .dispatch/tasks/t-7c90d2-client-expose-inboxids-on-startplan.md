---
id: t-7c90d2
title: "Client: expose inboxIds on startPlan"
status: todo
kind: task
parent: e-61052f
milestone: null
blocked-by:
  - t-29ccd6
labels: []
priority: high
assignee: none
created: 2026-08-11T02:11:12.340Z
updated: 2026-08-11T02:11:12.344Z
external: null
writes:
  - packages/client/src/api.ts
---

## Description

Extend the dispatchd client so callers can start a plan with the inbox items it originated from, matching the new server contract.

Acceptance criteria:

- The client-side PlanRecord mirror gains sourceInboxIds?: string[]
- DispatchApiClient.startPlan becomes startPlan(prompt: string, inboxIds?: string[]): Promise<{ planId: string }>, sending inboxIds in the POST body only when present
- Existing single-argument callers are unaffected; a type error would surface if Task 1's request/response shapes drifted

## Acceptance Criteria

## Activity
