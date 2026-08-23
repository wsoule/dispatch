---
id: t-6f3dc2
title: Sever the @dispatch/server dependency from cli and mcp so the MIT surface
  is dependency-clean
status: todo
kind: task
parent: e-c25f9c
milestone: null
blocked-by: []
labels:
  - open-core
  - licensing
priority: medium
assignee: none
created: 2026-08-23T14:30:36.859Z
updated: 2026-08-23T14:30:36.859Z
external: null
writes:
  - packages/cli/**
  - packages/mcp/**
  - packages/client/**
---

## Description

@dispatch/cli and @dispatch/mcp are MIT but depend on the FSL @dispatch/server, so their built artifacts bundle FSL code (documented caveat in LICENSING.md). Remove the direct dependency: mcp should reach the daemon over its HTTP API via @dispatch/client instead of importing server code; the cli similarly — where it embeds the daemon (dispatch serve/ui), consider spawning the separately-installed server artifact or splitting those subcommands out. Do not gate the repo flip on this. When done, remove the caveat bullet from LICENSING.md and docs/BUSINESS.md. Interaction warning: the storage-spine work (t-c6dbd3) is rerouting MCP task tools through the daemon at the same time — coordinate so both land on the API path, not the import path.

## Acceptance Criteria

## Activity
