---
id: t-11182a
title: "Handoff bundle: package a run so someone else can pick it up"
status: todo
kind: task
parent: e-ff5a2c
milestone: null
blocked-by: []
labels:
  - team
priority: high
assignee: none
created: 2026-08-10T22:47:23.162Z
updated: 2026-08-10T22:47:23.162Z
external: null
writes: []
---

## Description

Turn the implicit working-state bundle into an explicit, portable artifact. Dispatch already reconstructs prompts from harness-neutral parts — task file + amendments, ledger, RunSurvey (staged/unstaged/untracked/last commit via renderSurveySection), branch + worktree. A "package for pickup" action should snapshot exactly that:

- API + orchestrator support: given a run (live-stopped, failed, interrupted-dirty, or finished-unmerged), produce a handoff record = branch name + base commit + survey + task id + ledger handoff entry + optional note. Ensure WIP is committed to the branch first (auto-commit-on-finish already exists at orchestrator.ts:~2694; extend to the handoff path).
- Pickup flow: from a handoff record, a new run dispatches with strategy 'fresh' — NOT resume — so it works across machines and across harnesses (the Claude session id deliberately stays out of the bundle; fresh-strategy prompt reconstruction is what makes this vendor-neutral).
- Same-machine person→person works via the branch being in the repo; cross-machine transport is the shared-team-runtime epic's job (the record itself should be small and serializable so it can ride code.storage later).
- CLI: `dispatch run handoff <runId>` / `dispatch run pickup <ref>`.

The Xirp quality being matched: "Any engineer or agent can pick up where another left off, because the full working context is preserved."

## Acceptance Criteria

## Activity
