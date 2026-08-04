---
id: t-0ebf6b
title: Deterministic e2e coverage for the warden chat flow
status: todo
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-d4995b
labels: []
priority: medium
assignee: none
created: 2026-08-04T18:06:37.201Z
updated: 2026-08-04T18:06:37.202Z
external: null
writes:
  - apps/desktop/e2e/warden.spec.ts
  - packages/server/src/orchestrator/warden.ts
  - packages/server/src/orchestrator/wardens/fake.ts
---

## Description

Add a fake tool-calling backend (mirrors planners/fake.ts) so the warden flow is testable without a live LLM call, and an e2e spec exercising: open the Warden tab, ask a status question and see the fake's answer, trigger a mutating action, confirm it, and verify the underlying state actually changed (e.g. a fake-dispatched run appears).

Acceptance criteria:

- A fake warden backend produces deterministic turns/pending actions for test mode, without calling the real Claude Agent SDK
- e2e spec covers: opening the tab from the sidebar, a status question/answer round trip, a mutating action's confirm card appearing, and both the approve and deny paths
- Denying a pending action in the e2e test leaves the underlying state unchanged; approving it is reflected elsewhere in the app (e.g. the affected run's state)

## Acceptance Criteria

## Activity
