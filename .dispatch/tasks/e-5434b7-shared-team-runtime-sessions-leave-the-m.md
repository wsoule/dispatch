---
id: e-5434b7
title: "Shared team runtime: sessions leave the machine (code.storage)"
status: todo
kind: epic
parent: null
milestone: null
blocked-by:
  - e-99e113
labels:
  - team
  - xirp-gap
priority: high
assignee: none
created: 2026-08-10T22:46:27.152Z
updated: 2026-08-23T14:29:19.399Z
external: null
writes: []
---

## Description

Close the biggest gap vs Spotify's Xirp+Portal: after each session, transcripts and metadata flow into a shared store so the team sees "what has been accomplished, who is working on what, and where to resume."

Today Dispatch's durable state is split across a hard line: git-synced (tasks, ledger, findings, team.yml, board via boardSyncer) vs machine-local (`~/.dispatch/runs/<rootHash>/` transcripts, merge queue state, session ids). Every team gap is a datum on the wrong side of that line. dispatchd binds 127.0.0.1, single-user.

Direction decided with Wyat (2026-08-10): use code.storage as the shared backend, NOT a plain git repo ("doing in a normal git repo kinda sucks right now"). Related: inbox item "integrated with code.storage for a full team", t-e7608d (CRDTs, labeled post-team-plans).

Keep the PresenceSource and audit-export seams clean — this epic is the reason those seams exist.

## Amendments

**2026-08-10 (Wyat): the epic is bigger — the whole `.dispatch/` operational state externalizes, not just runs.** Tasks, ledger, findings, inbox, and team.yml migrate into a dedicated store repo hosted on code.storage, linked from the code repo by a committed pointer (`.dispatch/store.yml` or similar). Runs/transcripts/presence/handoffs land in the same store. Only the pointer and `config.yml` (verifySteps — coupled to the codebase at a commit) stay in the code repo.

Consequences:
- The boardSyncer is superseded by this epic — no more private sync worktree pushing task commits to the product repo's trunk.
- Task state stops being branch-scoped; status changes commit to the store immediately regardless of code branch.
- Solo mode = local-only store with no remote; team mode = attach a code.storage remote. That seam is the open-core packaging line.
- Product identity shift, accepted deliberately: the pitch changes from "tasks are markdown in the repo" to "tasks are markdown in *a* git repo — its own one."

Key decisions recorded on t-f8aaae's amendments (full transcripts in-store; redaction is the open question; reconcile-on-boot atomicity; no migration tooling; conflict strategy deferred).

## Acceptance Criteria

## Activity
- 2026-08-22T17:33:42.428Z DECISION (Wyat, 2026-08-22, confirmed): the 2026-08-10 amendment's mechanism — all .dispatch/ state in a dedicated store repo on code.storage, pointer in the code repo — is SUPERSEDED. Locally, dispatchd owns a SQLite store (e-99e113); git demotes to a receipt log outside the project repo. This epic's goal (sessions leave the machine, shared team state) stands; delivery becomes a hosted TaskStore backed by code.storage behind the same store seam (t-aaf2a5), and this epic is blocked by e-99e113. Full reconciliation: docs/design/lovable-workstreams.md. Do not build on the store-repo/pointer design. — none
- 2026-08-23T14:29:19.399Z Cancelled 2026-08-23: the shared code.storage store-repo mechanism was superseded by the 2026-08-22 storage decision — daemon-owned SQLite with a team server as the authoritative store (docs/TEAM-SERVER.md). Run visibility, presence, and cross-machine search return as team-server features (phases 2–4), built in the commercial server repo per the open-core split (docs/BUSINESS.md, LICENSING.md). Children cancelled with this epic. — none
