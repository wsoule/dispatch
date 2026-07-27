---
id: t-88cf9a
title: AI detail-enrichment for under-specified tasks and inbox items
status: done
kind: task
parent: e-92d17d
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-27T03:34:12.396Z
updated: 2026-07-27T03:34:12.396Z
external: null
---

## Description

Requested during the redesign, not in the original epic set: a way to point the AI at something thin and have it come back specified.

Two endpoints, because they are different jobs. POST /api/inbox/:id/enrich turns a captured one-liner INTO a task. POST /api/tasks/:id/enrich deepens a task that already exists and may already have been partly specified by a human — that one is told explicitly to preserve what is already written, because the failure mode is an agent helpfully rewriting a carefully-worded acceptance criterion into something vaguer.

Both reuse the existing second plan slot in useDispatchProject (notePlanId / notePlanRecord / handleConfirmNotePlan), kept apart from the Plans view's own slot so starting one cannot clobber an open plan, and so nothing is written until the proposal is confirmed.

UI: an "Add detail" action on each Brain dump row, and one in the task peek. The task-peek button deliberately sits outside the ready/hasOpenRun gate — a blocked or not-yet-ready task is precisely the one worth specifying before an agent ever reaches it.

Acceptance criteria:

- Enriching an inbox item proposes a fully specified task without writing anything until confirmed
- Enriching an existing task preserves its title, existing description and existing acceptance criteria, and adds rather than replaces
- Both are reachable from the surfaces the user works in: every Brain dump row, and the task peek
- The task action is available regardless of whether the task is ready to dispatch
- Neither can clobber an open plan in the Plans view
- format, lint and tsc are green across server, client and desktop

## Acceptance Criteria

## Activity
