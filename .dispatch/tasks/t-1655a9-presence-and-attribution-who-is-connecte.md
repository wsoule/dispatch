---
id: t-1655a9
title: "Presence and attribution: who is connected, who decided what"
status: dropped
kind: task
parent: e-5f3530
milestone: null
blocked-by:
  - t-4c017f
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:58:57.521Z
updated: 2026-08-23T14:29:42.294Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - apps/desktop/src/**
---

## Description

Fill the PresenceSource seam (kept clean for exactly this): the daemon tracks connected users per project, the app shows who is online and what they are viewing/deciding, and every gate decision, dispatch, and ledger entry records the authenticated user rather than a machine-level identity. Receipts become team-legible: "who approved this" has a name.

## Acceptance Criteria

## Activity
