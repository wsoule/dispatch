---
name: github-actions-ci
description:
  Use when editing GitHub Actions workflows or composite actions, adding or
  bumping an action, changing the CI verify steps, or touching Dependabot
  config. Explains the SHA-pin rule that CI enforces and the shared Bun setup.
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

## Shared Bun setup

Every CI job installs the toolchain through the local composite action
`./.github/actions/setup`. It reads the Bun version from `.prototools` (single
source of truth — bump it there and all jobs follow), restores the Bun install
cache, and runs `bun install --frozen-lockfile`. Reuse this action in new jobs
instead of re-adding setup steps, so the toolchain version and install fast-path
stay in one place.

## Verify steps

The `verify` job runs the repo's checks in this order: `format:check`, `lint`,
`lint:css`, `tsc`, `test`, `build`. When you add a new root-level check, add it
here too so CI and local verification stay aligned. Keep step commands as
`bun run <script>` wrappers rather than inlining tool invocations.

## Dependabot

`.github/dependabot.yml` bumps SHA-pinned actions weekly in a single grouped PR
and rewrites both the SHA and the `# vX.Y.Z` comment automatically. It uses the
plural `directories` key with a glob so it covers both `.github/workflows` and
every local composite action under `.github/actions/*`. Do not switch to the
singular `directory` key (no globs) or `**` (a duplicate-PR bug for
github-actions). Let Dependabot own routine action bumps rather than
hand-editing SHAs for version updates.
