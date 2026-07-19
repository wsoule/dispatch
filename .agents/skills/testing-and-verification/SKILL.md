---
name: testing-and-verification
description:
  Use when adding or running tests, checking snapshots, choosing between Bun
  tests and Playwright, running lint/format/typecheck, or deciding the
  verification scope for a change.
---

# Testing and Verification

## Baseline Commands

After code changes, run the required baseline from the monorepo root:

```bash
bun run format
bun run lint
```

Useful check/fix pairs also run from the monorepo root:

```bash
bun run format:check
bun run format
bun run lint
bun run lint:fix
bun run lint:css
bun run lint:css:fix
```

For code changes, also run the relevant package-level typecheck:

```bash
cd <package-or-app>
bun run tsc
```

## Unit and Integration Tests

Use Bun's built-in test runner. Tests usually live in a `test/` folder inside
each package and use `describe`, `test`, and `expect` from `bun:test`.

Prefer unit or integration tests by default:

```bash
cd packages/template && bun test
bun ws template test
bun ws "packages/*" test --sequential
```

Other packages and apps should expose local test scripts when relevant.

## Snapshots

Bun supports `toMatchSnapshot()`. Avoid new snapshot coverage unless it is
shallow and narrowly scoped to the exact behavior under test.

Update snapshots from the package directory:

```bash
bun test -u
```

## Browser and E2E Tests

Add Playwright/browser E2E tests only when behavior cannot be validated without
a real browser engine. Good candidates include computed style checks, shadow DOM
boundaries, and browser-only rendering behavior.

Keep E2E coverage small and high-value:

```bash
cd apps/web && bun run test:e2e
bun ws web test:e2e
```

If E2E fixtures or dev servers are started in a worktree, follow the cleanup
contract from the `worktrees-and-dev-servers` skill.
