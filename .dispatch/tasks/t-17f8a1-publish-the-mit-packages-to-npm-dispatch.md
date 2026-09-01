---
id: t-17f8a1
title: Publish the MIT packages to npm, @dispatch/core first
status: todo
kind: task
parent: e-c25f9c
milestone: null
blocked-by:
  - t-13c0e9
labels:
  - open-core
  - release
priority: medium
assignee: none
created: 2026-08-23T14:30:47.122Z
updated: 2026-08-23T14:30:47.122Z
external: null
writes:
  - packages/core/package.json
  - packages/client/package.json
  - .github/workflows/**
---

## Description

The commercial team server consumes @dispatch/core from a registry (docs/TEAM-SERVER.md §8.3 decided), so core must be published. Publish @dispatch/core and @dispatch/client to npm (check the @dispatch npm scope is actually ours — if taken, decide the fallback scope before anything ships); cli/mcp publish later once t-6f3dc2 severs their server dependency. Mechanics: publishConfig access public, files whitelist, exports map sanity against tsdown output, and a release-workflow step (or manual checklist entry in docs/RELEASE-CHECKLIST.md) so versions track the app release train. Mind bunfig minimumReleaseAge on the consuming side: a just-published version is not installable for 7 days in repos with that guard.

## Acceptance Criteria

## Activity
