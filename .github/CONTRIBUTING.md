# Contributing

Thanks for taking the time to contribute.

## Setup

Install dependencies with Bun:

```bash
bun install
```

## Development

Run the common verification commands from the repository root:

```bash
bun run format
bun run lint
bun run tsc
bun run test
```

Use `bun ws <project> <script>` to run a package script from the root:

```bash
bun ws core test
```

## Pull Requests

- Keep pull requests focused and reviewable.
- Include tests when behavior changes.
- Update docs when public APIs, setup, or workflows change.
- Disclose any AI assistance according to the receiving project's policy.

## License and CLA

Dispatch is open core — see [`LICENSING.md`](../LICENSING.md). The integration
packages (`packages/core`, `packages/client`, `packages/cli`, `packages/mcp`)
are MIT; the rest of the repo is FSL-1.1-ALv2 (see `LICENSE`), source-available
and converting to Apache 2.0 two years after each release.

Outside contributions require a signed contributor license agreement (CLA
Assistant prompts on your first PR, once per contributor; the full text is
[`CLA.md`](CLA.md)). The CLA is needed because code in this repo may move across
the license boundary — including into the commercial team server. Your
contribution lands under the license of the package it touches.

Maintainer setup note: the CLA workflow only hard-blocks merges once the "CLA
Assistant" job (the job name, not the "CLA / CLA Assistant" display string) is a
required status check on `main` — a repo-settings step, and one that only takes
effect once the repository is public.
