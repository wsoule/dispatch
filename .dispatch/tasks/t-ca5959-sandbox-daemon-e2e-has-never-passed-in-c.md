---
id: t-ca5959
title: "Sandbox daemon e2e has never passed in CI: fake run lands interrupted-dirty"
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - ci
  - sandbox
priority: high
assignee: none
created: 2026-08-11T00:31:25.909Z
updated: 2026-08-11T00:31:25.909Z
external: null
writes: []
---

## Description

apps/demo/test/daemon.test.ts ("serves a seeded session and plays a fake run to finished") fails deterministically on CI (2/2 attempts, both at ~60.6s = the poll deadline) and passes locally in ~16s. It has NEVER passed in CI: earlier runs died at the format check or stopped at the packages/demo seedSession failure (fixed in 8617718b, git init --bare without -b main) before the sandbox package was reached, so this is its first real CI exposure, not a regression.

What is known:
- The run reaches `failed` inside the daemon, then surveyAndUpgradeIfDirty upgrades it to `interrupted-dirty` (uncommitted paths in the worktree). The test's poll loop only exits on finished/failed, so it burns the full 60s.
- The daemon's stderr is inherited by the test process, and the CI log shows ZERO daemon output for the whole 60s window - whatever kills the fake run does so silently. Worth checking where orchestrator logging goes when not a TTY.
- Not the flaky-timing family: identical failure twice, same millisecond profile.
- Not init.defaultBranch: reproducing locally with GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null passes after 8617718b.
- Suspects worth ruling out on a Linux runner: git author identity auto-detection differences, the 15s boardSyncPeriodicMs cycle interacting with the fake run's worktree, FakeExecutor process behavior under bun on Linux.

Repro: CI Verify job on any main commit after 8617718b. Local repro has not been achieved on macOS.

## Acceptance Criteria

## Activity
