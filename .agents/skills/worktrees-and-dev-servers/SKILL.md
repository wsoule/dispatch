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

When a repo includes its own helper scripts, use those instead of inventing a
parallel convention. Common signs are `scripts/wt.*`, `scripts/run-dev.*`,
`.env.worktree`, `WORKTREE_*`/`PORT_OFFSET` env vars, or README/AGENTS
instructions for worktree paths and ports.

## Worktree Location

Keep every worktree for a repo in one predictable place: a sibling directory
next to the repo named `<repo-dir>-worktrees/`, with one subdirectory per
worktree slug.

```
../<repo-dir>-worktrees/<slug>
```

A sibling directory (rather than a path inside the repo) keeps worktree files
out of the main working tree, so `git status`, file watchers, typecheck, and
`bun install` do not scan them. Never create a worktree inside the repo — for
example under `.agents/ignore/` — because nesting one working tree inside
another confuses git and tooling.

If the repo exposes a `bun run wt` suite, let it own worktree placement instead
of choosing a path manually.

## Worktree Commands

If the repo exposes a `bun run wt` suite, inspect its help or source before use:

```bash
bun run wt new <slug>    # create a worktree, allocate offset, bun install
bun run wt rm <slug>     # kill its processes, remove the worktree
bun run wt clean         # clean stale servers for managed worktrees
bun run wt clean <slug>  # clean one managed worktree
bun run wt ps            # show per-worktree port status (LISTEN / -)
bun run wt list          # summary of managed + external worktrees
```

Do not assume these commands exist. If they do not, use plain `git worktree`
commands only after checking the current branch, existing worktrees, and the
target directory.

## Ports

For local projects on this machine, keep dev-server ports explicit and
project-specific. If the repo defines a port offset file such as
`.env.worktree`, let the repo's scripts load it. Otherwise, prefer passing a
specific `PORT`/tool option in the command you run rather than relying on a
tool's default port.

## Cleanup Contract

If you start dev servers, Playwright fixtures, or browser debug instances,
record the command and port in your notes. Before completing the turn, stop
processes you started.

Use the repo cleanup helper when one exists:

```bash
bun run wt clean <slug>
```

If there is no helper, kill only the exact process you started or the exact port
you were using. Avoid broad cleanup commands that could affect another local
project.
