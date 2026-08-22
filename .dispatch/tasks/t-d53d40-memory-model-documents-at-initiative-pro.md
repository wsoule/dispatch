---
id: t-d53d40
title: "Memory model: documents at initiative/project/milestone in the store"
status: todo
kind: task
parent: e-4ba988
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:37:55.000Z
updated: 2026-08-22T16:37:55.000Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
---

## Description

Memory document type attached to any hierarchy level (initiative, project, milestone): markdown body, authored-by (agent run id or human), timestamps. Store operations: read the layered stack for a task (its milestone's memory over its project's over its initiative's), append/edit entries, and mark entries promoted. Pure model + store work with tests; injection, MCP tool, and UI are separate tasks.

## Acceptance Criteria

## Activity
