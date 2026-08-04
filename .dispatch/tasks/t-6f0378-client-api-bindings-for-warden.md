---
id: t-6f0378
title: Client API bindings for warden
status: todo
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-c7dcaa
labels: []
priority: medium
assignee: none
created: 2026-08-04T18:06:37.199Z
updated: 2026-08-04T18:06:37.202Z
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
