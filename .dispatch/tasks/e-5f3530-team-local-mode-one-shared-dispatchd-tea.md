---
id: e-5f3530
title: "Team-local mode: one shared dispatchd, teammates connect from browsers"
status: dropped
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
updated: 2026-08-23T14:29:30.432Z
external: null
writes: []
---

## Description

From the 2026-08-22 audit of the planning/lovable board (docs/design/lovable-workstreams.md, audit amendments section): the plan as first filed made Dispatch MORE local (per-machine SQLite, dispatchd bound to 127.0.0.1, single-user) while the only team story was the hosted tier, priority-low and last — yet the goal is "use it with my team, localized." This epic closes that gap without code.storage, Modal, or accounts: one shared dispatchd on a machine the team can reach; teammates connect from browsers.

Every piece already exists in some form: the desktop UI is already a browser app (6 of ~443 files import @tauri-apps/*, all with isTauri() fallbacks), apps/demo already proves multi-session hosting behind path-prefixed proxies, and the daemon's two-tier token auth (agentToken/appToken) is the right authorization shape. Blocked by the storage spine (the shared daemon serves the SQLite store) and slots immediately after it — this, not the hosted tier, is when the team can start using Dispatch together. The hosted tier later generalizes this rather than replacing it.

## Acceptance Criteria

## Activity
- 2026-08-23T14:29:22.931Z Parked 2026-08-23: under the open-core split (docs/BUSINESS.md, LICENSING.md) multiplayer does not ship free inside the open client — the paid boundary is "team features require the server." This epic's scope (multi-user daemon, browser connect, presence/attribution) is absorbed by team-server phases 1–4 (docs/TEAM-SERVER.md §6). Revisit only if the free-funnel strategy changes. Children cancelled with this epic. — none
