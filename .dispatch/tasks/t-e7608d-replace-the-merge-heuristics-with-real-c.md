---
id: t-e7608d
title: Replace the merge heuristics with real CRDTs
status: backlog
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - team
  - storage
  - post-team-plans
priority: medium
assignee: none
created: 2026-08-03T16:02:45.594Z
updated: 2026-08-03T16:02:45.594Z
external: null
---

## Description

Once the team collaboration plans land (identity + merge hygiene, board syncer, presence/claims, audit + surfaces), replace the hand-rolled merge heuristics with actual convergent data types.

## Why — the limits the heuristics actually have

What ships after the team plans:
- `.dispatch/tasks/*.md` — a custom three-way merge driver: union the append-only `## Activity` section, merge frontmatter field-by-field (`packages/core/src/mergeTask.ts`)
- `.dispatch/team.yml` — union members by handle (`packages/core/src/mergeTeam.ts`)
- `findings.jsonl` / `ledger.jsonl` — append-only, so union-mergeable by construction
- presence — one git ref per writer, conflict-free because there is exactly one writer

That is good engineering and it is not convergence. Four real limits:

1. **`updated` is a wall clock.** The whole board-sync invariant (spec §3.2) rests on `isOutstanding` comparing `Date.parse(updated)` against the last accounted version. Two machines with skewed clocks can push each other backwards indefinitely, and nothing detects it. This is the load-bearing one — the monotonic rule was born fixing a real Linear regression (53190d6) and it is only as good as the clocks.

2. **Three-way merge conflicts where a CRDT converges.** Two people setting `status` differently is a genuine concurrent edit; today it produces a conflict a human resolves. A LWW-register resolves it deterministically and identically on both machines, with no human in the loop.

3. **No causality anywhere.** Nothing distinguishes "concurrent" from "sequential" — the driver infers it from the merge base, which only works when git hands it one. The JSONL and refs paths get no base at all, so they cannot even attempt it.

4. **Activity union dedups by exact line**, so two teammates writing the same comment text collapse into one entry. Correct dedup needs identity, not string equality.

## The constraint that makes this hard

The founding thesis (2026-07-13 spec §2) is that tasks are markdown files agents grep and edit with plain file tools. A CRDT that stores opaque state destroys that — it is exactly why B (SQLite-first) and C (git-refs op-log) were rejected for storage in the first place.

So the design question is not "which CRDT library" but: **can the convergent state be derived from, or stored beside, human-readable markdown rather than replacing it?** Options worth spiking: a sidecar `.dispatch/crdt/<id>.json` holding causal metadata with the `.md` as the materialized view; or embedding a compact causal context in frontmatter that humans can ignore.

## Sketch of the direction

- Hybrid logical clocks (or Lamport timestamps) replacing wall-clock `updated`, so causality is tracked rather than assumed
- LWW-register per scalar frontmatter field, tie-broken on actor handle for determinism
- OR-Set for `labels` and `blockedBy`, so a concurrent add and remove resolve without conflict
- A sequence CRDT (RGA or Fugue) for `## Activity`, with per-entry identity rather than line-text dedup
- `findings.jsonl` / `ledger.jsonl` are already grow-only sets and need nothing

## Prior art to read first

Automerge and Yjs for the algorithms; `git-bug` for how an op-log rides git refs; and the repo's own `docs/research/2026-07-13-landscape-research.md`, which records why Beads died of bidirectional sync — the failure mode this work must not reintroduce.

## Acceptance Criteria

## Activity
