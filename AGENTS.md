# Bun TypeScript Monorepo Template

## Agent Environment

Set `AGENT=1` at the start of every terminal session so Bun's test runner emits
AI-friendly output:

```bash
export AGENT=1
```

## Core Rules

- Use `bun` for commands and dependency work. Do not use `npm`, `pnpm`, `npx`,
  or similar tools unless there is a specific reason.
- Dependencies use Bun's root `workspaces.catalog`. Never add dependency
  versions directly to package-level `package.json` files unless a published
  package intentionally needs its own range.
- Run commands from the monorepo root when they operate across the repo. Use
  package directories for package-local scripts, or use
  `bun ws <project> <task>` as the root shortcut when that fits the task.
- Preserve trailing newlines at the end of files.

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
the monorepo root:

```bash
bun run format
bun run lint
```

Also run the relevant package-level `bun run tsc` and focused tests for the
changed area. For docs-only or AGENTS/skill-only changes, formatting and linting
are sufficient unless the edit touches executable code or package config.

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
- 📄 cspell.json
- 📄 dispatch-fix-changed-files.zip
- 📄 knip.json
- 📄 LICENSE
- 📄 package.json
- 📄 README.md
- 📄 stylelint.config.js
- 📄 tsconfig.json
- 📄 tsconfig.options.json
- 📄 tsconfig.oxlint.json
- 📄 tsconfig.tsbuildinfo

**Stack:** React **High impact:** apps/desktop/src/lib/utils.ts (165
dependents), apps/desktop/src/ui/button.tsx (97 dependents),
packages/core/src/types.ts (79 dependents), packages/core/src/actor.ts (77
dependents), packages/core/src/describe.ts (77 dependents),
packages/core/src/ids.ts (76 dependents), packages/core/src/slug.ts (76
dependents), packages/core/src/taskfile.ts (76 dependents),
packages/core/src/store.ts (75 dependents), packages/core/src/linearMap.ts (73
dependents), packages/core/src/configTypes.ts (72 dependents),
packages/core/src/team.ts (72 dependents), packages/core/src/conflicts.ts (71
dependents), packages/core/src/evidence.ts (71 dependents),
packages/core/src/findings.ts (71 dependents)

## Context Files (auto)

Carto generated domain-specific context files in `.carto/context/`. Read the
relevant file before working on that area:

| Domain   | File                         | Read when...                      |
| -------- | ---------------------------- | --------------------------------- |
| Auth     | `.carto/context/AUTH.md`     | Working on login, sessions, OAuth |
| Payments | `.carto/context/PAYMENTS.md` | Working on billing, Stripe        |
| tRPC     | `.carto/context/TRPC.md`     | Working on API procedures         |
| Database | `.carto/context/DATABASE.md` | Working on models, schema         |
| Events   | `.carto/context/EVENTS.md`   | Working on webhooks, jobs         |
| Core     | `.carto/context/CORE.md`     | General utilities, shared code    |

> Run `carto serve` to enable live graph queries from Kiro, Cursor, and Claude.

<!-- CARTO:AUTO:END -->
