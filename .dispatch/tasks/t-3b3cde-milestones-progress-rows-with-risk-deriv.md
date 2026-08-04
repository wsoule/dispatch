---
id: t-3b3cde
title: "Milestones: progress rows with risk derived from real run state"
status: done
kind: task
parent: e-c88fb6
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:02:02.799Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Reshape apps/desktop/src/views/MilestonesView.tsx to the mockup's version (docs/design/dispatch-nocturne.dc.html, the isMilestones block and the milestones builder in renderVals).

One row per milestone in a four-column grid: the title with its constituent epic ids beneath, the target date, a progress bar with done/total and a percentage, and a state (on track / at risk / not started). An at-risk milestone tints its row, its date reads as at-risk, and it gains a warning line naming the actual reason.

That reason is the work. The mockup's example - "Two tasks in this milestone have been waiting on you for over ten minutes" - is derived from run state, not typed in by a human. So implement risk as a real derivation over the milestone's tasks and their runs: things frozen waiting on the user, repeated verify failures, a target date that the current completion rate will not meet. Pick the signals that are honestly available and state the reason in the same specific voice - a milestone flagged "at risk" with no reason given is just anxiety.

Colors from the run-state tokens only; at-risk uses the amber tokens per docs/design/README.md.

Acceptance criteria:

- Each milestone shows its epics, target date, progress with done/total and percentage, and a state
- Risk is derived from real task and run state, not hand-entered
- An at-risk milestone names the specific reason in concrete terms
- On-track, at-risk and not-started are visually distinct using tokens
- A milestone with no scoped epics renders sensibly rather than showing zero progress as failure
- The risk derivation is unit tested for each signal it implements
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T02:34:24.621Z Done in 389f17e. One acceptance criterion cannot be met as written: there is no target date to render or be late against. TaskMeta.milestone is a free-form string (deliberately, so a project needs no setup to use milestones), so schedule risk is not computable and is not faked. Risk is derived purely from run state in lib/milestoneRisk.ts (9 tests): a milestone is 'stalled' when any of its tasks have runs waiting on approval or failed, 'active' when agents are running, 'idle' otherwise, 'complete' when all tasks are closed. The reason always names the specific count and lists both causes when both are present, since waiting and failing call for different actions. A stall outranks concurrent progress — one frozen task is the thing to act on even if three others are running. If dated milestones are wanted, that is a core model change (TaskMeta.milestone becomes a record with a date) and deserves its own task.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
