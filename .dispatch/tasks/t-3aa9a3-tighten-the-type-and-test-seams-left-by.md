---
id: t-3aa9a3
title: tighten the type and test seams left by the per-project credential work
status: backlog
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: low
assignee: none
created: 2026-08-04T17:39:35.549Z
updated: 2026-08-04T18:07:08.591Z
external: null
writes: []
---

## Description

Follow-ups from v0.16.1 (per-project Linear API keys). Four small hardening items raised in review and deferred as non-blocking. Each protects an invariant that currently holds only by convention. Independent — do any subset.

**`writeCredential` / `clearCredential` have no production callers left.** The design's load-bearing invariant is that nothing writes the machine-wide `linear.apiKey` slot any more; it survives only as a read-only fallback so existing installs keep working. Right now the only thing enforcing that is convention. A `@deprecated` doc comment on both, naming the invariant, would stop an unaware caller quietly reintroducing a global write.

**`CredentialName` serves two type spaces.** It is `keyof ProjectCredentials`, but `writeCredential`/`clearCredential` use it to index `CredentialsFile`. That compiles only because both interfaces happen to declare `linear`. Adding a second integration to `ProjectCredentials` alone would make `clearCredential` a type error (a useful failure) while `writeCredential` silently wrote an undeclared top-level key, since the computed-key spread bypasses excess-property checking. A comment or a distinct `ProjectCredentialName` would make the coupling deliberate.

**`linearKeySourceNote`'s `default:` swallows future members** (`apps/desktop/src/lib/linearSettings.ts`). A new `keySource` tier would silently render the first-time-setup copy "Connect a Linear API key…" to a user who is already connected. `case null:` plus an exhaustiveness check (`const _never: never = keySource`) turns that into a compile error instead of wrong copy.

**Untested prune branch.** Nothing covers the branch that drops the `projects` key entirely when the last project is cleared (`credentials.ts`). Pure file hygiene — `projects: {}` and an absent `projects` are indistinguishable to every reader, since all of them use `file.projects?.[key]` — so this is completeness, not risk. One line on the existing "clears only the named project" test closes it.

Explicitly settled, do not revisit: the `keySource !== 'project'` guard in `LinearPanel.tsx` stays state-based (two reviewers gave contradictory advice; left as-is rather than churned), and the three-line comment above `resolveLinearApiKey` stays (it carries the one non-obvious decision in the function).

## Acceptance Criteria

## Activity
