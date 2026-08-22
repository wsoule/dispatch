---
id: e-5f3530
title: "Team-local mode: one shared dispatchd, teammates connect from browsers"
status: todo
kind: epic
parent: null
milestone: null
blocked-by:
  - e-99e113
labels:
  - team
  - team-local
priority: high
assignee: none
created: 2026-08-22T16:58:05.881Z
updated: 2026-08-22T16:58:05.881Z
external: null
writes: []
---

## Description

From the 2026-08-22 audit of the planning/lovable board (docs/design/lovable-workstreams.md, audit amendments section): the plan as first filed made Dispatch MORE local (per-machine SQLite, dispatchd bound to 127.0.0.1, single-user) while the only team story was the hosted tier, priority-low and last — yet the goal is "use it with my team, localized." This epic closes that gap without code.storage, Modal, or accounts: one shared dispatchd on a machine the team can reach; teammates connect from browsers.

Every piece already exists in some form: the desktop UI is already a browser app (6 of ~443 files import @tauri-apps/*, all with isTauri() fallbacks), apps/demo already proves multi-session hosting behind path-prefixed proxies, and the daemon's two-tier token auth (agentToken/appToken) is the right authorization shape. Blocked by the storage spine (the shared daemon serves the SQLite store) and slots immediately after it — this, not the hosted tier, is when the team can start using Dispatch together. The hosted tier later generalizes this rather than replacing it.

## Acceptance Criteria

## Activity
