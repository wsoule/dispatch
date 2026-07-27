---
id: t-c14d40
title: "Review: verify sidebar, Conversation and Checks tabs, and the three verdicts"
status: todo
kind: task
parent: e-ddd932
milestone: null
blocked-by:
  - t-8a2ec3
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:59:51.943Z
updated: 2026-07-27T00:59:51.943Z
external: null
---

## Description

Finish the Review screen: the right sidebar, the two secondary tabs, and the actions that end a review (docs/design/dispatch-nocturne.dc.html, the checks/summary/timeline sidebar, the tabConv and tabChecks blocks, and rv.accept/sendBack/discard/resend in renderVals).

Sidebar on the Files changed tab, three sections: Verify, listing each check with a pass/fail/running icon and its duration; "What it says it did", the agent's own account of the work as bullets; and Timeline, the review's history as dated events (branch opened, turns taken, you commented, agent pushed more commits, verify passed).

Conversation tab: the agent's account at the top, then every comment thread in one list with a jump-to-line link and resolve, then a "finish the review" block - a free-text note plus the verdict as three radio choices (approve and land, send back with notes, discard) and a submit. The verdict here and the header actions are the same three decisions and must not disagree.

Checks tab: each verify step as a row with its icon, name, command and duration, over the live log of whichever step is currently running.

The three verdicts: accept and land enqueues the work into the merge queue; send back with notes reveals a notes composer and, on send, resumes the agent on the same branch with the notes and unresolved threads attached; discard drops the work. Each needs to be clear about what it did and to leave the user somewhere sensible.

Colors from tokens only.

Acceptance criteria:

- The sidebar shows real verify results with durations, the agent's summary, and a timeline of actual events
- Conversation lists every thread with jump-to-line and resolve, and its verdict control is the same state as the header actions
- Checks shows each real verify step with command and duration over the actual log of the running step
- Accept and land enqueues into the merge queue and the user lands somewhere that shows that happened
- Send back with notes resumes the agent on the same branch with the notes and unresolved threads included
- Discard drops the work and is distinguishable from send-back in both wording and consequence
- The verdict actions are disabled or explained when they are not applicable
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
