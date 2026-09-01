---
id: t-0d63e8
title: "Team presence: who is working on what, across machines"
status: dropped
kind: task
parent: e-5434b7
milestone: null
blocked-by:
  - t-1429fa
labels:
  - team
priority: high
assignee: none
created: 2026-08-10T22:48:38.811Z
updated: 2026-08-23T14:29:34.994Z
external: null
writes: []
---

## Description

Xirp/Portal: visibility into "who is working on what" across the org. Dispatch has zero presence today — the nearest things are run_list/the orientation block (runs on THIS machine only) and the git-synced task assignee field.

Build presence behind the PresenceSource seam (kept clean for exactly this): each teammate's dispatchd publishes lightweight liveness — actor, project, live runs with task ids and file claims — through the shared code.storage channel established by this epic. Consumers:
- Desktop: teammates and their live runs in the Control room / sidebar; a claims view so you can see a collision coming before the merge queue finds it.
- Agents: extend run_list (or add a sibling MCP surface) so an agent's "concurrent runs" orientation section can include remote teammates' claims, not just local runs.

Presence is advisory, not locking — stale entries must age out gracefully (a daemon that crashed shouldn't show its runs as live forever). The scripted demo teammate (apps/demo teammateScript) is the placeholder this replaces with reality.

## Acceptance Criteria

## Activity
