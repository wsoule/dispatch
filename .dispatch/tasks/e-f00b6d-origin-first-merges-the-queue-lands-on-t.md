---
id: e-f00b6d
title: "Origin-first merges: the queue lands on the default branch on origin"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - team
priority: high
assignee: none
created: 2026-08-11T15:26:38.000Z
updated: 2026-08-11T15:26:38.000Z
external: null
writes: []
---

## Description

Today the merge queue squash-merges into the LOCAL main checkout and pushes afterward (pushOnDrain), with the local checkout as the source of truth. That inverts reality for any repo whose default branch lives on GitHub: pushes race whatever else moved origin (this repo's board-syncer commits collide with human pushes constantly — 2026-08-11's session hit rejected pushes, wedged rebases, and a corrupt rebase-merge dir in one evening), a failed drain-push leaves "merged locally but not on origin" as a silent split-brain, and the local checkout being dirty or on the wrong branch blocks merges entirely (MergeEnvironmentError).

Flip the model: the queue's target is origin's default branch. A queued run merges by pushing its branch and landing it remotely — via the GitHub merge API / gh (the PrManager path already knows how to open, poll, and detect merges) or a server-side push of a locally-computed merge commit — and the local checkout FOLLOWS origin (fast-forward pull after each landing) instead of leading it. Local-first stays as the offline/no-remote fallback (the existing behavior, auto-selected when there is no origin). The external-merge reconciler and pushedToOrigin bookkeeping already give the detection half; this epic moves the write half.

Also folds in: the board-syncer and the queue sharing one serialized writer to origin so they stop racing each other, and surfacing queue state as "landed on origin" rather than "merged locally, push pending".

## Acceptance Criteria

- With a GitHub remote, approving a merge lands the work on origin's default branch without the local checkout's state (dirty, wrong branch) being able to block or race it.
- The local checkout follows origin after each landing; "merged locally but not pushed" ceases to exist as a reachable state on remotes-enabled projects.
- No-remote projects keep the current local merge behavior unchanged.

## Activity
