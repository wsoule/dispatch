---
id: t-014bab
title: "Pre-flip audit: history secrets, tracked personal data, and what
  BUSINESS.md exposes"
status: todo
kind: task
parent: e-c25f9c
milestone: null
blocked-by: []
labels:
  - open-core
  - audit
priority: high
assignee: none
created: 2026-08-23T14:30:27.651Z
updated: 2026-08-23T14:30:27.651Z
external: null
writes:
  - .agents/ignore/**
---

## Description

Audit everything that becomes public when the repo flips. Output is a written report (.agents/ignore/) plus follow-up tasks for anything found — this task changes nothing tracked by itself.

1. Full-history secret scan (gitleaks or trufflehog over all refs, including deleted files). Any hit means deciding between history rewrite before the flip vs credential rotation — flag, do not decide unilaterally.
2. Tracked personal/operational data: .dispatch/ is tracked and public post-flip — inbox/wsoule679.md, ledger.jsonl, findings.jsonl, task bodies (which contain internal strategy discussion, e.g. the dropped code.storage epics quote direction conversations). Decide what is fine, what moves to the gitignored area, and whether any of it needs history removal. Note this intersects the storage-spine migration (t-c6dbd3/t-880ce2): if .dispatch/ leaves the repo before the flip, most of this item dissolves.
3. docs/BUSINESS.md is tracked and contains GTM strategy, pricing bands, and the employer-deal plan. docs/business/ is already gitignored ("kept out of a public repo deliberately"); decide whether BUSINESS.md joins it (and LICENSING.md's reference to it gets adjusted) or stays public as transparent strategy.
4. Sweep for stray local artifacts tracked by accident (.DS_Store, *.bun-build at root, dispatch-fix-changed-files.zip) and personal info in commit history metadata worth knowing about (emails are fine; check for anything else).

## Acceptance Criteria

## Activity
