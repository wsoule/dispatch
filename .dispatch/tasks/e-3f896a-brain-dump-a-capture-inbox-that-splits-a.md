---
id: e-3f896a
title: "Brain dump: a capture inbox that splits and triages raw text"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:53:55.134Z
updated: 2026-07-27T01:07:28.767Z
external: null
---

## Description

Build the mockup's Brain dump screen (docs/design/dispatch-nocturne.dc.html, the isDump block; logic in sortDump, convert and the dumpItems builder). This is one of two screens in the redesign with no equivalent in the app today.

The premise is that capture and commitment are separate acts. You paste a wall of text or type one thought per line, it splits on newlines into individual items, each gets a guessed kind (bug / idea / task / note), and they sit in an inbox that is explicitly not a commitment. From there an item can become a task, get handed to the planner with its text prefilled, or be dismissed. Multi-select enables the same three actions in bulk, plus grouping a selection into an epic. A side panel notices when several items are about the same thing and offers to select them together, on the theory that three loose tasks about worktrees are really one epic.

The mockup states that everything is written to .dispatch/inbox.md in the repo, which matches how tasks and notes already persist - so this needs a storage layer in core, a route in the server and a client SDK method before the view can be built. NotesView.tsx is the closest existing surface and its capture-then-triage flow is worth reading first; the two overlap enough that the relationship between them should be settled deliberately rather than by accident.

Colors come only from the foundations epic's tokens - including the kind badges, which map onto existing red/accent/green/gray rather than the mockup's palette.

Acceptance criteria:

- Inbox items persist to .dispatch/inbox.md and survive a daemon restart
- Pasting multiple lines produces one item per non-empty line, with a guessed kind, in a single action
- An item can become a task, open the planner prefilled with its text, or be dismissed
- Multi-select supports make-tasks, group-into-an-epic and dismiss across the selection
- Converted items move to an archive that records which task they became, and the archive is collapsed by default
- The clustering hint appears only when it has something real to say, and selects the items it names
- The view is reachable from the sidebar and its documented keyboard shortcuts work
- The overlap with Notes and triage is resolved explicitly, not left as two competing inboxes

## Acceptance Criteria

## Activity
- 2026-07-27T01:06:46.312Z Scope decision: Notes & triage is being removed. The epic's last acceptance criterion ("the overlap with Notes and triage is resolved explicitly") is hereby resolved — Brain dump replaces it as the single inbox and absorbs its store, its data, and the MCP dispatch_note agent channel. Added t-2814f8 to retire the old surface and migrate .dispatch/notes.json into .dispatch/inbox.md; commented on t-6f1d3a (the item model must carry createdByRunId, linkedTaskId and done state) and t-a0c9c0 (agent-flagged items must be distinguishable; do not build the link to the old triage list). Epic is now 6 tasks.
- 2026-07-27T01:07:28.767Z Correction to the previous comment: the epic is 5 tasks, not 6 — t-6f1d3a (storage), t-22429b (API/SDK), t-a0c9c0 (view), t-04c990 (batch actions and clustering), t-2814f8 (remove Notes & triage and migrate).
