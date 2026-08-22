---
id: e-6cfcc7
title: "Notification center: what needs a human, right now"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - team
  - notifications
priority: high
assignee: none
created: 2026-08-22T16:58:11.086Z
updated: 2026-08-22T16:58:11.086Z
external: null
writes: []
---

## Description

From the 2026-08-22 audit (docs/design/lovable-workstreams.md, audit amendments section). The planning queue answers "what do agents do next"; nothing answers "what do humans need to decide next" — evidenced by the inbox note "the agent had requested my input but i was not notified" (^in-1149a8). Linear has notifications and triage; without this epic Dispatch is worse than Linear at exactly the surface that matters most when a team dispatches agents at high autonomy.

Scope: a daemon-aggregated decision feed — gates awaiting a decision, agent input requests (ask_user), verify failures that exhausted the fix loop, stalled runs — surfaced as an in-app notification center with delivery beyond the app (OS notifications, configurable webhook). Unblocked now: pending gates and input requests exist today, no policy engine required. Once the policy epic (e-ad1978) lands, its blocking-vs-recorded split becomes this feed's filter: blocking items notify, recorded items land quietly in the receipts.

## Acceptance Criteria

## Activity
