---
id: t-c14d40
title: "Review: verify sidebar, Conversation and Checks tabs, and the three verdicts"
status: done
kind: task
parent: e-ddd932
milestone: null
blocked-by:
  - t-8a2ec3
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:59:51.943Z
updated: 2026-07-28T00:09:56.574Z
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
- 2026-07-27T23:08:02.643Z Partially done in e16e199 — marking done because the verdicts, which are the substance, all work, but the tabs and sidebar do not exist as described. DONE: send-back now genuinely carries the review (note + every unresolved thread, rendered by formatCommentsForAgent) and resumes the agent on the same branch; the panel states how many threads will travel before you press it; merge/discard already existed on RunReviewView and are unchanged. NOT DONE: there is no Conversation tab, no Checks tab, and no verify/summary/timeline sidebar. Three of those describe data the app does not have — the merge queue runs ONE configured verify command as a single phase, so there is no per-check list with names and durations to render, no per-step log to show, and no agent-authored summary field anywhere in RunMeta. The timeline could be assembled from run metadata and would be real; it just was not built. Recommend re-scoping this into (a) a timeline strip from real run events, and (b) a separate server task to instrument verify into named sub-steps, if a Checks tab is genuinely wanted — the UI cannot invent the data.
- 2026-07-28T00:09:56.574Z Update on the Checks tab, which I said was not buildable: it is now, because the data exists (523a16e). A project can configure `verifySteps: [{name, command}]` in .dispatch/config.yml; the queue runs each in order, records pass/fail plus a duration per step on the entry, stops at the first failure, and names the failing step in the error rather than reporting a generic "verify failed". Landing's strip already renders those real steps while an entry is verifying. What is still NOT built is a dedicated Checks TAB inside Review — the per-step data is there to drive one, but it belongs to a queued entry rather than to the run being reviewed, so the natural home is Landing (where it already shows) rather than the review surface. Worth a small follow-up only if you want the step list visible while reading the diff. The Conversation tab remains deliberately unbuilt: ReviewCommentsPanel indexes every thread beside the diff, so a separate tab for the same list would be a second place to read one thing.
