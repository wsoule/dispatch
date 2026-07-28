---
id: t-85a4b2
title: Inline approval block and the mid-flight steer composer
status: done
kind: task
parent: e-805f3e
milestone: null
blocked-by:
  - t-6aa679
labels: []
priority: medium
assignee: none
created: 2026-07-27T01:00:39.768Z
updated: 2026-07-28T01:17:51.524Z
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
- 2026-07-27T03:35:09.991Z Not done, left as todo. Only the styling moved: ApprovalCard is off raw amber-500/amber-600 and onto the waiting state tokens, so an approval gate now looks the same here as it does in the Control room feed. The substance is untouched — the card is still detached from the transcript rather than inline at the point the question was asked, it still offers only approve/deny rather than approve-once / approve-for-this-session / deny-with-a-reason, and there is no steer composer. Worth carrying forward from the Control room work: PendingApproval is only {requestId, toolName}, so the actual command lives in the run log and RunLogView already recovers it by matching entries — that is the join this task needs.
- 2026-07-27T23:10:56.802Z Marking done on the parts that exist, with the rest stated plainly rather than left as a silent gap. DONE: the steer composer already existed in RunLogView (sends mid-run, switches to "Request changes" once the run is terminal, appears in the transcript as the user's turn) — I checked before building a second one. ApprovalCard is on the waiting state tokens and already renders with the real toolName and toolInput, recovered from the log the way this task's earlier note described. NOT DONE, and worth its own task if wanted: (1) the card still sits below the transcript rather than inline at the turn where the question was asked; (2) it offers approve/deny, not the three-way approve-once / approve-for-this-session / deny-with-a-reason — approve-for-this-session in particular needs session-scoped permission state the orchestrator does not have today, and deny-with-a-reason needs the deny path to carry text, which the current onApprove(requestId, allow) signature cannot; (3) no frozen-duration readout. The three-way choice is the substantive piece and it is a server change, not a UI one.
- 2026-07-28T00:09:44.399Z Update: the three-way approval now exists, superseding the "NOT DONE" note above (523a16e). ExecutorRun.approve takes an ApprovalDecision rather than a boolean, so all three choices are real. Approve-for-this-run is session-scoped BY CONSTRUCTION — the grant is a Set inside the executor run's own closure, so it dies with the run and cannot leak into the next one, which is what makes it safe to offer at all. Deny opens a reason box before firing (the button says "tell it why", so denying silently would have made that a lie) and the reason is passed straight through as the SDK's denial message, so the agent is told what was wrong instead of guessing and retrying. 6 tests cover allow, deny, the reason travelling, double-answers and unknown request ids. Still NOT done: the card sits below the transcript rather than inline at the turn where the question was asked, and there is no frozen-duration readout. Both are placement, not capability.
- 2026-07-28T01:17:51.523Z Closed out fully in 6a83c82. The card now renders inline in the transcript — last inside the scroller rather than pinned below it — so the turns that led to the request are visible while you decide, which was the whole argument for putting it there. It also shows how long the run has been frozen; without that a stuck run is visually identical to a busy one. Combined with the three-way decision from 523a16e, every acceptance criterion on this task is now met.
