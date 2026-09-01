---
id: t-1429fa
title: Publish run metadata and transcripts to the shared code.storage store
status: dropped
kind: task
parent: e-5434b7
milestone: null
blocked-by:
  - t-f8aaae
labels:
  - team
priority: high
assignee: none
created: 2026-08-10T22:48:11.919Z
updated: 2026-08-23T14:29:33.567Z
external: null
writes: []
---

## Description

Implement the write path the design task specifies: when a run reaches a terminal state (the onRunTerminal hook already exists as the push seam), publish the agreed subset of `~/.dispatch/runs/<rootHash>/` — RunMeta, transcript (or summary per the design's redaction decision), diff snapshot, cost/turns, review state — to the shared code.storage location for the project.

Requirements regardless of design specifics:
- Publishing must never block or fail a run — queue and retry offline, like boardSyncer tolerates push failures.
- Idempotent per run id, safe under two teammates' daemons publishing concurrently.
- Backfill command for existing local history (`dispatch sync runs` or similar) so the store isn't empty on day one.
- The read side (pull + render other teammates' runs in the desktop Sessions/AllAgents views) can be its own follow-up if the design splits it, but the published shape must contain enough for the existing run views to render a remote run read-only.

## Amendments

**2026-08-10: transport is the store repo, not a bespoke upload.** Per the external-store design (t-f8aaae amendments), "publish" means: on run-terminal, write the run's artifacts into the local store clone and let the store's continuous sync carry them — full JSONL transcripts included (size accepted; no summarization for storage). RunMeta, diff snapshot, cost/turns, and review state ride along. The redaction decision from t-f8aaae gates what transcript content is written.

Drop the backfill command requirement — no users yet, a fresh store is fine. The never-block-a-run, idempotent-per-run-id, and read-side requirements stand.

## Acceptance Criteria

## Activity
