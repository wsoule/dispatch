# Contributing

Thanks for taking the time to contribute.

This monorepo uses [proto](https://moonrepo.dev/docs/proto) to manage the
toolchain and [moon](https://moonrepo.dev/docs) to run tasks. Every tool version
(bun, pnpm, node, moon, gh) is pinned in `.prototools`, so once proto is
installed, everything else resolves to the right version automatically when you
are inside the repo.

## Setup

1. **Install proto**
   ([official guide](https://moonrepo.dev/docs/proto/install)):

   ```bash
   curl -fsSL https://moonrepo.dev/install/proto.sh | bash
   ```

   Restart your shell afterwards so proto's shims are on your `PATH`.

2. **Clone and install the toolchain** — from the repo root, proto reads
   `.prototools` and installs the pinned bun, pnpm, node, moon, and gh:

   ```bash
   git clone git@github.com:wsoule/dispatch.git
   cd dispatch
   proto use
   ```

   (`.prototools` has `auto-install = true`, so simply running `pnpm`, `bun`, or
   `moon` also installs them on demand.)

3. **Install dependencies**:

   ```bash
   pnpm install
   ```

   Dependency versions live in the `pnpm-workspace.yaml` catalog; packages
   reference them with `"catalog:"`. Don't add versions directly to
   package-level manifests.

4. **Git hooks** are managed by moon (`vcs.hooks` in `.moon/workspace.yml`) and
   are generated automatically by the first moon command you run — no install
   step. Pre-commit typechecks the projects affected by your staged files,
   formats the worktree, then runs `lint-staged` to re-stage fixes.

## Running tasks

moon is the task runner — it is what CI and the git hooks use, and what you
should use. Packages do also keep a matching `package.json` script for each
task, kept byte-identical to the moon task: knip finds a workspace's entry
points through plugins that key off those scripts, and Tauri shells into
`apps/desktop`'s by name. Change a moon task and its script together. Tasks run
from anywhere in the repo:

```bash
moon run <project>:<task>      # e.g. moon run core:build
moonx <project>:<task>         # shorthand
moonx cli:test -- -h           # forward arguments after --
moon run :test                 # run a task across every project that has it
moon tasks <project>           # discover a project's tasks
moon project <project>         # inspect a project's config and dependencies
```

moon builds dependency projects first, caches outputs, and skips tasks whose
inputs haven't changed.

Common entry points:

| Task                             | What it does                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `moonx desktop:dev`              | Desktop app dev server (Vite)                                                        |
| `moonx desktop:tauri-dev`        | Desktop app inside the Tauri shell                                                   |
| `moonx web:dev`                  | Web UI dev server (proxies to a locally running `dispatchd`)                         |
| `moonx site:dev`                 | Marketing site dev server                                                            |
| `moonx sandbox:dev`              | Demo/sandbox environment dev server (`apps/demo`)                                    |
| `moonx <package>:test`           | Unit tests for one package                                                           |
| `moonx <project>:typecheck`      | Typecheck (builds workspace deps first)                                              |
| `moonx desktop:e2e`              | Desktop Playwright suite                                                             |
| `moon run root:format root:lint` | Repo-wide format + type-aware lint                                                   |
| `moonx root:wt -- new <slug>`    | Create a git worktree and reserve a dev-server port offset (see `scripts/README.md`) |

## Before you push

```bash
moon run root:format root:lint
moon exec :typecheck --affected
```

plus the focused tests for whatever you changed (`moonx <project>:test`). CI
runs `moon ci` with the affected portion of the graph, so a green local baseline
usually means a green PR.

## Repo conventions

- Agent-facing rules and the verification baseline live in `AGENTS.md`; deeper
  domain conventions live in `.agents/skills/`.
- Worktrees and dev-server port offsets are documented in `scripts/README.md`.
- Keep pull requests focused and reviewable. Include tests when behavior
  changes. Update docs when public APIs, setup, or workflows change.
- Disclose any AI assistance according to the receiving project's policy.

## License and CLA

Dispatch is open core — see [`LICENSING.md`](LICENSING.md). The integration
packages (`packages/core`, `packages/client`, `packages/cli`, `packages/mcp`)
are MIT; the rest of the repo is FSL-1.1-ALv2 (see [`LICENSE`](LICENSE)),
source-available and converting to Apache 2.0 two years after each release.

Outside contributions require a signed contributor license agreement (CLA
Assistant prompts on your first PR, once per contributor). The CLA is needed
because code in this repo may move across the license boundary — including into
the commercial team server. Your contribution lands under the license of the
package it touches.
