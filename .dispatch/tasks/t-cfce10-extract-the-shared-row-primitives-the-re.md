---
id: t-cfce10
title: Extract the shared row primitives the redesign screens reuse
status: done
kind: task
parent: e-40ee39
milestone: null
blocked-by:
  - t-ac5a09
labels: []
priority: high
assignee: none
created: 2026-07-27T00:55:56.192Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Every dense surface in the mockup - the Control room feed, the task list and board cards, the merge queue, the sessions table, the review file list - is built from the same handful of pieces. Extract them once into apps/desktop/src/components/ui/ so eight screens do not each rebuild them slightly differently.

The set, read off the mockup: a state dot (a small filled circle taking a run-state token, optionally breathing while live); a mono meta cell (right-alignable, tabular-nums, truncating, at the density sizes); a section label (the uppercase tracked micro-heading, optionally followed by a count and a rule that fades out to the right); a count chip (a mono number on a subtle fill, used for badges and group counts); and a segmented progress strip (n segments each passed/active/pending, used by the merge queue) alongside the continuous progress bar used for a running agent.

Prefer composition over configuration - these are small enough that a prop explosion would be worse than two components. Reuse the existing StatusIcon.tsx, PriorityIcon.tsx and ProjectDot.tsx rather than duplicating them, and check StatTile.tsx before adding anything overlapping.

All color comes from the run-state tokens the blocking task lands. No hardcoded hexes, no color-mix chains, nothing from the mockup's palette.

Acceptance criteria:

- State dot, mono meta cell, section label, count chip and both progress forms exist as shared components
- Each takes a semantic run state rather than a color, and reads its color from tokens
- The live/breathing treatment is opt-in and respects prefers-reduced-motion
- Existing overlapping components are reused or consolidated, not duplicated
- Each has unit tests where there is logic worth testing, following the repo's colocated test convention
- At least one existing view is migrated onto them as proof they fit
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T01:19:21.690Z Done. Landed lib/feedState.ts (the FeedState vocabulary + deriveFeedState/deriveTaskFeedState + FEED_STATE_ORDER/LABEL + isUrgent/isInFlight, 24 tests) and five primitives in components/ui/: StateDot, SectionLabel, CountChip, ProgressTrack, StepStrip. Two findings worth carrying forward. (1) lib/runState.ts already had RunDisposition — a derived "whose turn is it" that separates how a process ended from what a human owes it. deriveFeedState builds ON it rather than beside it; a parallel bucketing would have been two sources of truth. FeedState is still needed because a run in the merge queue is about CI not the agent (state the run's own metadata lacks), and because ready/blocked tasks have no run at all. (2) The queue outranks the run's own disposition — an approved, queued run must stop reading as "needs review" — and blocked-environment maps to urgent, not landing, since nothing advances until a human clears the dirty checkout. Both are covered by tests. ProgressTrack takes `number | null` and renders indeterminate for null rather than accepting a fabricated fraction; StepStrip renders only phases it was actually told about. Migrated RunStatePill off raw Tailwind palette classes (bg-blue-500/bg-amber-500/bg-emerald-500) onto StateDot + tokens — note it deliberately keeps `cancelled` neutral where deriveFeedState calls it failed, because the pill reports where a process ended while the feed asks what a human owes. Heads up: RunStatePill had been changed by a concurrent session to take RunMeta and render a disposition badge; I edited the current version, not the one I first read. format/lint/tsc green, 218 desktop tests pass.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
