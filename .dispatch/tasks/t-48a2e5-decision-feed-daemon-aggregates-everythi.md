---
id: t-48a2e5
title: "Decision feed: daemon aggregates everything awaiting a human"
status: todo
kind: task
parent: e-6cfcc7
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:37.817Z
updated: 2026-08-22T16:58:37.817Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/core/src/**
  - packages/core/test/**
---

## Description

One daemon-owned feed of items awaiting a human, each with kind, task/run reference, age, and resolution state: gates awaiting decision, agent input requests (ask_user), verify failures that exhausted the fix-loop cap, and stalled/orphaned runs. Exposed over the existing HTTP/WS channel with live updates; items resolve automatically when the underlying thing is decided or the run moves on. This is the model layer only — surfaces and delivery are separate tasks. Designed so the future policy engine's blocking-vs-recorded split slots in as the feed's filter.

## Acceptance Criteria

## Activity
