---
id: e-c25f9c
title: "Open-core publish: license split, CLA, scrub, and the public flip"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - open-core
  - licensing
priority: high
assignee: none
created: 2026-08-23T14:29:55.828Z
updated: 2026-08-23T14:29:55.828Z
external: null
writes: []
---

## Description

Execute the 2026-08-23 open-core decision (docs/BUSINESS.md "Licensing (decided 2026-08-23)", LICENSING.md): hybrid split — MIT for @dispatch/core, @dispatch/client, @dispatch/cli, @dispatch/mcp; FSL-1.1-ALv2 stays on the app/daemon; the team server is commercial in a separate private repo. The repo flips public as soon as the mechanics land — weeks, not a launch event.

The docs (LICENSING.md, BUSINESS.md, README, CONTRIBUTING, TEAM-SERVER) already state the decision. This epic is the mechanics: per-package license files and fields, CLA Assistant, a pre-flip audit of history and tracked content, npm publish of the MIT packages, and the flip itself with distribution-link verification. Severing the cli/mcp → @dispatch/server dependency makes the MIT surface dependency-clean but does NOT gate the flip (the caveat is documented in LICENSING.md).

## Acceptance Criteria

## Activity
