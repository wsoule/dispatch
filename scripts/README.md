# scripts/

This folder contains small development helpers for the monorepo.

## `bun ws`

`bun ws <package> <script> [args...]` runs a package script from the repository
root.

```bash
bun ws template build
bun ws template test
bun ws packages/template tsc
bun ws "packages/*" test --sequential
bun ws "*" tsc --sequential
```

Package resolution works in this order:

1. An explicit path such as `packages/template` or `apps/web`.
2. A short directory name under `packages/` or `apps/`.
3. A glob passed to Bun's `-F` workspace filter.

If the root package name is scoped, name globs inherit that scope. For example,
with a root name of `@workspace/template-monorepo`, `bun ws "template*" test`
filters workspace package names as `@workspace/template*`.

`--parallel` and `--sequential` are handled as Bun workspace run-mode flags.
`-v` and `--verbose` are accepted for compatibility and otherwise ignored.

## Stale Dev Servers

Prefer repo-specific cleanup scripts when a project adds fixed-port dev servers.
If no cleanup helper exists, stop only the process you started or the exact port
you used.
