---
id: t-67701b
title: "Notification center UI: feed surface and badge in the app"
status: todo
kind: task
parent: e-6cfcc7
milestone: null
blocked-by:
  - t-48a2e5
labels: []
priority: high
assignee: none
created: 2026-08-22T16:59:01.305Z
updated: 2026-08-22T16:59:01.305Z
external: null
writes:
  - apps/desktop/src/**
---

## Description

The decision feed as a first-class surface: a notification center listing everything awaiting a human, newest-urgent first, each item deep-linking to the exact gate/run/input prompt where the decision happens; a persistent badge with the pending count on the app shell. Items clear when resolved, with no manual mark-as-read bookkeeping for things the system can observe. This directly closes inbox item ^in-1149a8 ("the agent had requested my input but i was not notified").

## Acceptance Criteria

## Activity
