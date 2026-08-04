---
id: t-6ad4e1
title: delete/remove projects via settings
status: backlog
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-03T16:10:59.408Z
updated: 2026-08-04T17:39:19.914Z
external: null
writes: []
---

## Description

right now, there are no ways to "forget" a project

## Acceptance Criteria

## Activity
- 2026-08-04T17:39:19.914Z Must also clear the project's stored Linear API key. As of v0.16.1, `~/.dispatch/credentials.json` holds a `projects` map keyed by normalized project root, and `clearProjectCredential` (from @dispatch/core) is called from exactly one place — `LinearSync.disconnect()`. Nothing prunes the entry when a project goes away, so forgetting a project would strand a working API key on disk keyed to a directory that no longer exists. Whatever removes a project should call `clearProjectCredential(rootDir, 'linear')`. No regression today because no removal flow exists yet — this task is where it becomes a real leak. — none
