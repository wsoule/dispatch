# Dispatch (working title)

Open-source, git-native task tracking and AI-agent orchestration. Tasks are
markdown files in your repo (`.dispatch/tasks/*.md`) — synced by git, readable
by humans and agents alike.

**Status:** Phase 1 (tracker core + CLI). Roadmap:
`docs/superpowers/plans/2026-07-13-dispatch-roadmap.md`.

## Quickstart

    bun install && bun run build
    node packages/cli/dist/cli.js init
    node packages/cli/dist/cli.js task create "My first task" --priority high
    node packages/cli/dist/cli.js task list
    node packages/cli/dist/cli.js task next
    node packages/cli/dist/cli.js doctor

Every read command accepts `--json` for agent/script consumption.

## Development

Bun monorepo (workspace catalog, tsdown builds, `bun test`, oxlint/oxfmt). From
the repo root: `bun run build`, `bun run test`, `bun run tsc`, `bun run format`,
`bun run lint`. Agent conventions live in `AGENTS.md` and `.agents/skills/`.

### Daemon + web UI (Phase 2)

Run the daemon and the web UI's dev server side by side for live-reloading
frontend work:

    bun packages/server/src/bin.ts --root <path-to-a-dispatch-repo> --port 4771
    bun ws web dev

`bun ws web dev` proxies `/api` and `/ws` to `http://127.0.0.1:4771` (see
`packages/web/vite.config.ts`), so the Vite dev server on its own port talks to
a real dispatchd. For a production-style check, `bun run build` builds the web
UI into `packages/web/dist`, then dispatchd serves it directly — no separate
frontend server needed. `dispatch serve` / `dispatch ui` (from `@dispatch/cli`)
wrap this daemon for end users.

### MCP server (Phase 3)

`dispatch init` registers a stdio MCP server in the project's `.mcp.json`
(created or merged — existing servers and keys are preserved):

    {
      "mcpServers": {
        "dispatch": { "command": "dispatch", "args": ["mcp"] }
      }
    }

Pass `--no-mcp` to `dispatch init` to skip this. The registration assumes
`dispatch` is on `PATH`; a packaged installer lands in a later phase. Start the
server directly with `dispatch mcp` (reads the current directory) or the
standalone `dispatch-mcp --root <dir>` binary from `@dispatch/mcp`. Both talk
stdio MCP and operate directly on `.dispatch/tasks/*.md` — no daemon required,
though a running `dispatchd` picks up the resulting file changes through its
watcher like any other edit.

Tools (server name `dispatch`):

| Tool           | Input                                                                                               | Output                     |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| `task_list`    | `{ status?, kind?, parent? }`                                                                       | `{ tasks: TaskSummary[] }` |
| `task_get`     | `{ id }`                                                                                            | `{ meta, body }`           |
| `task_save`    | `{ id?, title?, status?, kind?, parent?, blockedBy?, labels?, priority?, assignee?, description? }` | `{ meta, body }`           |
| `task_comment` | `{ id, text }`                                                                                      | `{ meta }`                 |
| `task_next`    | `{}`                                                                                                | `{ tasks: TaskSummary[] }` |

`task_save` creates when `id` is omitted (title required) and updates only the
given fields otherwise; `kind` and `description` take effect on create only. A
`workflow://onboarding` resource briefs a connecting agent on the same
conventions. See `docs/superpowers/plans/2026-07-20-phase-3-mcp-server.md` for
the full design.

## Design docs

- Spec:
  `docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md`
- Research: `docs/research/2026-07-13-landscape-research.md`

## License

Apache-2.0
