Automated (fixture-based): Manageai — Phase 1-2 Build Plan (Claude Code only,
macOS, Tauri + React)

Context

SPEC.md is a YC-application PRD for "Manageai," a local-first desktop control
plane for AI coding agents (Datadog for AI coding agents). It lays out a
5-phase, ~14-week roadmap. The repo is currently empty (greenfield, only SPEC.md
exists). Building the entire spec in one pass isn't realistic, so per user
decision this plan covers:

- SPEC.md Phases 1-2 (Foundation + full session layer) s/Timeline views, cost
  tracking, AI summaries, tagclassification.
- Claude Code as the only agent parsed (Codex/Gemini/Cuge, Agent Manager
  dispatch are explicitly deferred to laterphases).
- macOS only — no installer, no launchd plist, no Windotauri dev is the target
  dev loop. The goal of this phase: prove the daemon → SQLite → UI ainst real,
  live Claude Code sessions on this machine, witha Sessions/Timeline/Projects UI
  that matches SPEC.md's design system (§8).  
  Grounding note: Before finalizing this plan, real files under
  ~/.claude/projects/\*_/_.jsonl on this machine were inspected directly (not
  justSPEC.md's illustrative example). SPEC §7.4's parser exaot literal —
  several concrete field names/shapes differ inproduction logs, which is why the
  schema and parser design below deviate from SPEC's literal wording in a few
  places. Each deviation is calleout with the real data that justifies it.
  Verified against real logs (confirmed by direct inspect
- No nested gitState.branch/gitState.commit. Real records have flat top-level
  gitBranch, cwd, version, sessionId, timestamp, uuid. - Record type values seen
  in practice: last-prompt, modnt, file-history-snapshot, user, assistant,
  system,ai-title, queue-operation. Only user/assistant carry
  message/usage/content; everything else must be silently ignored. - Tool names
  for file writes are Write/Edit/MultiEdit/N as SPEC's illustrative snippet
  shows.
- usage includes cache_creation_input_tokens, cache_read_input_tokens,
  cache_creation.{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens},
  service_tier, iterations[] — cache tokens are often the only
  input_tokens+output_tokens (SPEC's literal schema)would badly understate
  spend.
- Model strings include sentinels like <synthetic> alon. claude-opus-4-8) —
  pricing lookup must tolerate unknownvalues without crashing.
- First line(s) of a session file often carry no timest be derived from min/max
  timestamp across all records thathave one, never line 0.

1. Daemon architecture: no Node sidecar — native Rust

SPEC §7.1/7.2 proposes a Node.js sidecar (chokidar + better-sqlite3) driven over
Tauri IPC. Decision: skip the sidecar. Run the watcher + parser + DB writer
natively inside the Rust/Tauri backebouncer-mini for FS watching and rusqlite
(bundled) forstorage.

Why: this is single-agent, single-user, macOS-only, dev-mode-only. A sidecar
adds an IPC protocol between two processes, sidecar packaging/build steps
(tauri.conf.json bundle.externalBa second dev-loop path — all for zero benefit
at this scope. Native Rust gives one process, one shared rusqlite::Connection, a
single cargo tauri dev hot-reload loop, and idiomatic Option-based defensive
parsing (the compiler forces every field access on log satisfying SPEC's "never
crash on unknown fields"requirement). If a future phase needs the daemon to
outlive the UI (launchd-managed background process), that's still solvable as a
second small Rust binary sharing the same watcher/parser crate— no Node needed
even then.

2. Repo structure

/Users/tanmay/manageai/ ├── SPEC.md ├── package.json, vite.config.ts,
tsconfig.json, index. ├── src/ # React frontend │ ├── main.tsx, App.tsx # view
switcher, no rms) │ ├── styles/tokens.css # SPEC §8.2-8.4
color/typography/spacing as CSS vars │ ├── styles/global.css # reset +
self-hosted Mono) │ ├── components/nav/Sidebar.tsx │ ├── components/ui/ # Pill,
Card, StatTilxtInput, ActivityBars │ ├── views/ #
ProjectsView(+ProjectCard/ProjectDetail),
SessionsView(+SessionRow/SessionDetailModal), │ │ # TimelineView(+Time
AgentManagerStub │ ├── lib/tauri.ts, lib/types.ts │ └──
hooks/useDataChangedEvents.ts └── src-tauri/ ├── Cargo.toml, tauri.conf.json,
build.rs ├── migrations/0001_init.sql └── src/ ├── main.rs, lib.rs ├──
db/{mod.rs, queries.rs} ├── watcher/{mod.rs, tail.rs} # notify-debouncer-mini,
byte-offset incremental tailing ├── parser/{mod.rs, claude_jsonl.rs, session_bu
├── cost/{mod.rs, pricing.rs} ├── resources/pricing.json ├── summarize/{mod.rs,
prompts.rs} # idle-sweep + Haiku API call ├── commands.rs # #[tauri:: └──
events.rs

Scaffold (non-interactive, greenfield directory)

npm create vite@latest . -- --template react-ts npm install npm install -D
@tauri-apps/cli@latest npm install @tauri-apps/api@latest npx tauri init --ci #
then confirm/adjust frontend-dist, dev-url, before-dev/build-command flags #
against the installed CLI's --etween releases)

Rust deps (src-tauri/Cargo.toml): notify, notify-debounbundled),
rusqlite_migration, serde, serde_json, reqwest(features json, rustls-tls), tokio
(rt-multi-thread, time, fs), dirs, similar (line-diff for Edit tool), chrono,
thiserror, anyhow, uuid.

Do not add tauri-plugin-sql — keep all SQL behind #[tauri::command]s so
schema/query logic lives in one place. DB file:
app.path().app_data_dir()/manageai.db (never hardcode $

3. SQLite schema (src-tauri/migrations/0001_init.sql)

Adapts SPEC §7.3's projects/sessions/files_changed (tasd — out of scope this
phase). Deviations from SPEC's literal schema, both required by real data:

- sessions gains cache_read_tokens, cache_creation_tokens (needed for accurate
  cost_usd — see §5), plus status ('active'|'ended') and last_activity_at
  (there's no explicit "session ended" rderived from write-idle time, and the UI
  needs a "live" vs"finished" distinction).
- files_changed gains change_type (write/edit/multi_ediity.
- New internal ingest_state table (no UI surface) tracks per-file byte offsets
  for incremental tailing of live-growing .jsonl files.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects ( id TEXT PRIMARY KEY, -- stable hash
oord.cwd) name TEXT NOT NULL, path TEXT UNIQUE NOT NULL, -- absolute pathded dir
name lang TEXT, stack TEXT, -- JSON array, n created_at INTEGER NOT NULL,
last_active INTEGER NOT NULL );

CREATE TABLE IF NOT EXISTS sessions ( id TEXT PRIMARY KEY, -- Claud project_id
TEXT NOT NULL REFERENCES projects(id), agent TEXT NOT NULL DEFAULT 'claude',
model TEXT, -- last-seen model string, raw started_at INTEGER, -- min(t ended_at
INTEGER, last_activity_at INTEGER NOT NULL, -- maxe detection status TEXT NOT
NULL DEFAULT 'active', -- 'active' | 'ended' duration_seconds INTEGER, summary
TEXT, -- AI-generated post-hoc, nullable prompt_tokens INTEGER NOT NULL DEFAULT
0, completion_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT
NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL
NOT NULL DEFAULT 0, lines_added INTEGER NOT NULL DEFAULT 0, lines_removed
INTEGER NOT NULL DEFAULT 0, tags TEXT, -- JSON array raw_log_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files_changed ( id INTEGER PRIMARY KEY AUTOINCREMENT,
session_id TEXT NOT NULL REFERENCES sessions(id), file_path TEXT NOT NULL,
change_type TEXT NOT NULL, -- 'write' | 'edit' | 'multi_edit' | 'notebook_edit'
lines_added INTEGER NOT NULL DEFAULT 0, lines_removed INTEGER NOT NULL DEFAULT
0, occurred_at INTEGER NOT NULL );

CREATE TABLE IF NOT EXISTS ingest_state ( file_path TEXT PRIMARY KEY,
byte_offset INTEGER NOT NULL DEFAULT 0, partial_line TEXT NOT NULL DEFAULT '',
last_mtime INTEGER, last_ingested_at INTEGER );

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id); CREATE
INDEX IF NOT EXISTS idx_sessions_started ON sess CREATE INDEX IF NOT EXISTS
idx_sessions_status ON sessions(status); CREATE INDEX IF NOT EXISTS
idx_files_changed_session ON

Run via rusqlite_migration (PRAGMA user_version-keyed) er spawns. Enable PRAGMA
journal_mode=WAL.

4. Claude Code JSONL parser

- Discovery: glob ~/.claude/projects/_/_.jsonl once at ng files into
  ingest_state), then watch ~/.claude/projects/itself (new project
  subdirectories appear when a repo is first used with Claude Code — must be
  picked up without restart).
- Never reverse-engineer the dash-encoded directory namn the real path has
  hyphens). Use the record's own cwd field as ground truth for the project path.
- Incremental tailing: on each debounced (500ms, via not, look up ingest_state,
  seek to byte_offset, read to EOF,prepend any buffered partial_line, split on
  \n. The last segment may be incomplete (event fired mid-flush) — buffer it
  back, don't parse it. Update byte_offset/partial_line in the same
  transactionan't skip lines.
- Per-line parsing: parse as untyped serde_json::Value, never a strict struct —
  field sets differ by type and by Claude Code version (e.g. slug appears
  partway through some sessions). Dispatch on typ
  - user/assistant → full extraction.
  - system → cheap gitBranch/cwd refresh only.
  - Known inert types (last-prompt, mode, permission-mode, attachment,
    file-history-snapshot, ai-title, queue-operation) → no-op.
  - Unknown type → log once per unique value (rate-limi
  - Malformed JSON on a line → catch the Result, log file+byte-range, skip,
    still advance byte_offset.
  - No .unwrap()/.expect() anywhere on log-derived data
- Field extraction (per assistant record): message.model → session model;
  message.usage.{input_tokens,output_tokens,cache_read_input_tokens} → summed
  into running totals (missing key =add 0); message.content[] items with
  type=="tool_use" and name in {Write,Edit,MultiEdit,NotebookEdit} →
  files_changed rows:
  - Write: lines_added = content.lines().count(), linestate available from the
    log alone — true diffing is thegit-diff fallback, deferred to Phase 3;
    document this limitation).
  - Edit: use similar::TextDiff::from_lines(old_string,ed/deleted counts.
  - MultiEdit/NotebookEdit: iterate input.edits[], one row per edit.
- Upserts: project_id = hash of lowercase path (idempot= sessionId. ON CONFLICT
  DO UPDATE with monotonicaccumulation (MIN(started_at,...),
  MAX(last_activity_at,...), token sums += delta) — safe to replay. Each
  create/update emits a data-changed event (§8).
- Test fixtures: capture a few anonymized real lines (strip base64 image data)
  into src-tauri/tests/fixtures/\*.jsonl so format drift is caught by tests.

5. Cost calculation

src-tauri/resources/pricing.json — static, bundled, agetch):

{ "schema_version": 1, "rates_per_million_tokens": { "claude-opus-4-8": {
"input": 15.0, "output": 75.0, "cache_write": 18.75, "cache_read": 1.5 },
"claude-sonnet-5": { "input": 3.0, "outp75, "cache_read": 0.3 },
"claude-haiku-4-5-20251001": { "input": 1.0, "output": 5.0, "cache_write": 1.25,
"cache_read": 0.1 }, "\_default": { "input": 3.0, "outp75, "cache_read": 0.3 } }
}

Lookup order: exact match → longest-prefix match (handll check (model string
starts with <, e.g. <synthetic> —treat as non-billable, don't fall through to
\_default) → \_default with a one-time warning log. Never panic on an
unrecognized string.

cost_usd accumulates per assistant record: (input_tokens/1e6)*input_rate +
(output_tokens/1e6)*output_rate +
(cache_creation_input_tokens/1e6)\*cache_write_rate + (ccache_read_rate.
Sidebar/project spend totals areSUM(cost_usd) queries, not a separately
maintained counter.

6. AI summary generation

- Session-end detection: no explicit "end" record exists. A
  tokio::time::interval sweep (~20s) marks status='ended' where now -
  last_activity_at > 120s (constant, not yet user-configuon_seconds.
- Summarization trigger: same/second sweep picks status='ended' AND summary IS
  NULL, dedups via an in-memory in-flight HashSet<String>, spawns one async task
  per session.
- Prompt: first user message's text (truncated ~400 tokens) + last assistant
  message's text-only content blocks (skip thinking/tool_use, truncated ~400
  tokens) + bullet list of distinct file pomputed files_changed). Instruction:
  one sentence, ≤15words, focused on what changed. Never replay the full
  transcript (real sessions can exceed 1000 lines with embedded images).
- API call: reqwest POST to https://api.anthropic.com/vde-haiku-4-5-* key from
  pricing.json (single source oftruth). On success: UPDATE sessions SET
  summary=?, emit data-changed. On failure: log, leave NULL, retried next sweep
  — never blocks the rest of the pipeline.
- API key resolution (real gotcha: a .app launched from Finder doesn't inherit
  shell env, unlike npm run tauri dev from a terminal): check ANTHROPIC_API_KEY
  env var first, then app_data_dir()/coey": "..."}, read once at startup, never
  logged). NoSettings UI to set this yet (Phase 4) — document the
  env-var/config.json path for now, but write the resolution code to check both
  so Phase 4 just adds a writer. If neither present: summarization s still
  works.

7. Frontend

- No react-router — 5 fixed sidebar items (Projects/Sesgent Manager per SPEC
  §8.6), a single useState<View> switchin App.tsx is sufficient; no deep-linking
  requirement in scope.
- Data fetching: TanStack React Query (@tanstack/react-ls (list_projects,
  list_sessions, get_session_detail). Pairs directly with event-driven
  invalidation (§8).
- Design tokens: src/styles/tokens.css transcribes SPECstom properties.
  Self-host Inter + IBM Plex Mono (bundledfont files, not a CDN) — consistent
  with "local-first, no data leaves the machine."
- Component library (src/components/ui/) maps 1:1 to SPtag/stack variants),
  Card, StatTile, Modal, Button(primary/secondary), Select, TextInput,
  ActivityBars. Build once, reuse everywhere — highest-leverage early work.
- Layout per SPEC §8.7: Projects = 296px left panel + f; Sessions/Timeline =
  full-width single column with topbar;Connections/Agent Manager = same shell,
  centered "Coming soon" card, nav items visibly present but disabled (not
  removed) so the full IA reads correctly from day one.

8. Real-time update flow

Rust emits a coarse event on every upsert rather than p

app_handle.emit("data-changed", DataChangedPayload { encreated" })?;

Frontend: one useDataChangedEvents hook (mounted once ii-apps/api/event and
callsqueryClient.invalidateQueries(...) on the relevant key — React Query
refetches from the corresponding command and re-renders. Decouples "something
changed" from the data shape, so schema iteronizing an event payload type across
Rust and TS.

9. Ordered task breakdown

Phase 1 — Foundation

1. Scaffold Vite+React+TS; verify npm run dev serves a blank page.
2. npx tauri init against it; verify npm run tauri dev
3. Add Rust deps.
4. Write migrations/0001_init.sql; wire rusqlite_migratata_dir()/manageai.db;
   PRAGMA journal_mode=WAL.
5. Implement parser/ — dispatch, upsert logic, files_changed extraction.
6. Implement watcher/tail.rs (byte-offset tailing + ings (debounced watch, glob
   discovery, backfill,new-subdirectory watch).
7. Wire watcher → parser → DB → emit("data-changed", ..
8. #[tauri::command] list_projects() (rows + aggregated session counts/spend).
9. Basic Projects UI: Sidebar, ProjectCard, Pill, wiredstener.
10. Phase 1 exit check (§10 below).

Phase 2 — Full session layer 11. cost/pricing.rs + resources/pricing.json;
backfill dits. 12. #[tauri::command] list_sessions() /
get_session_detail(session_id). 13. Sessions view: SessionRow list,
SessionDetailModal stats, "open in editor" via $EDITOR/code). 14. Timeline view:
chronological feed over the same data, colored agent dot (single color for now,
per-agent mapping kept for Phase 3), client-side filters (project/tag/date). 15.
Idle-session sweep marking status='ended', computing duration_seconds. 16. Tag
auto-classification: keyword heuristics over fit user prompt text, stored as
sessions.tags JSON at finalize time. 17. AI summary pipeline: prompt
construction, Haiku calk + event emit. 18. Activity bars: git log --since=...
--format=%ct sparkline per project (shell out, cache, decorative). 19. Design
system pass: tokens.css, self-hosted fonts, retrofit all views onto it. 20.
Connections/Agent Manager nav stubs (disabled + "coming soon"). 21. Phase 2 exit
check (§10 below).

Dependency notes: 3→4→5→6→7 is a strict chain. 8→9 can list_projects. 11 should
land before 12/13 (session detailwants cost_usd populated) but isn't a hard
blocker — UI can show $0.00 until then. 15→16→17 have a natural order (must know
a session ended before tagging/summarizing) but 16 and 17 are independe

10. Verification

Automated (fixture-based):

- Parser unit tests against anonymized real fixture lines: correct token sums,
  correct files_changed extraction for Write/Edit, zero rows and zero panics on
  unknown type values.
- Malformed-line test: truncated mid-JSON line is skipped, rest of file still
  processes, byte_offset still advances past it.
- Pricing test: <synthetic>, an unknown model string, asolve without panicking,
  hitting thesentinel/\_default/exact-match branches respectively.

End-to-end, live-session (required before declaring Phase 1/2 exit criteria
met):

1. npm run tauri dev in this repo.
2. In a second terminal, in some other scratch git repo (avoid Manageai watching
   its own dev session), run claude interactively and give it a

3. Confirm the project card appears within ~1s of the debounce firing, without
   restarting the app.
4. Confirm token counts, files_changed, and cost_usd up continues.
5. End/idle the session; confirm status → ended, duration_seconds populates, and
   (if ANTHROPIC_API_KEY set) a summary appears within one sweep (~20s), no
   manual refresh needed.
6. Graceful-degradation check: append a deliberately malformed line to a
   finished session file, re-touch its mtime, confirm no crash and prior data
   stays intact.
7. Restart Manageai mid-session; confirm the backfill resumes from
   ingest_state.byte_offset rather than re-processing (and double-counting cost
   for) the whole file.
8. Hand-verify cost_usd for one completed session: sum
   input_tokens/output_tokens/cache fields directly from the raw .jsonl with a
   one-off script, compare to what the UI shows.

Critical files

- src-tauri/src/parser/claude_jsonl.rs — parser correcthing else depends on.
- src-tauri/migrations/0001_init.sql — schema deviations from SPEC documented
  above.
- src-tauri/src/watcher/tail.rs — incremental tailing cated lines).
- src-tauri/resources/pricing.json — cost accuracy depends on this staying in
  sync with real model names.
