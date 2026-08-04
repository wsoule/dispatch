---
id: t-782af7
title: Model-backed epic grouping on Brain dump, using Haiku
status: done
kind: task
parent: e-3f896a
milestone: null
blocked-by: []
labels: []
priority: low
assignee: none
created: 2026-07-27T03:34:28.714Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Requested during the redesign: the local similarity heuristic can only see shared vocabulary, so it misses "diffs go blank mid-run" and "the review pane is empty while an agent works" — one bug described twice, sharing no words. A model catches that.

Deliberately a second pass rather than a replacement. The local check (lib/inboxCluster.ts) is free and instant so it runs on every render as a passive hint; this one costs a call and a couple of seconds, so it is an explicit "Find related" button. A suggestion that quietly bills you on every render is not a suggestion.

Haiku, on purpose: this is a short classification over a handful of one-line strings, with no tools granted (clustering is about the text, not the repo). Paying Opus rates to sort a todo list would be indefensible, and the latency would defeat the point.

Model output is sanitised before it reaches the user, because the whole value is being able to trust a suggested grouping enough to act on it in one click: invented ids, ids claimed by two groups, and groups of one are dropped. Each surviving group offers Select and Make an epic.

Acceptance criteria:

- A user-triggered pass groups related captures and names each group as a candidate epic with a one-line reason
- It runs on Haiku with no tools, and does not fire automatically
- Invented, duplicated and cross-claimed item ids are dropped before display, and a group needs at least two real items
- An unrelated list returns no groups rather than a forced grouping
- A model or transport failure surfaces as an error, never as "nothing here is related"
- The sanitiser is unit tested against each malformed-output case
- format, lint and tsc are green

## Acceptance Criteria

## Activity
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
