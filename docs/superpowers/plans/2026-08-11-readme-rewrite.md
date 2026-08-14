# README Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the root `README.md` with an install-focused rewrite (hero
pitch + GIF, install, user quickstart) that retains all existing content
below the fold, per `docs/superpowers/specs/2026-08-11-readme-rewrite-design.md`.

**Architecture:** Single-file rewrite of `README.md` plus one new binary
asset (`docs/assets/dispatch-hero.gif`). No code changes.

**Tech Stack:** Markdown, GitHub-flavored (including `<details>`), GIF
capture via the desktop app against a mock project.

## Global Constraints

- Docs-only change: verification baseline is `bun run format` and
  `bun run lint` from the repo root (per `AGENTS.md`).
- Preserve trailing newlines at end of files.
- No existing README information may be deleted — reworded or relocated
  within the file only (spec: "Out of scope").
- The quickstart must only use commands a `brew install --cask
  wsoule/tap/dispatch` user actually has: the cask symlinks the bundled CLI
  onto PATH as `dispatch` (verified against the tap's `Casks/dispatch.rb`).
- Do not commit anything outside the files this plan names — other sessions
  have uncommitted work in the tree. Use `git commit --only <paths>`.

---

### Task 1: Rewrite README.md

**Files:**
- Modify: `README.md` (full replacement)

**Interfaces:**
- Consumes: current `README.md` content (all of it is preserved below the
  fold), spec at `docs/superpowers/specs/2026-08-11-readme-rewrite-design.md`.
- Produces: the hero GIF reference `docs/assets/dispatch-hero.gif` that
  Task 2 must satisfy (exact path).

- [ ] **Step 1: Replace the top of the file (title through the old intro)**

Replace lines 1–9 of the current README (the `# Dispatch (working title)`
heading, the intro paragraph, and the `**Status:**` paragraph) with:

```markdown
# Dispatch

Mission control for coding agents. Create a task, dispatch an agent, watch
it work — runs, review, and merge in one desktop app.

![Dispatch: create a task, dispatch an agent, review the run](docs/assets/dispatch-hero.gif)

- **Tasks live in your repo.** Every task is a markdown file in
  `.dispatch/tasks/*.md` — synced by git, readable by humans and agents
  alike.
- **Agents run with guardrails.** A task declares the paths it may write
  before the agent starts; runs carry budget and turn caps, verify gates,
  and human-gated scope escalation.
- **Local-first.** Runs on your machine, against your checkout, with your
  API key. No account, no server, nothing uploaded.
```

The `**Status:**` sentence ("all six roadmap phases are complete…") moves
into the Development section in Step 4 — it is contributor-facing, not
install-facing.

- [ ] **Step 2: Keep Install where it now stands, immediately after the hero**

The existing `## Install` section (Homebrew command, release links, signing
note) is retained verbatim, with one addition at the end so the quickstart
follows honestly:

```markdown
Installing the app also puts the `dispatch` CLI on your `PATH` (the cask
links the binary bundled inside `Dispatch.app`).
```

The `### Dependency graph (optional)` subsection currently nested under
Install moves to its own top-level section in Step 5 — it is tuning, not
installation.

- [ ] **Step 3: Rewrite Quickstart for installed users**

Replace the current build-from-source quickstart with:

```markdown
## Quickstart

In any git repo:

    dispatch init
    dispatch task create "My first task" --priority high
    dispatch task list
    dispatch task next
    dispatch doctor

Then open the Dispatch app and point it at the repo: the board shows your
tasks, and dispatching one hands it to a coding agent in an isolated git
worktree — live output, review, and merge all happen in the app.

Every read command accepts `--json` for agent/script consumption.

`dispatch init` also registers Dispatch's MCP server in the project's
`.mcp.json`, so tools like Claude Code can read and write the same tasks —
see [MCP server](#mcp-server).
```

The old `bun install && node packages/cli/dist/cli.js …` block moves to
Development (Step 6) as the from-source flow.

- [ ] **Step 4: Add a short "How it works" section after Quickstart**

```markdown
## How it works

A task is a markdown file with frontmatter — status, priority, `blockedBy`,
declared `writes` paths, and more — and a human-readable body. The CLI, the
desktop app, the MCP server, and the orchestrator all read and write those
same files, so git is both the sync layer and the history.

Dispatching a task runs a coding agent in an isolated git worktree, scoped
to the task's declared `writes`. Touching anything else requires a
human-gated scope request at runtime; runs carry budget (`maxBudgetUsd`)
and turn caps, and verify gates check exit criteria before review. Findings,
rulings, evidence, and decisions from each run are recorded alongside the
tasks.

`dispatchd`, a local daemon, watches the repo and feeds the app live runs,
review, and merge. It is local HTTP only — nothing leaves the machine.
```

- [ ] **Step 5: Reflow the retained deep-dive sections**

In order after "How it works":

1. `## MCP server` — current content retained, but the first paragraph is
   tightened to:

```markdown
## MCP server

`dispatch init` registers a stdio MCP server in the project's `.mcp.json`
(created or merged — existing servers and keys are preserved). Pass
`--no-mcp` to skip this. Start the server directly with `dispatch mcp`
(reads the current directory) or the standalone `dispatch-mcp --root <dir>`
binary from `@dispatch/mcp`.
```

   The paragraph about the five `task_*` tools needing no daemon, the tools
   table, and the `workflow://onboarding` note are kept exactly as they are.
   Drop only the sentence "The registration assumes `dispatch` is on `PATH`;
   a packaged installer lands in a later phase." — the installer shipped;
   the cask puts `dispatch` on PATH (Step 2 says so).

2. `## Dependency graph with Carto (optional)` — promoted from its current
   spot under Install. Keep visible: the first paragraph (what blast-radius
   scoping does, the TS-only fallback scanner, `dispatch doctor` reporting),
   the `npm install -g carto-md` command, and the `carto.enabled` policy
   paragraph. Fold the two troubleshooting paragraphs (Node-version/native
   build failures, and the carto < 2.1.4 MCP transport issue with the
   [carto#9](https://github.com/theanshsonkar/carto/issues/9) link) into:

```markdown
<details>
<summary>Troubleshooting the Carto install</summary>

[the two retained paragraphs, verbatim]

</details>
```

- [ ] **Step 6: Consolidate Development**

`## Development` keeps its current content (monorepo tooling paragraph,
daemon + web UI subsection) and gains, at the top, the relocated status
sentence and the old from-source quickstart:

```markdown
## Development

All six roadmap phases are complete — tracker core, CLI, `dispatchd`, the
MCP server, the desktop app, and the orchestrator. Roadmap:
`docs/superpowers/plans/2026-07-13-dispatch-roadmap.md`.

To run the CLI from a checkout instead of the installed app:

    bun install && bun run build
    node packages/cli/dist/cli.js init
    node packages/cli/dist/cli.js doctor
```

`## Design docs` and `## License` close the file unchanged.

- [ ] **Step 7: Verify nothing was dropped, then format and lint**

Run: `git diff README.md` and check every removed line reappears (reworded
or relocated) somewhere in the new file; the only sanctioned deletions are
"(working title)" and the packaged-installer sentence noted in Step 5.

Run from the repo root:

    bun run format
    bun run lint

Expected: lint reports 0 errors (warnings pre-exist). The formatter may
rewrap the markdown; that is fine.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit --only README.md -m "docs: rewrite README around install conversion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Capture the hero GIF

**Files:**
- Create: `docs/assets/dispatch-hero.gif`
- Modify: `README.md` (only if the fallback fires — see Step 4)

**Interfaces:**
- Consumes: the image reference `docs/assets/dispatch-hero.gif` written in
  Task 1 Step 1.
- Produces: the asset at that exact path, ≤ 5 MB.

- [ ] **Step 1: Stage a believable project**

Use the existing mock-project generator under `.agents/ignore/` if present
(check `ls .agents/ignore/`); otherwise create a small throwaway repo under
the scratch directory with `dispatch init` and 4–6 tasks with realistic
titles and mixed statuses so the board looks lived-in.

- [ ] **Step 2: Record the loop**

Open the desktop app (or the browser-dev harness if the app cannot be
driven in this shell) against the staged project and record, via the
browser `gif_creator` tooling or macOS screen capture: create task →
dispatch → agent output streaming → review/findings view. Target 15–25
seconds, capture extra frames before and after actions for smooth playback,
window at a standard size (~1280×800).

- [ ] **Step 3: Optimize and place**

Save as `docs/assets/dispatch-hero.gif` (create `docs/assets/`). If over
5 MB, reduce (`gifsicle -O3 --lossy=80`, fewer frames, or a smaller
window) until under.

- [ ] **Step 4: Fallback if capture is not possible in this shell**

Known constraint: e2e/browser capture has failed in the agent shell before.
If two capture attempts fail, stop retrying: leave the README image line in
place but commented —
`<!-- TODO(asset): docs/assets/dispatch-hero.gif — task → dispatch → review loop -->`
— and file a Dispatch task titled "Record README hero GIF" describing
Steps 1–3 so it lands as a follow-up. The rewrite does not block on the
asset (spec: "The GIF").

- [ ] **Step 5: Verify and commit**

Confirm the README renders the GIF locally (e.g. `grep -n "dispatch-hero"
README.md` and open the file preview), then:

```bash
git add docs/assets/dispatch-hero.gif README.md
git commit --only docs/assets/dispatch-hero.gif --only README.md -m "docs: add README hero GIF

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
