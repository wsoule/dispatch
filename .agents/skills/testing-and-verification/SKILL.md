---
name: testing-and-verification
description:
  Use when adding or running tests, checking snapshots, choosing between Bun
  tests and Playwright, running lint/format/typecheck, or deciding the
  verification scope for a change.
---

# Testing and Verification

## Baseline Commands

After code changes, run the required baseline from anywhere in the repo:

```bash
moon run root:format
moon run root:lint
```

Useful check/fix pairs also run from anywhere in the repo:

```bash
moon run root:format-check
moon run root:format
moon run root:lint
moon run root:lint-css
moon run root:lint-deadcode
```

The `-fix` lanes rewrite source, so they are `runInCI: 'skip'` and a CI-marked
shell (any agent harness, where `CI` is set) refuses them under `moon run`. Use
`moonx` with the escape hatch:

```bash
moonx root:lint-fix --ignore-ci-checks
moonx root:lint-css-fix --ignore-ci-checks
moonx root:lint-deadcode-fix --ignore-ci-checks
```

## Dead Code

`moon run root:lint-deadcode` runs knip, which fails on any unused file, export,
type, dependency, or binary. It is gated at zero, so deleting the last caller of
something makes the build red until the thing itself goes too.

The task needs a build first — knip resolves cross-package imports through each
`package.json`'s `exports` field, which points at `dist/`; moon's
`deps: ['^:build']` handles this automatically, so just run:

```bash
moon run root:lint-deadcode
```

Config lives in `knip.json`. Entry points it cannot infer, runtime-resolved
workspace deps, and moon-specific false positives (the built-in `noop` command,
per-package build tools the root-only `moonrepo` plugin can't see) are declared
there with comments.

For code changes, also run the relevant project-level typecheck:

```bash
moonx <project>:typecheck
```

## Unit and Integration Tests

Use Bun's built-in test runner. Tests usually live in a `test/` folder inside
each package and use `describe`, `test`, and `expect` from `bun:test`.

Prefer unit or integration tests by default:

```bash
moonx <project>:test
moon run :test           # every project that has a test task
moonx :test --affected   # only projects affected by staged/changed files
```

Other packages and apps should expose local test scripts when relevant.

## Snapshots

Bun supports `toMatchSnapshot()`. Avoid new snapshot coverage unless it is
shallow and narrowly scoped to the exact behavior under test.

Update snapshots from the package directory:

```bash
cd <package-or-app> && bun test -u
```

## Browser and E2E Tests

Add Playwright/browser E2E tests only when behavior cannot be validated without
a real browser engine. Good candidates include computed style checks, shadow DOM
boundaries, and browser-only rendering behavior.

Keep E2E coverage small and high-value:

```bash
moonx desktop:e2e
```

If E2E fixtures or dev servers are started in a worktree, follow the cleanup
contract from the `worktrees-and-dev-servers` skill.
