---
id: e-ff5a2c
title: "First-class handoff: pick up where another session left off"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - team
  - xirp-gap
priority: high
assignee: none
created: 2026-08-10T22:46:30.933Z
updated: 2026-08-10T22:46:30.933Z
external: null
writes: []
---

## Description

Xirp: "Any engineer or agent can pick up where another left off, because the full working context is preserved." Dispatch's resume today only works within one run's lineage, on one machine, via a Claude SDK session id.

Dispatch already has a nearly harness-neutral working-state bundle: worktree + branch + task file + ledger + RunSurvey (staged/unstaged/untracked/last-commit, re-injected into resumed prompts by renderSurveySection in orchestrator/prompt.ts). The gap is packaging that bundle as a first-class, portable "pick this up" artifact instead of a private resume.

Dormant seam: core/src/ledger.ts:4 defines a 'handoff' LedgerKind that no code path ever writes — record_decision's MCP schema only accepts decision|hazard.

Cross-machine transport rides on the shared-team-runtime epic (code.storage); same-machine person-to-person and session-to-session handoff can land first.

## Acceptance Criteria

## Activity
