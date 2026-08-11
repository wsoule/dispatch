---
id: t-6f0378
title: Client API bindings for warden
status: in-review
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-c7dcaa
labels: []
priority: medium
assignee: none
created: 2026-08-04T18:06:37.199Z
updated: 2026-08-11T02:07:43.787Z
external: null
writes:
  - packages/client/src/api.ts
---

## Description

Add typed request/response models and ApiClient methods for the four warden endpoints, following the existing draft*/plan* method shapes in packages/client/src/api.ts, and fold `warden.changed` into the client's event-type union.

Acceptance criteria:

- WardenRecord/WardenMessage/WardenAction (or equivalent) types exported from packages/client/src/api.ts, matching the server's response shapes exactly
- ApiClient gains startWarden/getWarden/sendWardenMessage/confirmWardenAction methods with the same error-handling conventions as draftTask/sendDraftMessage
- warden.changed is added to whatever discriminated event-type union the client already re-exports for SSE handling

## Acceptance Criteria

## Activity
- 2026-08-11T01:58:55.325Z dispatched (claude, branch dispatch/t-6f0378-client-api-bindings-for-warden-3d4e52) — none
- 2026-08-11T02:07:29.270Z Done in f1339c2: WardenState/WardenMessage/WardenAction/WardenRecord mirrored into packages/client/src/api.ts (re-exported from index.ts), warden.changed added to ServerEvent with the plan.changed refetch-by-id contract, and ApiClient gained startWarden/getWarden/sendWardenMessage/confirmWardenAction as thin request() wrappers matching draftTask's error conventions. startWarden takes an optional { backend } following createRun's executor pattern. Verified: client tsc + 67 tests green (5 new request-shape tests, 7 new source-to-source parity tests), cli + desktop tsc green, root format/lint clean. Mutation-tested the parity guard: deliberate field rename + literal drift in the client mirror → 2 test failures, restored. — none
- 2026-08-11T02:07:43.787Z [run r-3d4e52] finished: finished — 4 files, $7.66 — agent:wsoule679/claude
