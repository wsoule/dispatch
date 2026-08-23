---
name: github-actions-ci
description:
  Use when editing GitHub Actions workflows or composite actions, adding or
  bumping an action, changing the CI verify steps, or touching Dependabot
  config. Explains the SHA-pin rule that CI enforces and the shared
  proto/moon/pnpm setup.
---

# GitHub Actions and CI

## Pin every external action to a full commit SHA

CI has a dedicated `actions-pinned` job that scans `.github/` and **fails the
build** if any `uses:` references an action by tag or branch instead of a full
40-character commit SHA. Pinning a mutable tag like `@v6` is rejected because
the tag can be repointed at malicious code; a commit SHA is immutable.

Always write both the SHA and a trailing version comment:

```yaml
uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
```

The SHA is what CI enforces; the `# vX.Y.Z` comment is how humans and Dependabot
track the human-readable version. Keep both, and keep them in sync. Local
composite actions referenced with a `./` path are exempt — the rule targets
external actions only.

To find the SHA for a version, resolve the tag on the action's repo (for example
`git ls-remote https://github.com/actions/checkout v6.0.3`) rather than
guessing.

## Shared toolchain setup

Every CI job installs the toolchain through the local composite action
`./.github/actions/setup`. It reads every tool pin (bun, pnpm, node, moon, gh)
from `.prototools` via `moonrepo/setup-toolchain` (single source of truth — bump
a pin there and all jobs follow), caches the proto toolchain, the pnpm store,
and moon's hash/output cache, then runs `pnpm install --frozen-lockfile`. Reuse
this action in new jobs instead of re-adding setup steps, so the toolchain
version and install fast-path stay in one place.

## Verify steps

The `ci` job runs `moon ci` with an explicit target list covering build,
typecheck, test, and every root-level lint/audit/license task (see
`.github/workflows/ci.yml`). `moon ci` additionally runs every other affected
`runInCI`-enabled task through `--include-relations`, so the explicit list adds
cold-run entry points but never subtracts — a new root-level check with
`runInCI: 'always'` is picked up automatically; only add it to the explicit list
if you want it to always run even when nothing affects it.

## Dependabot

`.github/dependabot.yml` bumps SHA-pinned actions weekly in a single grouped PR
and rewrites both the SHA and the `# vX.Y.Z` comment automatically. It uses the
plural `directories` key with a glob so it covers both `.github/workflows` and
every local composite action under `.github/actions/*`. Do not switch to the
singular `directory` key (no globs) or `**` (a duplicate-PR bug for
github-actions). Let Dependabot own routine action bumps rather than
hand-editing SHAs for version updates.
