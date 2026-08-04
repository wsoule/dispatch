---
id: t-ac5a09
title: Add semantic run-state tokens and a mono density scale to tokens.css
status: done
kind: task
parent: e-40ee39
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-07-27T00:55:40.785Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Extend apps/desktop/src/styles/tokens.css with the two things every redesign screen needs and the token layer does not express yet.

First, a semantic run-state role. Components today reach for --amber or --red directly, which means "waiting on you" is spelled differently in each view. Define one named set covering working, waiting, failed, needs-review, landing, ready and blocked, each with a text, fill and border variant, defined once for light and once inside the existing prefers-color-scheme dark block. These must resolve to the palette tokens that already exist - accent, amber, red, green, blue, gray, text-secondary, text-ghost per the table in docs/design/README.md. No new hues, and specifically none of the mockup's: the design contributes structure and density only.

Second, the density scale. The mockup's rows carry 9.5-11px monospace ids, elapsed times and counts, below the current --text-xs floor of 10px, plus an uppercase tracked micro-label used for every section heading. Add tokens for those sizes and for the tracked-label treatment so views stop hardcoding font-size and letter-spacing.

Also add the hairline treatment. The mockup draws every row edge and panel outline with an inset box-shadow rather than a border, so edges never affect layout and can overlap. Express that as a reusable rule over --border-default / --border-strong.

Acceptance criteria:

- A run-state token set exists covering all seven states with text, fill and border roles, defined for both light and dark
- Every value resolves to an existing palette token; no new hex literals and nothing from the mockup's palette
- Density tokens cover the mono metadata sizes and the uppercase tracked section label
- The hairline edge treatment is one reusable rule, not repeated per component
- The tokens are documented in place, in the style of the surrounding file
- Existing views still render correctly in both light and dark; nothing regresses visually
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T01:19:02.697Z Done. Added a --state-{working,waiting,failed,review,landing,ready,blocked}-{fg,surface,edge} set to tokens.css, plus --amber-border/--red-border (derived via color-mix from the existing pair — green/blue/gray already shipped a border, those two didn't). Deviation from the acceptance criteria, deliberately: the state tokens are NOT restated in the prefers-color-scheme dark block. Every value forwards to a palette token that the dark block already overrides, so one definition covers both themes and the two can't drift — restating them would have been the bug this task exists to prevent. Also added --text-2xs (9.5px) / --text-meta (10.5px), --label-tracking / --meta-tracking, and --hairline plus four directional variants (inset shadows, so an edge costs no layout). The label and meta treatments landed as .dense-label / .dense-meta classes in global.css rather than Tailwind utilities, because each is size + tracking + family together and never varies independently; Tailwind's own text-xs/text-sm were left alone since 7 call sites rely on their defaults. Colors and shadows are re-exported to Tailwind via @theme inline in tailwind.css. Verified the utilities actually generate by building and grepping the emitted CSS (.shadow-hairline -> var(--hairline), .text-state-waiting -> var(--state-waiting-fg)). format/lint/tsc green, 218 desktop tests pass.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
