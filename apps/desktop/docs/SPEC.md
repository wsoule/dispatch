# Manageai — Product Requirements Document

**Version:** 1.0  
**Date:** July 2026  
**Status:** Pre-seed / YC Application  
**Author:** Tanmay Dabhadet

---

## 1. Executive Summary

AI coding agents are no longer experimental. Claude Code has 4.2M weekly active
users and contributes 4% of all public GitHub commits. Codex CLI, Gemini CLI,
Cursor Agent, and Windsurf are running concurrently in the same developer
workflows. The average developer using Claude Code spends 20 hours per week with
it — making it a core productive tool, not an accessory.

**The problem:** Developers running 3–5 agents simultaneously across multiple
repos have zero unified visibility into what those agents did, what it cost, or
whether it worked. Every session is a black box after it ends. No tool spans
more than one agent.

**Manageai** is the unified control plane for AI coding agents — a local-first
desktop application that reads native session logs from every major agent CLI,
normalizes them into a single interface, and gives developers and engineering
managers real-time visibility, cost tracking, and dispatch capability across all
their agents and projects.

**One-liner:** _Datadog for AI coding agents._

---

## 2. Problem

### 2.1 The Multi-Agent Reality (July 2026)

| Agent            | WAU   | Log Location                                | Format                                                          |
| ---------------- | ----- | ------------------------------------------- | --------------------------------------------------------------- |
| Claude Code      | 4.2M  | `~/.claude/projects/<proj>/<session>.jsonl` | JSONL — full transcript, tool calls, token usage, git snapshots |
| OpenAI Codex CLI | ~2M   | `~/.codex/`                                 | JSONL                                                           |
| Gemini CLI       | ~1M   | `~/.gemini/`                                | Custom JSON                                                     |
| Cursor Agent     | ~1.5M | `~/.cursor/logs/`                           | Partial JSONL                                                   |
| Windsurf         | ~500K | `~/.windsurf/sessions/`                     | JSON                                                            |

Total addressable CLI agent users: **~9M and growing**.

### 2.2 Core Pain Points

1. **No cross-agent view.** Claude Code, Codex, and Gemini each have isolated,
   incompatible session stores. No tool unifies them.
2. **Sessions die with the terminal.** Close the window, the context is gone.
   Claude Code deletes logs after 30 days by default.
3. **No cost visibility.** Developers have no idea what they spent per project,
   per session, or per agent, until the monthly bill arrives.
4. **No team visibility.** Engineering managers cannot see what any agent did
   across their org — which repos, which agents, what changed.
5. **No dispatch layer.** There is no UI to queue, assign, or monitor agent
   tasks across projects.

### 2.3 Existing Solutions and Why They Fall Short

| Tool                   | What It Does                                     | Gap                                       |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- |
| claude-code-log (PyPI) | CLI/TUI renders `~/.claude/` as HTML             | Claude-only, no UI, no project management |
| LM Assist              | Localhost web UI for Claude Code JSONL           | Claude-only, no Codex/Gemini, no dispatch |
| Mantra                 | Session viewer with git timeline alignment       | Claude-only, read-only                    |
| Claude Explorer        | Unified Claude Desktop + Code search             | Claude-only, no cross-agent               |
| Langfuse / AgentOps    | LLM observability for production deployed agents | SDK-instrumented, not CLI-native          |
| APM Framework          | Multi-agent workflow orchestration               | Orchestration, not observability          |

**The gap:** No product is cross-agent, cross-project, and
developer-workflow-native with a real GUI.

---

## 3. Product Vision

Manageai is a **local-first desktop application** (Tauri) that runs a background
daemon, reads native session logs from every major agent CLI, normalizes them
into a SQLite database, and surfaces a clean unified interface for session
history, cost tracking, timeline, connections management, and task dispatch.

**Everything stays local.** No cloud required. No data leaves the machine. Team
features are opt-in and run through a self-hostable sync layer.

---

## 4. Target Users

### Primary — Individual Power Developer

- Runs 2+ AI coding agents simultaneously
- Works across 3–8 repos at a time
- Paying for Claude Max ($100–$200/mo) or multiple agent subscriptions
- Has no idea what each agent actually did last Tuesday
- **Willingness to pay:** $15–20/month

### Secondary — Engineering Manager

- Manages a team of 5–15 developers, all running agents
- Needs visibility: what are agents doing, what is it costing, where is time
  being wasted
- Would pay per seat for cross-developer visibility
- **Willingness to pay:** $35/seat/month

### Tertiary — CTO / VP Engineering

- Wants org-wide cost governance on AI agent spend
- Wants audit trail for compliance
- **Willingness to pay:** Enterprise contract, $500–$2000/month per org

---

## 5. Core Features — V1 (MVP, Weeks 1–6)

### 5.1 Projects

- Import a local directory — Manageai detects git root and begins watching
- Displays per-project stats: sessions, lines added/removed, total agent spend,
  last active
- Language detection via git linguist heuristics
- Activity bars: decorative commit-frequency sparkline from git log
- Stack tag auto-detection from `package.json`, `requirements.txt`, `go.mod`,
  etc.

### 5.2 Sessions

- Flat chronological list of every session across all projects and agents
- Per-session metadata: agent, model, timestamp, duration, files changed, lines
  added/removed, token count, cost estimate
- AI-generated one-line summary (post-hoc, using the session prompt + first
  assistant response)
- Tag auto-classification: `feature`, `bugfix`, `refactor`, `test`, `docs`,
  `infra`
- Click-to-expand detail modal: full file list, diff stats, cost breakdown, open
  in editor

### 5.3 Timeline

- Chronological thread across all projects and agents
- Colored dots per agent
- Shows project, summary, tags, diff stats inline
- Filters: by agent, by project, by tag, by date range

### 5.4 Connections

- One card per connected agent showing: status, version, masked API key,
  projects using it, sessions today, last seen
- Detect and auto-connect agents by scanning known log directories on install
- Configure per-agent settings: log retention override (bypass the 30-day Claude
  Code default), log verbosity
- "Connect agent" flow for adding new integrations

### 5.5 Agent Manager

- Dispatch new tasks to any agent + project combination
- Task queue: running / queued / done with progress bar on running tasks
- Cancel or re-queue tasks
- Task history: what was dispatched, when, which agent ran it, outcome

---

## 6. Core Features — V2 (Weeks 7–14)

| Feature                 | Description                                                                      |
| ----------------------- | -------------------------------------------------------------------------------- |
| Team sync               | Opt-in encrypted sync layer so engineering managers see cross-developer sessions |
| Slack digest            | Daily/weekly AI-generated summary of agent activity, posted to a Slack channel   |
| Cost alerts             | Notify when project spend exceeds a threshold                                    |
| Agent comparison        | Side-by-side comparison of Claude vs Codex on the same repo over time            |
| Regression tagging      | Flag sessions where test suites broke post-session                               |
| CI/CD integration       | GitHub Actions hook that posts session summary as a PR comment                   |
| Natural language search | "Show me all sessions where Claude touched the database layer"                   |
| MCP server              | Expose session history as an MCP tool so agents can query their own past work    |

---

## 7. Technical Architecture

### 7.1 Stack

| Layer             | Technology                            | Rationale                                                    |
| ----------------- | ------------------------------------- | ------------------------------------------------------------ |
| Desktop shell     | **Tauri (Rust)**                      | Half the binary of Electron, no Chromium, native FS access   |
| Frontend          | **React + Vite**                      | Fast iteration, full ecosystem                               |
| Styling           | **Vanilla CSS with design tokens**    | No Tailwind runtime, full control                            |
| Local DB          | **SQLite via better-sqlite3**         | Embedded, zero infra, instant queries                        |
| FS watcher        | **Chokidar (Node) via Tauri sidecar** | Cross-platform, battle-tested                                |
| Session parsing   | **Custom parsers per agent**          | Each agent has a different log format                        |
| Background daemon | **Tauri sidecar (Node.js)**           | Runs on system startup via launchd/systemd                   |
| IPC               | **Tauri events**                      | Low-latency UI updates on new sessions                       |
| AI summaries      | **Claude API (Haiku 4.5)**            | Cheapest model, post-hoc summary generation, ~$0.001/session |

### 7.2 Daemon Architecture

```
Manageai Daemon (Node.js sidecar, always-on)
│
├── FS Watcher: ~/.claude/projects/**/*.jsonl
│     └── Parser: Claude Code JSONL → normalized Session record
│
├── FS Watcher: ~/.codex/**/*.jsonl
│     └── Parser: Codex JSONL → normalized Session record
│
├── FS Watcher: ~/.gemini/**/*.json
│     └── Parser: Gemini JSON → normalized Session record
│
├── FS Watcher: ~/.cursor/logs/**
│     └── Parser: Cursor partial JSONL → normalized Session record
│
├── Git hook: post-commit (installed per-project on import)
│     └── Diff capture: universal fallback for any agent
│
├── SQLite: normalized session DB
│     ├── projects table
│     ├── sessions table
│     ├── files_changed table
│     ├── agent_connections table
│     └── tasks table
│
└── Tauri IPC → Desktop UI (real-time events on new session)
```

### 7.3 SQLite Schema (Core Tables)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT UNIQUE NOT NULL,
  lang TEXT,
  stack TEXT,          -- JSON array
  created_at INTEGER,
  last_active INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  agent TEXT NOT NULL,     -- 'claude' | 'codex' | 'gemini' | 'cursor'
  model TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_seconds INTEGER,
  summary TEXT,            -- AI-generated post-hoc
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  lines_added INTEGER,
  lines_removed INTEGER,
  tags TEXT,               -- JSON array
  raw_log_path TEXT
);

CREATE TABLE files_changed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  file_path TEXT,
  lines_added INTEGER,
  lines_removed INTEGER
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  agent TEXT,
  description TEXT,
  status TEXT,    -- 'queued' | 'running' | 'done' | 'failed'
  created_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  session_id TEXT  -- linked when agent completes it
);
```

### 7.4 Session Parsing — Claude Code Deep Dive

Claude Code JSONL format per line:

```json
{
  "type": "assistant",
  "message": { "content": [...], "usage": { "input_tokens": 4200, "output_tokens": 812 } },
  "timestamp": "2026-07-07T14:41:22Z",
  "sessionId": "abc123",
  "model": "claude-sonnet-4-6",
  "gitState": { "branch": "main", "commit": "a1b2c3d" }
}
```

Manageai parser extracts:

- `sessionId` → session record ID
- `timestamp` on first/last record → `started_at` / `ended_at`
- Sum of all `usage.input_tokens` + `usage.output_tokens` → token totals
- Tool use blocks with `type: "tool_use"` and `name: "write_file"` → files
  changed
- Cost estimate: tokens × model pricing from local pricing table (updated on
  connection)

**Critical implementation note:** Claude Code's session file format is marked as
internal and may change between versions. Manageai must version-pin parsers and
gracefully degrade when format changes — never crash on unknown fields.

---

## 8. Design System

### 8.1 Philosophy

Local-first developer tool. Clean, calm, information-dense without being
cluttered. The aesthetic serves the data — not the other way around. Every pixel
should feel like it belongs in a professional developer's workflow alongside VS
Code, iTerm, and Linear.

**Anti-patterns to avoid:**

- Dark mode with neon accents (Electron dev tool cliché)
- Excessive gradients or glassmorphism
- Cramped information density (this is a serious tool, not a toy dashboard)
- Images or decorative photography (this tracks code, not interior design)

### 8.2 Color Tokens

```css
/* Surfaces */
--surface-page: #f5f5f2; /* warm off-white page background */
--surface-card: #fefefe; /* card / panel background */
--surface-raised: #fafaf8; /* hover state, secondary panels */
--surface-muted: #f6f6f4; /* stat tiles, code blocks */

/* Text */
--text-primary: #2a2a28; /* headings, primary content */
--text-secondary: #5a5a58; /* body copy, descriptions */
--text-muted: #9a9a92; /* timestamps, labels, hints */
--text-ghost: #b8b8b0; /* placeholder, secondary metadata */

/* Borders */
--border-default: #e8e7e2; /* card outlines, dividers */
--border-strong: #d0cfc9; /* hover states */
--border-selected: #c96a3a; /* active selection */

/* Brand — single accent color */
--accent: #c96a3a; /* primary actions, active nav, CTAs */
--accent-muted: #f0ece8; /* active nav background */
--accent-subtle: #fdf3ee; /* badge backgrounds */

/* Semantic */
--green: #2d7d5a; /* added lines, connected, active */
--green-bg: #eef8f4;
--green-border: #b0deca;

--blue: #4a5fc4; /* in progress, Gemini, informational */
--blue-bg: #eef0fc;
--blue-border: #b8c1ee;

--red: #c04040; /* removed lines, errors */
--red-bg: #fdeeee;

--amber: #a06020; /* paused, warnings */
--amber-bg: #fdf6ee;

--gray: #7a7a72; /* done, neutral */
--gray-bg: #f3f3f1;
--gray-border: #d8d8d2;
```

### 8.3 Typography

```css
/* Display face — used sparingly for project names, monospace identifiers */
--font-mono: 'IBM Plex Mono', 'Fira Code', monospace;

/* Body face — all UI chrome, labels, descriptions */
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

/* Scale */
--text-xs: 10px; /* timestamps, metadata, badges */
--text-sm: 11px; /* secondary labels, monospace paths */
--text-base: 13px; /* body copy, session summaries */
--text-md: 15px; /* section headings */
--text-lg: 17px; /* page title */
--text-xl: 20px; /* stat numbers */
```

### 8.4 Spacing

```
--space-1:  4px
--space-2:  8px
--space-3:  12px
--space-4:  16px
--space-5:  20px
--space-6:  24px
--space-8:  32px
```

### 8.5 Component Library

**Pills / Badges**

- Agent pills: colored bg + border, agent name, 10–11px, 20px border-radius
- Status pills: dot + label, semantic color per status
- Tag pills: category color, 10px, 20px border-radius
- Stack tags: monospace, neutral gray, 4px border-radius

**Cards**

- Project card: white bg, 1.5px border, 10px radius, overflow hidden
- Repo header: path in monospace, language dot, activity bars
- Session row: full-width button, left content + right diff stats, bottom border
  divider
- Stat tile: muted bg, monospace number, 10px label below, 8px radius

**Inputs / Controls**

- Select: 7px padding, 7px radius, muted border, system font
- Text input: same as select, flex-1 in dispatch row
- Primary button: accent bg, white text, no border, 7px radius
- Secondary button: muted border, off-white bg, secondary text

**Modal**

- Max-width 540px, centered, 12px radius, box-shadow
  `0 8px 40px rgba(0,0,0,0.13)`
- Backdrop: `rgba(42,42,40,0.3)` blur
- Header: agent pill + timestamp, × close button
- Body: summary → stat grid → file list → action buttons

### 8.6 Navigation Structure

```
Sidebar (192px fixed)
├── Logo + wordmark
├── Section label: "Workspace"
├── Projects      ⊞
├── Sessions      ◷
├── Timeline      ⋮
├── Connections   ⟳
└── Agent Manager ▶

Footer
└── This month: $XX.XX spend · N sessions · N repos
```

### 8.7 Layout Patterns

**Projects view:** 296px left panel (project cards) + flex-1 right panel
(project detail with tabs)

**Sessions / Timeline / Agent Manager:** Full-width single column, topbar with
title

**Connections:** Full-width card list with 16px gaps

**Modals:** Fixed overlay, centered card, click-outside to close

---

## 9. Development Plan

### Phase 1 — Foundation (Weeks 1–2)

**Goal:** Daemon reads Claude Code logs, writes to SQLite, basic Tauri shell
renders project list.

| Task                         | Owner | Notes                                                          |
| ---------------------------- | ----- | -------------------------------------------------------------- |
| Tauri project scaffold       | Dev   | Rust backend + React/Vite frontend                             |
| SQLite schema + migrations   | Dev   | better-sqlite3, run on startup                                 |
| Claude Code JSONL parser     | Dev   | Handle all known record types, graceful unknown-field handling |
| FS watcher daemon (chokidar) | Dev   | Watch `~/.claude/projects/`, debounce 500ms                    |
| Tauri IPC events             | Dev   | Emit `new-session` event to frontend                           |
| Basic project list UI        | Dev   | Project cards, status pills, agent pills                       |

**Exit criteria:** Import a Claude Code project, see its sessions appear in real
time as you run Claude Code.

### Phase 2 — Full Session Layer (Weeks 3–4)

**Goal:** Complete sessions view, timeline, session detail modal, cost tracking.

| Task                    | Owner | Notes                                                  |
| ----------------------- | ----- | ------------------------------------------------------ |
| Sessions view           | Dev   | Flat list, all projects, click-to-expand               |
| Session detail modal    | Dev   | Stat grid, file list, diff stats, open in editor       |
| Timeline view           | Dev   | Chronological thread, colored agent dots               |
| Cost calculation        | Dev   | Local pricing table, sum per session / project / total |
| AI-generated summaries  | Dev   | Post-hoc call to Claude Haiku 4.5 API per session      |
| Tag auto-classification | Dev   | Keyword heuristics from file paths + prompt text       |
| Activity bars           | Dev   | Decorative git log sparkline per project               |

**Exit criteria:** Full Claude Code session history browsable, summarized, and
costed.

### Phase 3 — Multi-Agent Support (Weeks 5–6)

**Goal:** Codex CLI and Gemini CLI integrated. Connections page live. Universal
git-diff fallback.

| Task                        | Owner | Notes                                                |
| --------------------------- | ----- | ---------------------------------------------------- |
| Codex CLI parser            | Dev   | `~/.codex/` JSONL parsing                            |
| Gemini CLI parser           | Dev   | `~/.gemini/` custom JSON parsing                     |
| Cursor Agent parser         | Dev   | Partial JSONL, best-effort                           |
| Universal git-diff fallback | Dev   | post-commit hook, before/after snapshot              |
| Connections page            | Dev   | Auto-detect installed agents on startup              |
| Log retention override      | Dev   | Patch Claude Code 30-day deletion default on install |
| macOS launchd plist         | Dev   | Daemon starts on login                               |
| Windows service installer   | Dev   | NSSM-based service                                   |
| Linux systemd unit          | Dev   | Standard user service                                |

**Exit criteria:** All major agents tracked. Sessions from Claude Code, Codex,
and Gemini appear in a single unified view.

### Phase 4 — Agent Manager + Polish (Weeks 7–8)

**Goal:** Task dispatch live. Production-quality UI. Ready to ship to beta
users.

| Task                          | Owner | Notes                                                |
| ----------------------------- | ----- | ---------------------------------------------------- |
| Agent Manager UI              | Dev   | Task queue, dispatch form, progress tracking         |
| Task dispatch (Claude Code)   | Dev   | `claude -p "<task>" --output-format json` subprocess |
| Task dispatch (Codex)         | Dev   | `codex "<task>"` subprocess                          |
| Onboarding flow               | Dev   | First-launch: scan for agents, import first project  |
| Installer (macOS .dmg)        | Dev   | Code-signed, notarized                               |
| Installer (Windows .exe)      | Dev   | NSIS installer                                       |
| Error handling + empty states | Dev   | Graceful degradation on parser failures              |
| Settings page                 | Dev   | Log paths, retention, API keys, pricing overrides    |

**Exit criteria:** Shippable beta. Post on HN.

### Phase 5 — Team Features (Weeks 9–14)

| Task                       | Notes                                            |
| -------------------------- | ------------------------------------------------ |
| Team sync (opt-in)         | End-to-end encrypted, self-hostable relay server |
| Slack digest bot           | Daily/weekly summary via Slack webhook           |
| Cost alerts                | Per-project spend threshold notifications        |
| GitHub Actions integration | Post session summary as PR comment               |
| Regression tagging         | Link session to test suite outcome               |
| Natural language search    | Vector index over session summaries              |

---

## 10. Competitor Analysis

| Competitor          | Strength                                  | Weakness                                          | Manageai Advantage                        |
| ------------------- | ----------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| **claude-code-log** | Open source, free, actively maintained    | Terminal-only, Claude-only, no project management | GUI, cross-agent, team features           |
| **LM Assist**       | Rich Claude Code UI, Kanban               | Claude-only, localhost-only, no dispatch          | Cross-agent, team sync, dispatch          |
| **Mantra**          | Git timeline alignment                    | Claude-only, read-only, no cost tracking          | Full feature set                          |
| **Langfuse**        | Production LLM observability, open source | SDK-instrumented, not CLI-native, complex setup   | Zero-config for CLI users                 |
| **AgentOps**        | Real-time agent monitoring                | Production focus, SDK required                    | No integration needed — reads native logs |
| **Braintrust**      | IDE-native MCP integration                | Braintrust-centric, not universal                 | Agent-agnostic                            |
| **Linear**          | Best-in-class developer PM                | Not AI-agent-aware                                | Native AI session layer                   |
| **Datadog**         | Industry standard observability           | Enterprise price, infrastructure focus            | Developer-native, 10-minute setup         |

**Key differentiation:** Manageai requires **zero SDK integration and zero code
changes**. It reads logs that already exist on the developer's machine. Every
competitor requires either (a) limiting to one agent, or (b) SDK
instrumentation. Manageai works out of the box for any developer who already
uses a CLI agent.

---

## 11. Revenue Model

### Tiers

| Tier           | Price       | Limits                                                                      | Target                          |
| -------------- | ----------- | --------------------------------------------------------------------------- | ------------------------------- |
| **Free**       | $0/mo       | 2 projects, 30-day history, Claude Code only                                | Acquisition / viral             |
| **Pro**        | $15/mo      | Unlimited projects, full history, all agents, cost analytics                | Power individual devs           |
| **Team**       | $35/seat/mo | All Pro features + team dashboard, cross-developer visibility, Slack digest | Engineering managers            |
| **Enterprise** | Custom      | SSO, audit logs, self-hosted sync, SLA                                      | CTOs, compliance-sensitive orgs |

### Unit Economics

**TAM calculation:**

```
Claude Code WAU:           4,200,000
Codex CLI users:           2,000,000
Gemini CLI users:          1,000,000
Other agent CLI users:     1,800,000
─────────────────────────────────────
Total CLI agent users:     9,000,000

Multi-agent developers
(run 2+ agents, 3+ repos):     ~20% = 1,800,000 addressable today
```

**Revenue projections (conservative):**

| Scenario      | Paid Users | Mix                | ARPU | MRR   | ARR   |
| ------------- | ---------- | ------------------ | ---- | ----- | ----- |
| Launch (M6)   | 2,000      | 80% Pro / 20% Team | $19  | $38K  | $456K |
| Growth (M12)  | 10,000     | 70% Pro / 30% Team | $21  | $210K | $2.5M |
| Scale (M18)   | 40,000     | 60% Pro / 40% Team | $23  | $920K | $11M  |
| YC Goal (M24) | 100,000    | 50% Pro / 50% Team | $25  | $2.5M | $30M  |

**Team scenario math:**

```
1 engineering team (10 devs) @ $35/seat = $350/month
1,000 teams = $350K MRR = $4.2M ARR
10,000 teams = $3.5M MRR = $42M ARR
```

**Cost structure:**

| Cost Item                    | Monthly (early) | Notes                          |
| ---------------------------- | --------------- | ------------------------------ |
| Claude Haiku API (summaries) | ~$50            | ~$0.001/session × 50K sessions |
| Sync relay server (Hetzner)  | ~$40            | Team sync, self-hostable       |
| Infrastructure               | ~$100           | CDN, update server, telemetry  |
| **Total COGS**               | **~$190/month** | Near-zero at early scale       |

**Gross margin:** ~98% at early scale (local app, minimal infra).  
**CAC:** ~$0 at launch (HN, Product Hunt, developer Twitter).  
**Payback period:** <1 month on Pro, <2 months on Team.

---

## 12. Go-To-Market

### Week 1 — Seed distribution

- Post on Hacker News: _"Show HN: Manageai — session logs and cost tracking for
  Claude Code, Codex, and Gemini CLI in one app"_
- Release free tier, open download link, no signup required
- Target: 500 installs day one

### Month 1 — Developer community

- Developer Twitter / X: demo videos showing the multi-agent timeline view
- Claude Code subreddit, Cursor Discord, Gemini CLI GitHub discussions
- Target: 5,000 installs, 200 Pro conversions

### Month 2–3 — Bottom-up team expansion

- Free tier user mentions Manageai to their manager → manager sees team
  dashboard → converts to Team
- Slack digest feature drives organic sharing ("here's what our agents did this
  week")
- Target: 50 Team accounts

### Month 3–6 — Inbound + content

- Blog: "How we saved $800/month on Claude Code by understanding our agent
  sessions"
- Partnership discussions with Anthropic DevRel (not exclusivity — neutral
  positioning)
- Target: $100K MRR

---

## 13. Risks and Mitigations

| Risk                                            | Probability | Impact | Mitigation                                                                                      |
| ----------------------------------------------- | ----------- | ------ | ----------------------------------------------------------------------------------------------- |
| Anthropic ships this natively                   | Medium      | High   | Build cross-agent layer Anthropic won't build (Codex, Gemini). Neutral positioning is the moat. |
| Claude Code log format changes                  | High        | Medium | Version-pin parsers. Official `/export` command as fallback. Graceful degradation, never crash. |
| Log format is marked "internal and may change"  | High        | Medium | Already documented in Claude Code docs. Use `/export` as stable API where available.            |
| Developers don't pay for devtools               | Medium      | Medium | Team tier at $35/seat is B2B motion. Engineering managers pay. Individual devs are acquisition. |
| Privacy concerns about local log reading        | Low         | High   | All local by default. Open source the daemon. No telemetry without explicit opt-in.             |
| New agent CLI launches with incompatible format | High        | Low    | Plugin-style parser architecture. Community-contributed parsers per agent.                      |

---

## 14. Success Metrics

| Metric                 | Week 4 | Month 3 | Month 6 | Month 12 |
| ---------------------- | ------ | ------- | ------- | -------- |
| Downloads              | 1,000  | 10,000  | 40,000  | 150,000  |
| WAU (active app opens) | 400    | 4,000   | 18,000  | 70,000   |
| Paid users             | 50     | 500     | 2,500   | 12,000   |
| MRR                    | $750   | $9,000  | $47,000 | $240,000 |
| Team accounts          | 0      | 20      | 150     | 800      |
| Sessions logged        | 10K    | 500K    | 5M      | 50M      |
| NPS                    | —      | 50+     | 60+     | 65+      |

---

## 15. YC Application Positioning

**Problem:** 9 million developers are running AI coding agents with zero
visibility into what those agents did, what it cost, or whether it worked.

**Solution:** Manageai — a local-first desktop app that reads native session
logs from every major agent CLI (Claude Code, Codex, Gemini, Cursor) and gives
developers and engineering managers a unified control plane.

**Why now:** Claude Code hit 4.2M WAU and $2.5B run-rate in nine months. 84% of
developers use AI tools daily. The multi-agent workflow is mainstream in
July 2026. The logs already exist on every developer's machine — nobody has
built the layer that reads them.

**Why us:** [Your specific unfair advantage — MSU RIVAL Lab robotics systems
work, Arum full-stack build, EarthLens MCP server — demonstrates you can ship
real developer infrastructure fast.]

**Traction:** [First session logs parsed, first HN post, first paying users —
whatever is true at application time.]

**The ask:** $500K at standard YC terms. 6 months runway to launch, reach $50K
MRR, and prove Team tier conversion.
