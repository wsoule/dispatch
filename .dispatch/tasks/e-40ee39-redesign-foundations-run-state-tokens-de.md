---
id: e-40ee39
title: "Redesign foundations: run-state tokens, density scale, shared row primitives"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-07-27T00:53:19.120Z
updated: 2026-07-27T00:53:19.120Z
external: null
---

## Description

Groundwork for the Nocturne redesign (docs/design/dispatch-nocturne.dc.html, see docs/design/README.md). Every screen in the mockup is denser than what we ship today and leans on two things the token layer does not express yet: a semantic run-state color role, and a mono-metadata density scale for the 10-11px ids, elapsed times and counts that appear on every row.

We take the mockup's structure and density and NONE of its colors. All color resolves to tokens that already exist in apps/desktop/src/styles/tokens.css, which already has light and dark variants of accent/green/blue/red/amber/gray with matching -bg and -border companions. The mapping is fixed in docs/design/README.md: working -> accent, waiting on you -> amber, failed -> red, needs review -> green, landing -> blue, ready -> text-secondary, blocked -> text-ghost. Do not introduce the mockup's blurple, its --st-* variables, its color-mix chains, or raw hexes.

The other redesign epics all consume what this one lands, so it goes first. Doing it up front is also what keeps eight screens from each inventing their own idea of what "waiting on you" looks like.

Acceptance criteria:

- A single semantic run-state token set exists, defined once for light and dark, covering the seven states above with text, fill and border roles
- The mono-metadata density scale is expressed in tokens, not per-component font sizes
- The hairline row/panel treatment the mockup uses everywhere is one reusable rule rather than repeated border declarations
- Shared row primitives are extracted so the feed, task list, queue, sessions table and file lists do not each rebuild a status dot and a mono meta cell
- No new hex literals land in components; anything the tokens do not cover becomes a token first
- Existing views keep working and light mode is unbroken

## Acceptance Criteria

## Activity
