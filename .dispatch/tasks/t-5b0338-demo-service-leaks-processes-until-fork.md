---
id: t-5b0338
title: Demo service leaks processes until fork fails; find and fix the reaper gap
status: ready
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-23T20:07:00.059Z
updated: 2026-08-23T20:07:00.059Z
external: null
writes:
  - apps/demo/src
---

## Description

On 2026-08-23 the dispatch-demo Railway service hit EAGAIN on every session create after ~12 days up: `cannot fork`, `cannot create async thread`, git spawn failures in doCreate (apps/demo/src/sessions.ts:130), and `daemon did not emit the expected stdout contract within timeout` — all process/thread exhaustion in the container. A `railway redeploy` cleared it.

Hypothesis: session teardown (idle reap after IDLE_TIMEOUT_SECONDS / 30-min reset) leaves child processes behind — daemons, scripted-agent processes, or git subprocesses — accumulating until the container's pid/thread limit is hit.

To do:
- Audit apps/demo session teardown: does it kill the whole process tree (process group) or just the direct child? Zombies reaped?
- Add a counter/log of live children per reap cycle so exhaustion is visible before it bites.
- Consider a belt-and-braces periodic self-check (restart or refuse+alert when close to the limit).

## Acceptance Criteria

## Activity
