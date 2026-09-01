---
id: t-b677b7
title: Flip the repo public and verify every distribution link survives
status: todo
kind: task
parent: e-c25f9c
milestone: null
blocked-by:
  - t-13c0e9
  - t-b83383
  - t-014bab
labels:
  - open-core
  - release
priority: high
assignee: none
created: 2026-08-23T14:30:58.336Z
updated: 2026-08-23T14:30:58.336Z
external: null
writes: []
---

## Description

The flip itself, gated on licenses (t-13c0e9), the CLA gate (t-b83383), and the audit verdict (t-014bab). This is a human action — Wyat flips repo visibility in GitHub settings; the task is the checklist around it:

- Before: confirm the audit's follow-ups are done or explicitly accepted; confirm branch protection / default-branch settings make sense for a public repo; confirm GitHub Actions permissions for fork PRs are locked down (no secrets to fork workflows).
- After: verify the README release links, the Homebrew tap cask download URLs, and `brew install --cask wsoule/tap/dispatch` all still resolve (they should improve — release assets on a private repo need auth today); check whether the release workflow's tap-update job needs any token-scope change; confirm the marketing site's links point at the now-public repo.
- Announce nothing automatically — publishing posts/HN is a separate GTM decision (docs/BUSINESS.md channels).

## Acceptance Criteria

## Activity
