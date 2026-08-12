# README Rewrite — Design

Date: 2026-08-11. Approved in conversation. Full rewrite of the root
`README.md`; no other files change meaning, though deep-dive prose is
reformatted in place.

## Goal

The README's one job is converting a browsing developer into an install. All
existing content is retained but reorganized beneath that goal.

## Structure

1. **Hero (new).** Title `# Dispatch` — "(working title)" is dropped; the
   name has shipped (22+ releases, Homebrew cask). One-line pitch leading
   with the mission-control angle: create a task, dispatch an agent, watch it
   work — runs, review, and merge in one desktop app. Followed by the hero
   GIF (task → dispatch → agent working → review), then three supporting
   bullets covering the angles not led with:
   - tasks are markdown in the repo, synced by git
   - agents run under declared write-scopes, budget caps, verify gates
   - local-first: user's machine, user's API key, no account, nothing
     uploaded
2. **Install.** Existing content (Homebrew, DMGs, Linux packages) moved
   directly under the hero, unchanged.
3. **Quickstart (rewritten).** User-facing flow with the installed CLI/app
   (`dispatch init`, create a task, dispatch it) instead of the current
   build-from-source flow, which moves to Development.
4. **How it works (new, short).** Task files, the orchestrator, worktrees.
5. **MCP server.** Intro tightened; tool table kept as-is.
6. **Carto (optional).** Install command and `carto.enabled` policy stay
   visible; the Node-version/native-build troubleshooting prose folds into a
   `<details>` block.
7. **Development.** Build/test commands, daemon + web-UI workflow, and the
   old from-source quickstart, consolidated.
8. **Design docs, License.** Unchanged.

## The GIF

The one new asset. Staged against a mock project and recorded; if capture is
not possible in the working shell, the README ships with a placeholder
comment and the GIF lands as a follow-up — the rewrite does not block on it.
Asset lands in the repo (e.g. `docs/assets/`) so the README renders on
GitHub without external hosting.

## Out of scope

Site copy, docs/ restructuring, any content deletion. Everything currently
in the README survives, reworded or relocated within the file only.
