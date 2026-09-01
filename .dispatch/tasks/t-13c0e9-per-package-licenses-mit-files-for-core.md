---
id: t-13c0e9
title: "Per-package licenses: MIT files for core/client/cli/mcp, correct license
  fields everywhere"
status: todo
kind: task
parent: e-c25f9c
milestone: null
blocked-by: []
labels:
  - open-core
  - licensing
priority: high
assignee: none
created: 2026-08-23T14:30:04.367Z
updated: 2026-08-23T14:30:04.367Z
external: null
writes:
  - packages/core/LICENSE
  - packages/client/LICENSE
  - packages/cli/LICENSE
  - packages/mcp/LICENSE
  - packages/*/package.json
  - apps/*/package.json
---

## Description

Add an MIT LICENSE file to packages/core, packages/client, packages/cli, and packages/mcp (copyright Wyat Soule), and set "license": "MIT" in those four package.json files. Every other package/app gets "license": "FSL-1.1-ALv2" (several currently say "SEE LICENSE IN LICENSE"; packages/demo, apps/demo, and apps/site have no license field at all). The root LICENSE stays FSL and remains the repo default per LICENSING.md. Verify `bun run build` output (tsdown) does not strip or mangle the per-package LICENSE files from published artifacts.

## Acceptance Criteria

## Activity
