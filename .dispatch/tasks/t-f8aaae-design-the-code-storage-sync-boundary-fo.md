---
id: t-f8aaae
title: Design the external dispatch store on code.storage
status: todo
kind: task
parent: e-5434b7
milestone: null
blocked-by: []
labels:
  - design
  - team
priority: high
assignee: none
created: 2026-08-10T22:47:07.040Z
updated: 2026-08-10T22:59:41.073Z
external: null
writes: []
---

## Description

Design task — the output is a written spec (docs/superpowers/specs/), not code. Every other task in this epic hangs off its decisions.

Decide:
- What crosses the machine boundary: full run JSONL transcripts vs metadata + summaries + diff snapshots. Transcripts can contain secrets echoed in tool output — decide redaction/opt-out before anything ships.
- Project + team identity in the shared store: how a repo maps to a store location (today runs key on sha256(rootDir), which is machine-specific by construction — a shared key needs to derive from the repo, e.g. origin URL, not the local path).
- Auth: how each teammate's dispatchd authenticates to code.storage; where credentials live (relates to t-041efa credentials.json work).
- Write path: extend the boardSyncer push-on-schedule pattern vs push-on-run-terminal hook (onRunTerminal already exists as a push hook).
- Read path: what the desktop app pulls and when (poll vs subscribe).
- Spike the code.storage API enough to know its shape (what it stores, conflict semantics, latency).

Context: Wyat chose code.storage over a plain git repo ("doing in a normal git repo kinda sucks right now"). Prior art in-repo: sync/boardSyncer.ts (private sync worktree, scheduled push), inbox item "integrated with code.storage for a full team".

## Amendments

**2026-08-10 (Wyat): scope expanded — design the external dispatch store, not just a run-sync boundary.** Everything operational in `.dispatch/` (tasks, ledger, findings, inbox, team.yml) AND runs/transcripts/presence/handoffs moves into a dedicated store repo hosted on code.storage, linked from the code repo. The insight: the pain was never git-the-format, it was using the product repo's trunk as the sync channel (boardSyncer pushing task commits to main, task state riding feature branches, `.dispatch` noise in PR diffs). A separate git-shaped store keeps the whole file/merge-driver/file-backed-MCP machinery working — it just resolves a different root.

Shape to design around:
- Code repo keeps a small committed pointer (e.g. `.dispatch/store.yml` with store URL/id) — the store id IS the shared project identity (replaces the sha256(rootDir)/origin-URL question, which is now moot).
- `config.yml` (verifySteps) STAYS in the code repo — build truth is coupled to the codebase at a commit; task state isn't.
- dispatchd materializes the store locally (e.g. `~/.dispatch/stores/<storeId>/`) and syncs continuously. A local-only store with no remote is valid solo mode; attaching a code.storage remote is the team upgrade path.
- TaskStore and the file-backed MCP tools resolve pointer → store clone path; the works-without-daemon property must survive.
- This supersedes the boardSyncer.

Decisions already made (don't re-litigate in the spec):
1. Full run JSONL transcripts go in the store — size is accepted, no summarization required for storage.
2. Secret redaction is the remaining hard open question — transcripts echo tool output; resolve redaction/opt-out in this design before anything leaves the machine.
3. Two-repo atomicity (code merge in repo A, status flip in store B): reconcile on next daemon boot. Accepted.
4. No migration tooling — no users yet. A fresh store per project is fine.
5. Multi-writer conflict strategy beyond the existing merge drivers is deferred (t-e7608d CRDTs stays backlog).

## Acceptance Criteria

## Activity
