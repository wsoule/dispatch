---
id: t-e02322
title: "Design: sharing skills/rules/MCP configs across repos and the team"
status: backlog
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - design
  - team
  - xirp-gap
priority: low
assignee: none
created: 2026-08-10T22:47:59.594Z
updated: 2026-08-10T22:47:59.594Z
external: null
writes: []
---

## Description

Portal's marketplace quality: "the skills, rules, plugins, and MCP configurations that every team develops independently… consolidated into a curated marketplace where teams contribute, discover, and build upon each other's work."

Dispatch's only distribution mechanism today is "commit it to the repo" (.agents/skills/*/SKILL.md indexed into every prompt by orientation.ts; dispatch init merges the MCP entry into .mcp.json; config/team files have custom merge drivers). Nothing crosses repo or team boundaries.

Deliberately design-only for now — one brainstorm producing a direction doc: is this a code.storage-backed registry (piggybacking the shared-team-runtime epic), a git subscription model (skills repo referenced by many projects), or out of scope for a single-team product at this stage? Do not start an epic until the shared team runtime lands and proves the storage layer.

## Acceptance Criteria

## Activity
