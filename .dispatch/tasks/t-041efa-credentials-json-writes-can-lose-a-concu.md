---
id: t-041efa
title: credentials.json writes can lose a concurrent update and can leak a temp file
status: backlog
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-04T17:39:17.272Z
updated: 2026-08-04T18:07:05.639Z
external: null
writes: []
---

## Description

Follow-up from v0.16.1 (per-project Linear API keys). Raised in review, deliberately deferred — neither is a live bug today, both got harder to ignore once the file started holding one entry per project.

`writeCredentials` in `packages/core/src/credentials.ts` is now atomic: it writes a temp file at 0600 and `renameSync`s it over the target, so a crash mid-write can no longer truncate every project's keys. Two gaps remain.

**Lost update.** The write is still an unlocked read-modify-write. Two daemons whose users click Connect at the same moment race, and the last writer wins — silently discarding the other project's key. Bounded in practice: writes only happen on an explicit user action, and the worst outcome is re-pasting a key. Locking was judged not worth the complexity for that blast radius, so closing this may reasonably mean deciding it stays as-is.

**Stray temp file.** If `renameSync` throws after the temp write succeeds (target directory removed mid-write, permissions change, disk-full on the metadata op), `credentials.json.<pid>.tmp` is left on disk holding a live API key. It carries the same 0600 owner-only mode the real file would have, and the next write with the same pid overwrites it — so this is litter rather than a disclosure risk.

Acceptance: either the temp file is cleaned up on a failed rename and concurrent connects no longer drop a key, or the tradeoff is recorded in a comment on `writeCredentials` so the next reader does not re-derive it.

## Acceptance Criteria

## Activity
