---
id: t-ea8213
title: "MCP tool: agents write to their milestone's memory"
status: todo
kind: task
parent: e-4ba988
milestone: null
blocked-by:
  - t-d53d40
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:38:30.168Z
updated: 2026-08-22T16:38:30.168Z
external: null
writes:
  - packages/mcp/src/**
  - packages/mcp/test/**
---

## Description

New MCP tool (memory_save) letting a dispatched agent append an entry to the memory of the milestone its task belongs to — scope is derived from the run's task, not chosen by the agent. Entries record the authoring run id. Writes go through the daemon (single-writer rule) and land in the receipt log like other agent actions.

## Acceptance Criteria

## Activity
