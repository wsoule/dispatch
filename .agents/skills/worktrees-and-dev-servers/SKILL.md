---
name: worktrees-and-dev-servers
description:
  Use when working with local git worktrees, repo-specific worktree helpers,
  dev-server port offsets, stale server cleanup, Playwright fixtures, or browser
  debug instances. Do not use this as a substitute for host-provided workspace
  isolation.
---

# Worktrees and Dev Servers

Prefer the workspace the host already gave you. Create or remove git worktrees
only when the user explicitly asks for local/manual parallelization or the repo
documents a worktree workflow.

This repo's worktree helper is `moonx root:wt` (`scripts/wt.ts`); use it instead
of inventing a parallel convention.

## Worktree Location

Keep every worktree for a repo in one predictable place: a sibling directory
next to the repo named `<repo-dir>-worktrees/`, with one subdirectory per
worktree slug.

```text
../<repo-dir>-worktrees/<slug>
```

A sibling directory (rather than a path inside the repo) keeps worktree files
out of the main working tree, so `git status`, file watchers, typecheck, and
`pnpm install` do not scan them. Never create a worktree inside the repo — for
example under `.agents/ignore/` — because nesting one working tree inside
another confuses git and tooling.

`moonx root:wt` owns worktree placement; don't choose a path manually.

## Worktree Commands

```bash
moonx root:wt -- new <slug>    # create a worktree, allocate offset, pnpm install
moonx root:wt -- rm <slug>     # kill its processes, remove the worktree
moonx root:wt -- clean         # clean stale servers for managed worktrees
moonx root:wt -- clean <slug>  # clean one managed worktree
moonx root:wt -- ps            # show per-worktree port status (LISTEN / -)
moonx root:wt -- list          # summary of managed + external worktrees
```

For anything the suite doesn't cover, use plain `git worktree` commands only
after checking the current branch, existing worktrees, and the target directory.

## Ports

`wt new` records a port offset in the worktree's `.env.worktree`, but no dev
server reads it yet: `moonx desktop:dev` always binds 5173 (Tauri's `devUrl`
depends on it), so two worktrees running it collide. Where a tool takes an
explicit `PORT` or port flag, pass one rather than relying on its default.

## Cleanup Contract

If you start dev servers, Playwright fixtures, or browser debug instances,
record the command and port in your notes. Before completing the turn, stop
processes you started.

For a managed worktree, use the cleanup helper:

```bash
moonx root:wt -- clean <slug>
```

Otherwise kill only the exact process you started or the exact port you were
using. Avoid broad cleanup commands that could affect another local project.
