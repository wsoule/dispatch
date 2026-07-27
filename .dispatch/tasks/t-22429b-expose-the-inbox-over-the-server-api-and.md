---
id: t-22429b
title: Expose the inbox over the server API and client SDK
status: todo
kind: task
parent: e-3f896a
milestone: null
blocked-by:
  - t-6f1d3a
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:57:29.612Z
updated: 2026-07-27T00:57:29.612Z
external: null
---

## Description

Route the inbox store through packages/server and packages/client so the desktop app can reach it, following the same shape the existing task and note endpoints use.

The operations the Brain dump view needs: list items; add a blob of text (server-side split into items, so the splitting rule lives in one place rather than being reimplemented in the view); update an item's kind or text; dismiss items; and convert items into tasks, which must both create real tasks and record the resulting task ids back onto the inbox items in one operation rather than two round trips that can half-fail.

Convert is the one with teeth: it spans two stores, so decide what happens if task creation succeeds and the inbox write fails, and make the failure mode not-silent. Batch convert should either convert all selected items or report which ones did not.

Also emit whatever change signal the desktop app's data-changed plumbing already uses, so the view updates without polling on its own schedule.

Acceptance criteria:

- List, add, update, dismiss and convert are routed on the server and exposed on the client SDK
- Adding a blob splits server-side using the core function, not a duplicate in the view
- Convert creates tasks and records the task ids on the inbox items, and a partial failure is reported rather than swallowed
- Batch convert reports per-item outcomes
- Inbox changes emit the existing data-changed signal
- The client methods are typed and match the conventions of the surrounding SDK
- Tests cover each route including the convert partial-failure path
- bun run format, bun run lint and the server/client tsc/tests are green

## Acceptance Criteria

## Activity
