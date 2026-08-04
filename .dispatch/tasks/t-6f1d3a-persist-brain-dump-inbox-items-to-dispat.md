---
id: t-6f1d3a
title: Persist brain-dump inbox items to .dispatch/inbox.md
status: done
kind: task
parent: e-3f896a
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:57:16.577Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Add the storage layer for the Brain dump inbox in packages/core, alongside how tasks and notes already persist. The mockup states the contract in its own side panel: "Everything is written to .dispatch/inbox.md in your repo."

An inbox item is small - text, a kind (bug / idea / task / note), a created timestamp, and once converted, the id of the task it became. Items are ordered newest first. Follow the existing markdown-document conventions in core rather than inventing a format: the file should be readable and hand-editable, because a repo-local markdown file that the user cannot edit by hand defeats the purpose of putting it in the repo.

Two behaviors belong here rather than in the view. Splitting: given a blob of pasted text, produce one item per non-empty line, trimmed. And kind inference: guess a kind from the text. The mockup's heuristic is deliberately crude (bug-ish words, then task-ish words, else idea) and crude is correct here - a wrong guess the user can change beats a slow one they have to wait for. Keep it a pure function so it is cheap to test and cheap to retune.

Also decide the relationship with the existing notes store, since Notes and triage covers adjacent ground. If they should share a backing store, say so and do it; if not, document why not.

Acceptance criteria:

- Inbox items read and write to .dispatch/inbox.md in a hand-editable markdown format consistent with the existing core document conventions
- Items survive a daemon restart and round-trip without loss
- Splitting a multi-line blob yields one trimmed item per non-empty line
- Kind inference is a pure, unit-tested function
- Converting an item records which task it became
- A malformed or hand-broken file degrades gracefully rather than crashing the daemon
- The relationship with the notes store is decided and documented
- Unit tests cover parse, serialize, split, infer and the malformed-input path
- bun run format, bun run lint and the server/core tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T01:06:26.309Z Decision (supersedes the open question in this task's description): Notes & triage is being removed, so there is no relationship to negotiate — Brain dump becomes the single inbox and absorbs the notes store. Do NOT design the item model as brain-dump-only. It must carry what packages/server/src/notes.ts carries today: createdByRunId (agents flag items mid-run via the MCP dispatch_note tool, and "an agent flagged this" has to survive), linkedTaskId, done state, and a kind vocabulary that can represent the old note/triage/followup/todo alongside the inbox's bug/idea/task/note. Removal, migration and rehoming the agent channel are t-2814f8, which depends on this model being right — getting the fields wrong here forces a second migration later.
- 2026-07-27T03:32:21.385Z Done in 3425cdc. Landed as packages/server/src/inbox.ts (not core) to sit beside notes.ts, the store it replaces — consistency with the existing analogue beat the task's stated location. 35 tests. Markdown format is `- [ ] (bug) text ^in-abc123` with optional `→ t-id` and `@r-id` markers; the parser deliberately accepts more than it emits (bare lines with no kind, `*` bullets, upper-case [X]) because the point of a markdown file is that a human types into it — a hand-added line gets an id minted on the next write. Unparsable lines are skipped individually, so a broken hand-edit costs that line and never the daemon. Model carries createdByRunId/linkedTaskId/done per the earlier decision. Timestamps are deliberately NOT in the format: they would be noise in a file meant to be typed into, so ordering is file order, which is what someone editing it would expect. markConverted is idempotent and refuses to relink an already-linked item, so a retried convert cannot fan one thought into several tasks.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
