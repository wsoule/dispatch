# Landscape Research: Git-Native Agent Orchestration Platform

Date: 2026-07-13. Deep-research pass with adversarial verification (10 load-bearing claims checked: 8 confirmed, 2 partially corrected, 0 refuted).

## 1. The gap

No tool in mid-2026 combines all four of:

1. Linear-style tasks/epics stored as **human-readable files in plain git**
2. First-class **MCP server + CLI**
3. **Parallel worktree dispatch** of coding agents (Claude Code et al.)
4. Integrated **diff/review surface**

The two nearest poles:

- **Vibe Kanban** (BloopAI, Apache-2.0, ~27k stars) — the proven blueprint for the *dispatch/review* half: kanban UI, worktree-per-task-attempt, executor abstraction over 9 agent CLIs, in-app diff review, PR via `gh`, own MCP server (~40 tools). But: tasks live in SQLite (not git), no epic hierarchy, and Bloop shut down 2026-04-10; repo community-maintained, last push 2026-04-24. Mine it for patterns, don't build on it.
- **backlog.md** (MrLesk, MIT, ~6k stars, very active) — the proven blueprint for the *git-native task* half: one markdown file per task with YAML frontmatter, CLI + TUI + web kanban from one binary, stdio MCP server (19 tools), MCP resources as agent onboarding docs, cross-branch task-state resolution. But: dispatches nothing — no orchestration, worktrees, or review.
- **Beads** (Steve Yegge, MIT, ~25k stars, very active) — closest *conceptually*: git-synced agent-native issue graph, hash IDs (`bd-a1b2`), dependency types (blocks/parent-child/discovered-from), `bd ready` unblocked-work query, atomic claiming. But: no UI (deliberate), orchestration requires Gas Town, and v1.0 (Apr 2026) abandoned JSONL-in-git for embedded Dolt synced via a `refs/dolt/data` ref — the bidirectional JSONL↔SQLite sync "proved too fragile" (Yegge's own postmortem). This pivot re-opened the "human-readable tasks in plain git" niche and angered plain-text users.

Market context: hosted competitors died fast — Terragon (shut down Feb 2026, code open-sourced Apache-2.0), Codegen (acquired by ClickUp, service killed Jan 2026), Solver (absorbed by NVIDIA), Plandex (dormant), Omnara (archived), Crystal (→ Nimbalyst, MIT). Survivors are local-first: Conductor (closed-source macOS, $22M Series A), Cyrus (Apache-2.0 open-core, worktree-per-Linear-issue but task state lives in Linear SaaS), Sculptor (Imbue, MIT). Factory/Codex/Cursor all added Linear-ticket dispatch — validating the "dispatch agents from tickets" demand. The lesson: hosted is brutal; local-first OSS is the defensible position.

## 2. Git-native storage: what survived contact

Three architectures observed in the wild:

- **A. Files-in-repo** (backlog.md markdown-per-task; Beads-classic JSONL): free sync via git push/pull, branch-scoped, PR-reviewable, grep-able by agents. Wounds: sequential-ID collisions across branches (every tool hit this) and merge conflicts on shared files (task-master's single tasks.json is worst-case).
- **B. Separate git refs** (git-bug's operation-log DAG under `refs/bugs/*`, Lamport clocks, conflict-free by construction, content-hash IDs): elegant, but invisible to file tools/agents, hosting platforms and forks don't carry custom refs, and issues become repo-global instead of branch-scoped.
- **C. Merge-aware DB over git transport** (Beads-today: embedded Dolt through `refs/dolt/data`): real SQL, cell-level merges, but opaque storage — the thing plain-text users revolted over.

**Proven synthesis** (what the field converged on): hash-based IDs always; one human-visible record per task; a **gitignored SQLite cache derived one-way from files** (never bidirectional — that's the Beads-classic postmortem); sync over plain git.

## 3. Claude Agent SDK as the execution substrate

The TS Agent SDK (`@anthropic-ai/claude-agent-sdk`, v0.3.x, bundles its own CLI binary) now covers what Vibe Kanban hand-rolled over raw pipes:

- `query()` + streaming-input AsyncIterable → `interrupt()`, `setPermissionMode()`, follow-up messages mid-run
- `canUseTool` callback → route permission approvals to our UI (human-in-the-loop)
- In-process hooks: PreToolUse, PostToolUse, Stop (exit-2 blocks premature stop), SessionStart/End
- Sessions: `resume`, `forkSession`, `listSessions()`, `getSessionMessages()`
- Structured outputs via `outputFormat: json_schema` — key for the planner (prompt → epic/tasks JSON)
- In-process MCP servers via `createSdkMcpServer()` — inject task tools into agent runs without a subprocess
- Cost/turn caps: `maxBudgetUsd`, `maxTurns`; result carries `total_cost_usd`, per-model usage

Vibe Kanban patterns still worth lifting: pinned agent version; NormalizedEntry log schema (assistant text / tool-use with action type / thinking / token usage) streamed as JSON patches over WebSocket to a chat-style UI; worktree manager with aggressive pre-cleanup (`git worktree prune`, stale-metadata removal, retry-once); orphan-execution reconciliation at boot; execution-chain records (setup → agent → cleanup); PR creation via `gh` with retry + PR-state polling to auto-close tasks.

## 4. MCP surface design

- Spec revision current: 2025-11-25; a 2026-07-28 release candidate makes core stateless and reworks the experimental Tasks primitive → build on the official TS SDK, **don't** adopt MCP Tasks until final.
- Transport: **stdio launched per-project** (`npx <app> mcp`) declared in committed `.mcp.json` is the dominant local-first pattern; when a live daemon exists, use a thin stdio shim that proxies to it (Vibe Kanban's hybrid).
- Tool surface: 6–10 **consolidated** tools beat API mirrors (Linear merged create/update into `save_issue`; GitHub's 100+ tools need opt-in toolsets to stay usable). Starter set: `task_list`, `task_get`, `task_save` (upsert), `task_comment`, `task_next` (the most agent-loved tool in the space, per task-master/Beads).
- Semantic short IDs over UUIDs (agents hallucinate less); `readOnlyHint`/`destructiveHint` annotations; `outputSchema` + structuredContent; MCP *resources* as agent onboarding docs (`workflow://` — backlog.md's proven pattern).

## 5. UI/stack consensus

- **Localhost server + system browser via `npx`** is the field consensus for open-source infra tools (Vibe Kanban, backlog.md, OpenHands): zero-install, no code-signing, remote-capable. Tauri wrapper is a later option (VK was mid-pivot to exactly that); Electron only wins when raw PTY fidelity is the product.
- Live agent output: parse structured stream into normalized entries, render chat-style with collapsible tool calls; xterm.js only as escape hatch. WebSockets end-to-end (bidirectional: approvals, follow-ups).
- Diffs: Monaco diff / react-diff-viewer are what shipped; diff2html/shiki lighter.

## 6. Licensing notes

Apache-2.0 (Vibe Kanban, Cyrus, Terragon-oss) or MIT (backlog.md, Beads, Sculptor, Nimbalyst, OpenHands) both common. task-master's MIT + Commons Clause is *not* OSI open source — avoid that trap. AGPL (Claude Squad) limits reuse by others.
