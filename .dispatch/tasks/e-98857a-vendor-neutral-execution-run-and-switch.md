---
id: e-98857a
title: "Vendor-neutral execution: run and switch between multiple agent harnesses"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - xirp-gap
priority: medium
assignee: none
created: 2026-08-10T22:46:36.500Z
updated: 2026-08-10T22:46:36.500Z
external: null
writes: []
---

## Description

Xirp's headline quality: manage sessions across Claude Code, Gemini CLI, Codex, etc., and "switch tools mid-project, and the full working state carries over."

Dispatch today: the Executor/Planner seams exist (orchestrator/types.ts:132, registerExecutor) but only 'claude' is registered in production (index.ts). The Rust watcher ingests Codex/Gemini/Cursor logs for observability only, and its own comments call those roots "Best-effort guess… Unverified against a real installation" (apps/desktop/src-tauri/src/watcher/mod.rs).

Verified against the existing plan (docs/superpowers/plans/2026-08-05-universal-job-runner-phase-a.md): phase A alone does NOT deliver Xirp parity — its CommandExecutor is a plain bash process proving the seam, with zero user-facing change by design. Multi-harness agent execution and mid-project switching are additional work, tracked as children here alongside executing phase A.

## Acceptance Criteria

## Activity
