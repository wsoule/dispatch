---
id: t-df505f
title: "Mid-project harness switching: continue a task on a different executor"
status: todo
kind: task
parent: e-98857a
milestone: null
blocked-by:
  - t-bef1cb
labels: []
priority: medium
assignee: none
created: 2026-08-10T22:48:25.555Z
updated: 2026-08-10T22:48:25.555Z
external: null
writes: []
---

## Description

The Xirp quality: "switch tools mid-project, and the full working state carries over." With a second executor registered, make switching real rather than theoretical:

- requestChanges / follow-up with strategy 'fresh' accepts an executor override (exact parallel to the fresh-model-switch task in the model-flexibility epic — same seam, same UI moment; coordinate so the follow-up composer grows one "fresh run" panel with both pickers, not two bolted-on dropdowns).
- The fresh prompt already reconstructs working state harness-neutrally (task + amendments + ledger + RunSurvey + branch) — verify nothing in that path assumes Claude specifics, and that the survey section renders for a cross-executor fresh run exactly as it does for a fix-loop fresh escalation.
- resumedFrom linking should work across executors so the UI can show the lineage (session tab per run already exists; the link just needs to not assume same-executor).
- Resume stays same-executor by definition (the session id belongs to one harness); the refusal message should point at the fresh option.
- Test: finish a run on the fake executor, follow up fresh on a second fake registered under another name, assert the prompt carries the survey and ledger and the new run records the executor name and resumedFrom.

## Acceptance Criteria

## Activity
