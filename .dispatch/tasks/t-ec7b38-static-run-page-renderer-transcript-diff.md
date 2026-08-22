---
id: t-ec7b38
title: "Static run-page renderer: transcript, diff, findings, rulings"
status: todo
kind: task
parent: e-dff6d3
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:44:29.208Z
updated: 2026-08-22T16:44:29.208Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/core/src/**
  - packages/core/test/**
---

## Description

Renderer that turns one run's record — transcript, diff, findings, rulings, task context — into a single self-contained static HTML page (inlined styles/assets, no server required, readable offline). Redacts nothing by default beyond what never leaves the daemon (tokens, env); the page is explicitly a share artifact, so its content set is exactly the reviewable trail.

## Acceptance Criteria

## Activity
