---
name: typescript-monorepo
description:
  Use when adding or changing packages/apps, TypeScript configs, workspace
  dependencies, package references, exports, or monorepo project-reference
  relationships.
---

# TypeScript Monorepo

## TypeScript

Use TypeScript everywhere practical. Compiler settings are intentionally fairly
strict.

- Shared compiler options live in `tsconfig.options.json`.
- Root `tsconfig.json` manages project references across the monorepo.
- Typecheck through moon rather than a raw `tsc`/`tsgo` invocation:
  `moonx <project>:typecheck` (this builds workspace dependencies first, since
  cross-package imports resolve through each dependency's `dist/` rather than TS
  project references).

## Project References

When adding a new package or app:

- Add it to the root `tsconfig.json` references.
- Ensure its local `tsconfig.json` follows existing package/app patterns.
- Give it a `moon.yml`; shared task shapes come from `.moon/tasks/*.yml` via
  `language`/`tag` inheritance (see `bun-common.yml`, `tag-tsdown.yml`,
  `tag-publishable.yml`).

When one workspace package depends on another:

- Add the dependency as `workspace:*` in the consuming package.
- Add the dependency to the consuming package's TypeScript `references` block
  when needed for accurate and fast typechecking.

## Workspace Dependencies

Use the dependency catalog rules from `tooling-and-dependencies` for external
packages. Use `workspace:*` for internal package dependencies.

If a package is published (tagged `publishable` in its `moon.yml` — currently
`core`, `client`, `cli`, `mcp`), review its `exports`, `typesVersions`, `files`,
peer dependencies, and publish scripts before changing public entrypoints or
dependency ranges. `moonx <project>:prepublish` runs its publish guard chain.
