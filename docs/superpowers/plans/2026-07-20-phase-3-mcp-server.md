# Phase 3: MCP Server Implementation Plan

**Goal:** Any MCP client (Claude Code first) can read and write Dispatch tasks:
a stdio MCP server exposing five consolidated tools + an onboarding resource,
launched via `dispatch mcp`, registered in the project's `.mcp.json` by
`dispatch init`.

**Architecture:** New Node-runnable package `packages/mcp` (@dispatch/mcp) built
on the official `@modelcontextprotocol/sdk`. **Direct core access** (TaskStore
file I/O) — no daemon proxy: mutations write task files, and a running
dispatchd's watcher picks them up automatically, so MCP and daemon stay
consistent through the filesystem (spec's files-are-truth rule doing its job).
Research basis: spec §6 + `docs/research/2026-07-13-landscape-research.md` §4
(consolidated tools beat API mirrors; semantic ids; workflow resources as agent
onboarding — backlog.md's proven pattern). Deviation from spec §6 (record in
roadmap): no daemon-proxy shim in v1 — the filesystem is the sync point; revisit
when run-control tools (Phase 4+) need live daemon state.

## Global Constraints

- Template conventions: catalog deps, `bun test`, tsdown build, tsgo typecheck,
  oxlint/oxfmt, ESM strict. Package must stay **Node-runnable** like the CLI (no
  `bun:` APIs).
- Catalog additions: `@modelcontextprotocol/sdk` (latest stable 1.x — check
  `bun info @modelcontextprotocol/sdk version`, pin exact) and `zod` (exact
  latest 3.x/4.x compatible with the SDK's peer range).
- Tool names/messages mirror CLI semantics exactly (same validation, same error
  text — statuses against `loadConfig().statuses`, kind/priority/assignee
  against core constants).
- All tools return `structuredContent` with matching `outputSchema`; reads carry
  `readOnlyHint: true`; `task_save` carries `idempotentHint: true`; nothing
  carries `destructiveHint` (no delete tool in v1).

## Surface

Tools (server name `dispatch`, tools prefixed naturally by client):

1. `task_list` — input `{ status?, kind?, parent? }`; output
   `{ tasks: TaskSummary[] }` where TaskSummary = meta fields only (id, title,
   status, kind, parent, blockedBy, labels, priority, assignee, created,
   updated) — bodies excluded to keep payloads small.
2. `task_get` — `{ id }` → full `{ meta, body }`; unknown id → MCP tool error
   (`isError: true`, message `task not found: <id>`).
3. `task_save` — upsert:
   `{ id? , title?, status?, kind?, parent?, blockedBy?, labels?, priority?, assignee?, description? }`.
   No `id` → create (title required, non-empty). With `id` → update of provided
   fields (undefined = untouched; description replaces the `## Description`
   section is NOT supported in v1 — document that description applies to create
   only, updates go through task_comment/activity or the UI; keeps core's
   UpdatePatch contract).
4. `task_comment` — `{ id, text }` → appends `- <iso> <text>` to Activity via
   UpdatePatch.appendActivity; returns updated meta.
5. `task_next` — `{}` → `{ tasks: TaskSummary[] }` of ready work (core
   readyTasks), priority-ordered.

Resource: `workflow://onboarding` (`text/markdown`) — how an agent should use
the tracker: id format, ready-work loop (`task_next` → work → `task_comment`
progress → `task_save` status), status semantics incl. config-driven statuses,
one-file-per-task layout for direct file access as an alternative. Write it for
an agent audience, ~40 lines.

Rooting: the server operates on `--root <dir>` (default cwd) — `dispatch mcp`
passes its cwd. Not initialized → every tool returns a clean MCP error telling
the agent to run `dispatch init`.

## Delivery

- `packages/mcp/src/{server.ts,tools.ts,onboarding.ts,bin.ts}` +
  tsconfig/tsdown/package.json (bin `dispatch-mcp`, exports server factory
  `createDispatchMcpServer(rootDir): McpServer` for tests + CLI reuse).
- CLI: `dispatch mcp` command (packages/cli) — spawns nothing, imports
  @dispatch/mcp and runs the stdio transport in-process (CLI is already Node;
  add workspace dep).
- `dispatch init` gains `.mcp.json` registration: create or merge (never clobber
  other servers)
  `{ "mcpServers": { "dispatch": { "command": "dispatch", "args": ["mcp"] } } }`;
  `--no-mcp` flag skips; idempotent. Document the PATH assumption in README
  (packaged story lands Phase 6).
- Tests (bun test, but Node-compatible code): use the SDK's
  `InMemoryTransport.createLinkedPair()` + `Client` to drive the real server
  in-process — list/get/save/comment/next round-trips against temp repos;
  validation errors; not-initialized error; onboarding resource read;
  `.mcp.json` merge cases in CLI tests. One e2e smoke: spawn built
  `dispatch mcp` binary, drive a `tools/list` + one `tools/call` over stdio
  JSON-RPC (raw newline-delimited messages are fine), assert response — proves
  the Node bin + stdio transport actually work.
- README: MCP section (register snippet, tool table).
- Roadmap: mark Phase 3 + deviation note.
