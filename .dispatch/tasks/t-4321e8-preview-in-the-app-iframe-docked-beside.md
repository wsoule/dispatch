---
id: t-4321e8
title: "Preview in the app: iframe docked beside the diff"
status: todo
kind: task
parent: e-a27691
milestone: null
blocked-by:
  - t-d78f3a
labels: []
priority: high
assignee: none
created: 2026-08-22T16:39:06.637Z
updated: 2026-08-22T16:39:06.637Z
external: null
writes:
  - apps/desktop/src/**
---

## Description

The in-app browser: an iframe on /preview/<runId>/ docked beside the diff in run detail and review surfaces, with reload, open-in-external-browser, and status states (installing, starting, ready, failed, no-preview-for-this-repo) driven by supervisor state over WS. Hot-reload on agent edits flows through the proxy so the feedback loop is visual and near-instant.

## Acceptance Criteria

## Activity
