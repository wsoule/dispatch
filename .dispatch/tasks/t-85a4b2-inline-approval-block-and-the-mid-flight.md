---
id: t-85a4b2
title: Inline approval block and the mid-flight steer composer
status: todo
kind: task
parent: e-805f3e
milestone: null
blocked-by:
  - t-6aa679
labels: []
priority: medium
assignee: none
created: 2026-07-27T01:00:39.768Z
updated: 2026-07-27T01:00:39.768Z
external: null
---

## Description

The two ways a user acts on a live agent (docs/design/dispatch-nocturne.dc.html, the d.isWait block and the steer composer at the bottom of isDetail).

The approval block. Today ApprovalCard.tsx is a card detached from the conversation. The mockup puts the request inline in the transcript at the point it was asked, which is where it belongs - the surrounding turns are the context for the decision. It carries an "waiting on you" header with how long the run has been frozen, the actual question in plain language, the command it wants to run in a code block, and three choices: approve once, approve for this session, and deny and tell it why. Deny must open somewhere to type the reason - the wording promises the agent hears why, so denying silently would be a lie. Approve-for-the-session needs to actually persist for the session and be reflected in the permission posture in Settings.

The steer composer. A persistent input at the bottom of the transcript whose placeholder states the contract: what you type is read on the agent's next turn, not immediately. On send it appears in the transcript as the user's own turn (accented, per the transcript task) so there is a record of what you told it and when. Enter sends.

Colors from tokens only - the waiting treatment uses the amber tokens per docs/design/README.md.

Acceptance criteria:

- Approval requests render inline in the transcript where they were asked, with the frozen duration, the real question and the real command
- Approve once resolves that single request; approve for this session persists for the session and agrees with the Settings posture
- Deny opens a reason input and the reason reaches the agent
- The steer composer sends mid-run, Enter sends, and the message appears in the transcript as the user's turn
- The composer's copy is honest about when the agent reads the message
- A run with no pending approval shows no approval block, and a resolved one clears
- Approve/deny paths are covered by tests
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
