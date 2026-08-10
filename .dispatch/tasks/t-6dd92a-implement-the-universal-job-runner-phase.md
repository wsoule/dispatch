---
id: t-6dd92a
title: Implement the universal-job-runner Phase A plan
  (executor/workspace/gate/delivery seams)
status: todo
kind: task
parent: e-98857a
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-10T22:47:27.426Z
updated: 2026-08-10T22:47:27.426Z
external: null
writes: []
---

## Description

Execute the existing plan verbatim: docs/superpowers/plans/2026-08-05-universal-job-runner-phase-a.md (spec: docs/superpowers/specs/2026-08-05-universal-job-runner-design.md). Eight plan-tasks: job-spec frontmatter fields, unknown-key preservation, store/MCP read surface, CommandExecutor, WorkspaceProvider seam, GateVerifier extraction, delivery resolution, spec sync.

Acceptance bar is the plan's own: zero user-facing behavior change; a task file without new fields behaves byte-for-byte as today.

Note scope honestly: this delivers the seams, not vendor neutrality — CommandExecutor is a plain bash process proving the Executor contract. The sibling tasks in this epic (real second harness executor, mid-project switching) are what deliver the Xirp-visible qualities; this task de-risks them.

## Acceptance Criteria

## Activity
