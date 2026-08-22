---
id: t-3e89ac
title: "Design: Modal strategy — images, snapshot/hibernate, minute cost"
status: todo
kind: task
parent: e-2a8f00
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:45:15.384Z
updated: 2026-08-22T16:45:15.384Z
external: null
writes:
  - docs/design/**
---

## Description

Design task from the direction doc's open questions; output amends docs/design/lovable-workstreams.md. Settle: sandbox image strategy (base images, dependency caching for fresh clones); snapshot/hibernate for persistent builder sessions so idle sessions stop metering; cost model per free-tier sandbox-minute and the cap that keeps the free tier affordable; ephemeral vs persistent sandbox split (builder holds a persistent one, hosted engineer later uses ephemeral per-run ones).

## Acceptance Criteria

## Activity
