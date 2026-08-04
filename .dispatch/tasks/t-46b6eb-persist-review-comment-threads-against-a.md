---
id: t-46b6eb
title: Persist review comment threads against a run
status: done
kind: task
parent: e-ddd932
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-07-27T00:59:02.564Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Add the backing store, API and SDK for line-level review comments, so the Review screen can annotate an agent's diff and hand those notes back to the agent.

A comment belongs to a run, a file path and a line, and carries an author, text, a timestamp and a resolved flag. Threads are a comment plus its replies. Persist alongside the run's other artifacts, following the existing conventions rather than adding a new storage mechanism.

Two problems need deciding, and they are the reason this is its own task. First, anchoring: a comment is pinned to a line number, and the agent can push more commits that shift or delete that line. Decide what a comment does when its line moves - re-anchor on surrounding content, mark it as outdated, or something else - and make the behavior explicit rather than letting comments silently point at the wrong code. Second, the handoff: when work is sent back, the unresolved threads must reach the agent as part of its prompt, with enough context (file, line, surrounding code) to act on. That is the contract the mockup's placeholder copy states outright - "the agent reads this when you send the work back" - so it needs to be real, not implied.

Acceptance criteria:

- Comments persist per run with file, line, author, text, timestamp and resolved state, and support replies
- Comments survive a daemon restart and round-trip without loss
- The behavior when an anchored line moves or disappears is explicit, implemented and documented
- Unresolved threads are serialized into the prompt when work is sent back, with file, line and surrounding context
- Resolving and unresolving a thread is exposed and persisted
- Server routes and client SDK methods follow the surrounding conventions and are typed
- Tests cover persistence, replies, resolve, the moved-line case and the send-back serialization
- bun run format, bun run lint and the server/client tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T23:07:18.404Z Done in e16e199. 20 tests. Anchoring resolved as: each comment records anchorText — what the line said when written — and resolveAnchor returns exact (line still says it), moved (the text appears exactly once elsewhere), or outdated (everything else). Ambiguity counts as outdated deliberately: two candidate lines means picking one presents a guess as a fact, and a comment that admits it drifted is still readable. A whitespace-only anchor is never followed, since it matches half of every file. One case my own test got wrong first: an out-of-range line whose text still exists uniquely HAS simply moved (the file shrank) — the code was right, the test was not. formatCommentsForAgent renders unresolved threads with file, line, the anchored code and replies into the send-back message; resolved ones are excluded because resolving is how you say never mind. POST /api/runs/:id/send-back refuses an empty review rather than burning a run to tell the agent nothing. Stored at runsDir/:runId.review.json alongside the transcript and diff snapshot, so comments outlive the worktree every review path deletes.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
