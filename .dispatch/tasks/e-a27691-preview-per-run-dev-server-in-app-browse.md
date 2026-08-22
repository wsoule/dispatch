---
id: e-a27691
title: "Preview per run: dev server + in-app browser for every reviewable run"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - lovable-direction
  - preview
priority: high
assignee: none
created: 2026-08-22T16:37:32.221Z
updated: 2026-08-22T16:37:32.221Z
external: null
writes: []
---

## Description

Cell 1 of docs/design/lovable-direction.md, the agreed spine work: every run that reaches a reviewable state gets a dev server and a preview URL. Builder lens makes it the stage; engineer lens docks it beside the diff.

Concretely: a per-run dev-server supervisor in dispatchd — preview command from .dispatch/config (default: detect a dev script in the worktree's package.json), allocated port, proxied at /preview/<runId>/, iframe in the app; stopped with the run, swept on daemon shutdown. Known costs to handle: fresh worktrees need installs, arbitrary child processes need supervision, hung preview commands need timeouts, non-web repos get a defined empty state instead of a preview.

Independent of the storage/planning track — unblocked now. Serves the loop-compression goal directly: hot-reload on agent edits makes the feedback loop visual and near-instant.

## Acceptance Criteria

## Activity
