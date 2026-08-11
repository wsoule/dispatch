---
id: t-d81cbf
title: 'Desktop: show a "planning" state on brain-dump rows tied to an in-flight plan'
status: todo
kind: task
parent: e-61052f
milestone: null
blocked-by:
  - t-26c066
labels: []
priority: high
assignee: none
created: 2026-08-11T02:11:12.342Z
updated: 2026-08-11T02:11:12.344Z
external: null
writes:
  - apps/desktop/src/views/BrainDumpView.tsx
---

## Description

Once a plan is submitted with source inbox ids, its rows in the Inbox list should read as 'planning' until the plan resolves, and disappear on their own once the server marks them converted.

Acceptance criteria:

- Planning item ids are derived from data.planRecord?.sourceInboxIds while data.planId is set and the record's state isn't 'failed' — not tracked as separate local state — so the marking survives a reload or navigating away and back
- Rows whose id is in that set render a distinct 'Planning…' treatment (dim + spinner, matching the existing per-row 'enriching' treatment) and have their row actions and checkbox disabled, matching how busy already disables them
- A failed plan turn releases its rows back to normal automatically via the state derivation, with the items still present and actionable
- No client-side removal logic is added for the confirmed case — Task 1's inbox.changed broadcast plus the existing query invalidation already refetches the inbox, and the items leave the open list because the server has marked them done

## Acceptance Criteria

## Activity
