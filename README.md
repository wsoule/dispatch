# Dispatch

Mission control for coding agents. Create a task, dispatch an agent, watch it
work — runs, review, and merge in one desktop app.

<!-- TODO(asset): docs/assets/dispatch-hero.gif — task → dispatch → review loop -->

- **Agents run with guardrails.** A task declares the paths it may write before
  the agent starts; runs carry budget and turn caps, verify gates, and
  human-gated scope escalation.
- **Everything is on the record.** Findings, decisions, evidence, and
  transcripts from every run are kept — reviewable, not scrolled past.
- **Local-first.** Runs on your machine, against your checkout, with your API
  key. No account, no server, nothing uploaded.

## Install

Desktop app for macOS via Homebrew:

    brew install --cask wsoule/tap/dispatch

Or grab an installer from the
[latest release](https://github.com/wsoule/dispatch/releases/latest): macOS DMGs
(Apple Silicon and Intel) and Linux `.deb`/`.rpm`/`.AppImage`. macOS builds are
signed and notarized (Developer ID).

On macOS, installing the app also puts the `dispatch` CLI on your `PATH` (the
cask links the binary bundled inside `Dispatch.app`).

## Quickstart

In any git repo:

    dispatch init
    dispatch task create "My first task" --priority high
    dispatch task list
    dispatch task next
    dispatch doctor

Then open the Dispatch app and point it at the repo: the board shows your tasks,
and dispatching one hands it to a coding agent in an isolated git worktree —
live output, review, and merge all happen in the app.

Every read command accepts `--json` for agent/script consumption.

`dispatch init` also registers Dispatch's MCP server in the project's
`.mcp.json`, so tools like Claude Code can read and write the same tasks — see
[MCP server](#mcp-server).

## How it works

A task carries status, priority, `blocked-by`, declared `writes` paths, and a
human-readable body. The CLI, the desktop app, the MCP server, and the
orchestrator all read and write the same task state — today stored as markdown
files under `.dispatch/tasks/`, moving to a daemon-owned store
([direction](docs/TEAM-SERVER.md)).

Dispatching a task runs a coding agent in an isolated git worktree, scoped to
the task's declared `writes`. Touching anything else requires a human-gated
scope request at runtime; runs carry budget (`maxBudgetUsd`) and turn caps, and
verify gates check exit criteria before review. Findings, rulings, evidence, and
decisions from each run are recorded alongside the tasks.

`dispatchd`, a local daemon, watches the repo and feeds the app live runs,
review, and merge. It is local HTTP only — nothing leaves the machine.

## MCP server

`dispatch init` registers a stdio MCP server in the project's `.mcp.json`
(created or merged — existing servers and keys are preserved):

    {
      "mcpServers": {
        "dispatch": { "command": "dispatch", "args": ["mcp"] }
      }
    }

Pass `--no-mcp` to skip this. Start the server directly with `dispatch mcp`
(reads the current directory) or the standalone `dispatch-mcp --root <dir>`
binary from `@dispatch/mcp`.

The five `task_*` tools operate directly on `.dispatch/tasks/*.md` and need no
daemon (a running `dispatchd` picks up their file changes through its watcher
like any other edit). The other nine talk to `dispatchd` over its local HTTP
API, and return a clear error when it isn't running. As task storage moves into
the daemon ([direction](docs/TEAM-SERVER.md)), the five file-direct tools will
route through it too.

Tools (server name `dispatch`):

| Tool              | Input                                                                                                        | Output                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `task_list`       | `{ status?, kind?, parent? }`                                                                                | `{ tasks: TaskSummary[], problems: string[] }` |
| `task_get`        | `{ id }`                                                                                                     | `{ meta, body }`                               |
| `task_save`       | `{ id?, title?, status?, kind?, parent?, blockedBy?, labels?, priority?, assignee?, description?, writes? }` | `{ meta, body }`                               |
| `task_comment`    | `{ id, text }`                                                                                               | `{ meta }`                                     |
| `task_next`       | `{}`                                                                                                         | `{ tasks: TaskSummary[], problems: string[] }` |
| `run_list`        | `{}`                                                                                                         | `{ runs, note? }`                              |
| `agent_message`   | `{ runId? \| taskId?, text }`                                                                                | `{ ok, runId }`                                |
| `message_user`    | `{ text }`                                                                                                   | `{ ok, runId }`                                |
| `ask_user`        | `{ question, options? }`                                                                                     | `{ answer }`                                   |
| `request_scope`   | `{ paths, reason }`                                                                                          | `{ granted, reason }`                          |
| `dispatch_note`   | `{ kind, title, body? }`                                                                                     | `{ ok, id }`                                   |
| `record_decision` | `{ kind, title, detail, appliesTo? }`                                                                        | `{ ok, id }`                                   |
| `record_evidence` | `{ command, exitCode, durationMs, summary }`                                                                 | `{ ok }`                                       |
| `record_mutation` | `{ guard, file, testsFailed }`                                                                               | `{ ok }`                                       |

`task_save` creates when `id` is omitted (title required) and updates only the
given fields otherwise; `kind` and `description` take effect on create only.
`ask_user` and `request_scope` block until a human answers or the wait times
out. A `workflow://onboarding` resource briefs a connecting agent on the same
conventions. See `docs/archive/plans/2026-07-20-phase-3-mcp-server.md` for the
original design.

## Dependency graph with Carto (optional)

Dispatch can use [Carto](https://github.com/theanshsonkar/carto) to compute
which files a change can break, which narrows code-review scope to the actual
blast radius instead of just the changed files. Without it, Dispatch falls back
to a built-in scanner that only understands TypeScript/TSX — on a Go, Python, or
Rust repo it finds nothing, and review scope silently shrinks to the changed
files alone. `dispatch doctor` reports which backend is in use, including a
warning when there's neither carto nor TypeScript to work from.

    npm install -g carto-md

`carto.enabled` in `.dispatch/config.yml` controls the policy (default `on`):
`on` builds a carto container if one is missing, `detect` uses one only if it
already exists, and `off` sticks to the built-in scanner. `on` is a build
policy, not a requirement — a missing `carto` binary always degrades to the
scanner rather than failing. Whatever builds the container — `dispatch init` or
the daemon on a project that upgraded into this — adds the `.carto/` build
output to `.gitignore` automatically.

<details>
<summary>Troubleshooting the Carto install</summary>

carto's native dependencies (`better-sqlite3`, `tree-sitter`) don't build on
every Node version: in our testing only `npm install -g` under Node 22 LTS
produced a working install; newer Node lines failed to compile the bindings, and
`bun install -g` did not produce a working native build. A half-built install is
easy to miss, because `carto --version` answers fine without loading a single
native module — `dispatch doctor` runs carto's own `doctor` to catch it.

carto's MCP server (`carto serve`) is wired into dispatched agents' tool config
from carto 2.1.4 onward. Earlier releases started the server without connecting
its transport ([carto#9](https://github.com/theanshsonkar/carto/issues/9)), so
Dispatch withholds the MCP entry below that version rather than spawning one
that answers nothing. Blast radius is unaffected either way: that path reads the
container as a library, not over MCP.

</details>

## Development

All six roadmap phases are complete — tracker core, CLI, `dispatchd`, the MCP
server, the desktop app, and the orchestrator. Roadmap:
`docs/archive/plans/2026-07-13-dispatch-roadmap.md`.

To run the CLI from a checkout instead of the installed app:

    bun install && bun run build
    node packages/cli/dist/cli.js init
    node packages/cli/dist/cli.js doctor

Bun monorepo (workspace catalog, tsdown builds, `bun test`, oxlint/oxfmt). From
the repo root: `bun run build`, `bun run test`, `bun run tsc`, `bun run format`,
`bun run lint`. Agent conventions live in `AGENTS.md` and `.agents/skills/`.

### Daemon + web UI

`apps/desktop` is the product's UI and where frontend work happens;
`packages/web` is frozen as a browser fallback.

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

## Design docs

- **Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — what the
  system is today. Start here.
- Historical plans, specs, and research live in
  [`docs/archive/`](docs/archive/README.md). They record why decisions were made
  and are not maintained; where they disagree with `ARCHITECTURE.md`, the
  architecture doc is the checked one.

## License

[Functional Source License 1.1, Apache 2.0 Future License](LICENSE)
(`FSL-1.1-ALv2`) — source-available, not OSI open source.

In practice you may read, build, modify, self-host, and redistribute Dispatch
for any purpose except shipping a competing product or service. Internal use,
non-commercial education and research, and professional services you deliver to
a licensee are all explicitly permitted. **Each release converts to Apache-2.0
two years after it ships**, and that grant is irrevocable.

Versions up to and including v0.13.1 were published under Apache-2.0 and remain
Apache-2.0 forever.
