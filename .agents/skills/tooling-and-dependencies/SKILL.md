---
name: tooling-and-dependencies
description:
  Use when running repo scripts, adding or changing dependencies, editing
  package.json files, installing packages, or deciding how moon/pnpm workspace
  commands should be invoked in this monorepo.
---

# Tooling and Dependencies

## Toolchain (proto)

- Tool versions (bun, pnpm, node, moon, gh) are pinned in `.prototools` and
  managed by [proto](https://moonrepo.dev/docs/proto); run `proto use` if a tool
  is missing or a pin changed.
- Bump a tool by editing `.prototools` only — never install tools globally or
  pin versions elsewhere. moon's version is additionally enforced by
  `versionConstraint` in `.moon/workspace.yml`; keep both in sync.

## Package Manager and Runtime

- Use `pnpm` for package operations: install, add, remove, dedupe, lockfile, and
  publish work.
- Do not use `npm`, `yarn`, `npx`, or other package runners for package
  operations unless there is a specific documented reason.
- Bun remains the direct TypeScript runtime and test runner where moon tasks
  invoke it (`bun test`, root scripts under `scripts/*.ts`). Local scripts may
  still be `.ts` files without a separate compile step.

## Dependency Catalog

This monorepo uses the `catalog` in `pnpm-workspace.yaml`.

- Never add a version directly to an individual package's `package.json` by
  default.
- To add a dependency:
  1. Add the exact version to `pnpm-workspace.yaml` under `catalog`, for example
     `"new-package": "1.2.3"`.
  2. Reference it from the package with `"new-package": "catalog:"`.
- Do not run `pnpm add <package>` inside a package directory; it writes direct
  versions and breaks the catalog pattern unless you manually normalize them.
- Published packages may intentionally use ranges for end-user compatibility.
  The four MIT-licensed packages (`core`, `client`, `cli`, `mcp` — tagged
  `publishable` in their `moon.yml`) should stay on catalog versions unless a
  specific range is required for a publish.

## Tasks

- moon is the task runner; `package.json` scripts exist only for npm lifecycle
  hooks (`prepublishOnly`). Never add task scripts back to a package.json.
- Tasks are defined in `.moon/tasks/*.yml` (inherited by tag/language) and each
  project's `moon.yml`. Repo-wide tooling (format, lint, check-licenses, clean,
  the worktree manager) lives on the `root` project.
- Run tasks from anywhere in the repo:

```bash
moon run <project>:<task>
moonx <project>:<task>             # shorthand for moon exec
moonx <project>:<task> -- --flags  # forward arguments after --
moon run :test                     # a task across every project that has it
moon tasks <project>               # discover a project's tasks
```

moon builds dependency projects first (`deps: ['^:build']`), caches outputs, and
skips tasks whose inputs have not changed.
