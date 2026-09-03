# Dispatch Monorepo

## Agent Environment

Set `AGENT=1` at the start of every terminal session so Bun's test runner emits
AI-friendly output:

```bash
export AGENT=1
```

Most local moon tasks (`root:format`, the worktree manager) are configured with
`runInCI: 'always'` so they keep working in CI-marked shells like agent
harnesses. Two groups stay CI-skipped and need
`moonx <target> --ignore-ci-checks`:

- Tasks connected to the build graph — dev servers, e2e variants, publish
  guards. `moonx desktop:dev --ignore-ci-checks`.
- Tasks that destroy or rewrite the tree — `root:clean`, `root:clean-all`,
  `root:lint-fix`, `root:lint-css-fix`. `moon ci` with no explicit targets runs
  every affected task that is not skipped, and an eligible `clean-all` would
  delete `node_modules` from under the pipeline running it.

For non-moon commands that CI-gate themselves, unset the var:
`CI= pnpm publish --dry-run`.

## Toolchain

- Tool versions (bun, pnpm, node, moon, gh) are pinned in `.prototools` and
  managed by [proto](https://moonrepo.dev/docs/proto); run `proto use` if a tool
  is missing or a pin changed.
- [moon](https://moonrepo.dev/docs) is the task runner. Each package also keeps
  a `package.json` script mirroring its moon task, and the two must move
  together: knip discovers entry points through plugins that key off those
  scripts, and tauri shells into `apps/desktop`'s by name. Where moon expresses
  a step as a task dependency instead of a shell `&&` (site's build before its
  test, say), the two read differently on purpose — moon is what CI runs.

## Core Rules

- Use `pnpm` for install/add/remove/dedupe/package-manager work. Do not use
  `bun`, `npm`, `yarn`, `npx`, or similar tools for package operations unless
  there is a specific reason.
- Dependencies use the `catalog` in `pnpm-workspace.yaml`. Never add dependency
  versions directly to package-level `package.json` files unless a published
  package intentionally needs its own range.
- Run tasks through moon: `moon run <project>:<task>` (or the `moonx` shorthand)
  works from anywhere in the repo. `moonx <project>:<task> -- args` forwards
  arguments. Discover tasks with `moon tasks <project>`.
- Preserve trailing newlines at the end of files.
- Setup steps for a fresh clone live in `CONTRIBUTING.md`.

## Licensing

Dispatch is open core (`LICENSING.md`) — license is per package, not uniform:

- `packages/core`, `packages/client`, `packages/cli`, `packages/mcp` are MIT.
- Everything else (`packages/server`, `packages/ui`, `packages/web`,
  `packages/demo`, `apps/desktop`, `apps/demo`, `apps/site`) is `FSL-1.1-ALv2`
  (`LICENSE`), source-available and converting to Apache-2.0 two years after
  each release.

When adding a new workspace package, add it to the `EXPECTED` map in
`scripts/check-licenses.ts` with the license the split above assigns it, set
`package.json`'s `"license"` field to match, and add a sibling `LICENSE` file
carrying that license's text (skip the file only for `UNLICENSED` packages).
`moon run root:check-licenses` enforces the package.json/LICENSE-file pairing
for every mapped package and runs in CI on every PR.

## Skills

Domain-specific context and conventions live in `.agents/skills/`. Before
starting any task:

1. List `.agents/skills/*/SKILL.md`
2. Read only each skill's frontmatter description to identify relevant skills
3. Read only the full `SKILL.md` files relevant to your task

Do not load skills that are not relevant to the task.

`.agents/skills/` is the single source of truth. `.claude/skills` is a symlink
to it so Claude Code's native skill discovery picks up the same files; edit the
skills under `.agents/skills/`, never through the symlink.

## Agent Artifacts

Write **every** agent-only file under `.agents/ignore/`. It is the single,
gitignored scratch directory for anything not meant to be committed: plans,
specs, throwaway scripts, scratch notes, logs, generated or downloaded data, and
any other working file. Do not scatter these across the repo root, package
directories, or the system temp dir.

- Plans: `.agents/ignore/plans/YYYY-MM-DD-<topic>.md`
- Specs: `.agents/ignore/specs/YYYY-MM-DD-<topic>.md`
- Anything else: a descriptively named subdirectory of `.agents/ignore/`

Do not put source files, tests, or committed documentation under
`.agents/ignore/`.

## Verification Baseline

After code changes, verification is not complete until you have run these from
anywhere in the repo:

```bash
moon run root:format
moon run root:lint
```

Also run the relevant `moonx <project>:typecheck` and focused
`moonx <project>:test` for the changed area. For docs-only or AGENTS/skill-only
changes, formatting and linting are sufficient unless the edit touches
executable code or package config.

## Code Readability

- When adding non-trivial helpers, prefer a short comment directly above the
  function explaining what the helper does and why it exists.
- Write comments for readers new to the codepath. Avoid vague shorthand unless
  you immediately explain what data is captured or derived.
- Prefer function-level comments over many inline comments. Use inline comments
  only when a specific step is still non-obvious.
- Keep comments concrete and behavior-focused.

<!-- CARTO:AUTO:START -->
## Project Structure (auto)

- 📁 .agents/
- 📁 .claude/
- 📁 .dispatch/
- 📁 .github/
- 📁 .husky/
- 📁 .moon/
- 📁 .proto/
- 📁 .superpowers/
- 📁 apps/
- 📁 docs/
- 📁 packages/
- 📁 scripts/
- 📄 .18c47b9fefbf7fbc-00000000.bun-build
- 📄 .18c47bbf8f9dfff8-00000000.bun-build
- 📄 .browserslistrc
- 📄 .cspell-dictionary.txt
- 📄 .dependency-cruiser.json
- 📄 .dockerignore
- 📄 .DS_Store
- 📄 .gitattributes
- 📄 .gitignore
- 📄 .jscpd.json
- 📄 .markdownlint-cli2.jsonc
- 📄 .mcp.json
- 📄 .node-version
- 📄 .nvim.lua
- 📄 .oxfmtrc.json
- 📄 .oxlintrc.json
- 📄 .prototools
- 📄 .stylelintignore
- 📄 bun.lock
- 📄 bunfig.toml
- 📄 CLAUDE.md
- 📄 CONTRIBUTING.md
- 📄 cspell.json
- 📄 dispatch-fix-changed-files.zip
- 📄 knip.json
- 📄 LICENSE
- 📄 LICENSING.md
- 📄 moon.yml
- 📄 package.json
- 📄 pnpm-lock.yaml
- 📄 pnpm-workspace.yaml
- 📄 README.md
- 📄 stylelint.config.js
- 📄 tsconfig.json
- 📄 tsconfig.options.json
- 📄 tsconfig.oxlint.json
- 📄 tsconfig.tsbuildinfo
**High impact:** packages/core/src/status.ts (97 dependents), packages/core/src/types.ts (96 dependents), packages/core/src/actor.ts (93 dependents), packages/core/src/describe.ts (93 dependents), packages/core/src/findings.ts (93 dependents), packages/core/src/ledger.ts (93 dependents), packages/core/src/evidence.ts (92 dependents), packages/core/src/ids.ts (92 dependents), packages/core/src/slug.ts (92 dependents), packages/core/src/taskfile.ts (92 dependents), packages/core/src/store.ts (91 dependents), packages/core/src/storeBackend.ts (91 dependents), packages/core/src/sqliteDb.ts (89 dependents), packages/core/src/sqliteRecords.ts (89 dependents), packages/core/src/sqliteTaskStore.ts (89 dependents)

## Context Files (auto)

Carto generated domain-specific context files in `.carto/context/`.
Read the relevant file before working on that area:

| Domain | File | Read when... |
|--------|------|--------------|
| Auth | `.carto/context/AUTH.md` | Working on login, sessions, OAuth |
| Payments | `.carto/context/PAYMENTS.md` | Working on billing, Stripe |
| tRPC | `.carto/context/TRPC.md` | Working on API procedures |
| Database | `.carto/context/DATABASE.md` | Working on models, schema |
| Events | `.carto/context/EVENTS.md` | Working on webhooks, jobs |
| Core | `.carto/context/CORE.md` | General utilities, shared code |

> Run `carto serve` to enable live graph queries from Kiro, Cursor, and Claude.
<!-- CARTO:AUTO:END -->
