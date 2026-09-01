---
id: t-b3ad8f
title: Shrink in-repo .dispatch/ to committable config only
status: in-progress
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-9d89bb
  - t-880ce2
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:39:15.687Z
updated: 2026-09-01T16:14:49.678Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/cli/src/**
  - docs/**
  - README.md
---

## Description

Once the DB is the source of truth and receipts live outside the repo, the project's .dispatch/ carries only genuinely-committable config (config.yml, team.yml). Stop writing tasks/, findings.jsonl, ledger.jsonl, fix-loops.jsonl, notes.json, and inbox/ into the repo; the import task already moved their contents. Update init/docs/README so the "tasks are markdown files in your repo" story becomes "your repo holds config; state lives in the daemon with git receipts."

## Acceptance Criteria

## Activity
- 2026-09-01T16:11:44.563Z dispatched (claude, branch dispatch/t-b3ad8f-shrink-in-repo-dispatch-to-committable-c-59aae9) — human:wsoule679
- 2026-09-01T16:14:49.677Z Orientation done. State of the repo before I change anything: on the sqlite backend the daemon ALREADY stops writing tasks/, findings.jsonl and ledger.jsonl into the project — startServer selects stores.records.findings/ledger over the JSONL stores, skips watchTasks (no tasksDir), and skips the BoardSyncer (its comment already defers to the receipts exporter). So the "stop writing" half of this task is largely landed by t-c6dbd3. What is genuinely left: (1) the leftovers — the import is non-destructive by design, so 192 files are still tracked under .dispatch/ with nothing removing them; (2) fix-loops.jsonl, notes.json and inbox/ are still written into the repo unconditionally on BOTH backends (FixLoopStore/NoteStore/InboxStore take rootDir and have no backend seam), so the task's premise that "the import already moved their contents" is false for exactly those three — the epic ledger flags this and warns that deleting them would lose them outright; (3) `dispatch init` still scaffolds .dispatch/tasks and leaves the project on the files backend, so a new project does not get the new story at all; (4) docs/README still lead with "Tasks live in your repo. Every task is a markdown file in .dispatch/tasks/*.md". Also noted: .dispatch/dispatch.db* and storage.json are gitignored in THIS repo by hand, but nothing ships that ignore rule to a user's project, and index.ts's comment calls storage.json committable while this repo's .gitignore excludes it — those two disagree. Asking the human to settle retire-vs-leave, what happens to the three file-only stores, and whether init should default to sqlite before I write code. — none
