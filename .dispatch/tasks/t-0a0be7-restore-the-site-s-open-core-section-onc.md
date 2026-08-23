---
id: t-0a0be7
title: Restore the site's Open-core section once e-c25f9c publication lands
status: ready
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-23T19:09:16.943Z
updated: 2026-08-23T19:09:16.943Z
external: null
writes:
  - apps/site/src/pages/index.astro
---

## Description

The marketing site shipped 2026-08-23 with the Open-core section held back per the spec's ship gate (docs/specs/2026-08-23-site-redo-design.md): the repo is still private, so the section's claims and GitHub links would 404.

When the e-c25f9c source publication lands:
- In apps/site/src/pages/index.astro, remove the `{false && <OpenSource />}` guard and its comment so `<OpenSource />` renders again (commit 1b3bd16a added the guard).
- Sanity-check the GitHub links (nav, hero releases link, footer, OpenSource) resolve now that the repo is public.
- `bun run test` in apps/site, then deploy with `railway up` from apps/site.

## Acceptance Criteria

## Activity
