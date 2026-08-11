---
id: t-c7dcaa
title: Warden HTTP endpoints, event, and dispatchd wiring
status: in-progress
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-4150a8
labels: []
priority: high
assignee: none
created: 2026-08-04T18:06:37.199Z
updated: 2026-08-11T01:43:01.612Z
external: null
writes:
  - packages/server/src/api.ts
  - packages/server/src/events.ts
  - packages/server/src/index.ts
  - packages/server/test/api/warden.test.ts
risk: critical
---

## Description

Expose WardenManager over HTTP the same way plan/draft endpoints work: start a session, send a follow-up message, confirm or deny a pending action, and fetch the current record. Broadcast a `warden.changed` event on every state change so the desktop app can invalidate its query. Instantiate WardenManager alongside PlanManager wherever ApiContext is assembled so it's live in every running dispatchd.

Acceptance criteria:

- POST /api/warden starts a session and returns the record immediately (state running), mirroring draftTask's 202 pattern
- POST /api/warden/:id/message and POST /api/warden/:id/actions/:actionId/confirm behave like sendDraftMessage/confirm, with the same busy/not-found error shapes as the existing plan/draft endpoints
- GET /api/warden/:id returns the current record; a `warden.changed` event fires on every state transition
- WardenManager is constructed and threaded into ApiContext alongside the existing PlanManager, with no change to unrelated ApiContext consumers
- Endpoint tests cover start, follow-up message, confirm (approve and deny), and the not-found case

## Acceptance Criteria

## Activity
- 2026-08-11T01:43:01.612Z dispatched (claude, branch dispatch/t-c7dcaa-warden-http-endpoints-event-and-dispatch-8a1e78) — none
