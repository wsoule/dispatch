# scripts/

This folder contains small development helpers for the monorepo.

## Running tasks

moon is the task runner. Run a project's task with `moonx <project>:<task>`, or
a root-level task with `moonx root:<task>`; discover what a project exposes with
`moon tasks <project>`.

```bash
moonx core:test
moonx desktop:typecheck
moon run root:format root:lint
```

## `wt` — worktree manager

`moonx root:wt -- <subcommand> [args]` creates, lists, and removes git worktrees
for this repo (see `scripts/wt.ts`). Worktrees live at
`../dispatch-worktrees/<slug>`, each with its own port offset recorded in
`.env.worktree`.

```bash
moonx root:wt -- new my-feature
moonx root:wt -- list
moonx root:wt -- ps
moonx root:wt -- rm my-feature
```

Run `moonx root:wt -- help` for the full subcommand list.

## Stale Dev Servers

Prefer repo-specific cleanup scripts when a project adds fixed-port dev servers.
If no cleanup helper exists, stop only the process you started or the exact port
you used.
