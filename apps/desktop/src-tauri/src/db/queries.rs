use crate::parser::record::UsageKind;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub lang: Option<String>,
    pub stack: Option<String>,
    pub created_at: i64,
    pub last_active: i64,
    pub session_count: i64,
    pub total_cost_usd: f64,
    /// Every distinct agent (`claude`/`codex`/`gemini`/`cursor`) that has at least one session
    /// in this project — order is whatever SQLite's `GROUP_CONCAT(DISTINCT ...)` returns, not
    /// meaningful. Lets the UI show one badge per agent instead of assuming every project is
    /// Claude-only.
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub agent: String,
    pub model: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub last_activity_at: i64,
    pub status: String,
    pub duration_seconds: Option<i64>,
    pub summary: Option<String>,
    /// Claude Code's own auto-generated session title (from the raw log's "ai-title"
    /// record) — nullable until Claude has generated one, and always `None` for sessions
    /// ingested before this column existed. See `update_session_title`.
    pub title: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cost_usd: f64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub tags: Option<String>,
    pub raw_log_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileChanged {
    pub id: i64,
    pub session_id: String,
    pub file_path: String,
    pub change_type: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub occurred_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct TokenDelta {
    /// Decides how `upsert_session` folds these numbers into the session's stored counters
    /// — see `UsageKind`.
    pub kind: UsageKind,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
}

#[derive(Debug, Clone)]
pub struct IngestState {
    pub byte_offset: i64,
    pub partial_line: String,
}

/// Per-agent rollup for the Dashboard's "by agent" breakdown. Only agents actually present
/// in `sessions` show up here — the frontend merges this against a fixed known-agent list
/// (claude/codex/gemini/cursor) so every known agent gets a tile even before it has any
/// sessions ingested.
#[derive(Debug, Clone, Serialize)]
pub struct AgentUsage {
    pub agent: String,
    pub session_count: i64,
    pub total_cost_usd: f64,
}

/// For recomputing cost_usd against the current pricing table without re-parsing logs.
pub struct SessionTokenTotals {
    pub id: String,
    pub model: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
}

fn row_to_session(row: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        project_id: row.get(1)?,
        agent: row.get(2)?,
        model: row.get(3)?,
        started_at: row.get(4)?,
        ended_at: row.get(5)?,
        last_activity_at: row.get(6)?,
        status: row.get(7)?,
        duration_seconds: row.get(8)?,
        summary: row.get(9)?,
        prompt_tokens: row.get(10)?,
        completion_tokens: row.get(11)?,
        cache_read_tokens: row.get(12)?,
        cache_creation_tokens: row.get(13)?,
        cost_usd: row.get(14)?,
        lines_added: row.get(15)?,
        lines_removed: row.get(16)?,
        tags: row.get(17)?,
        raw_log_path: row.get(18)?,
        title: row.get(19)?,
    })
}

const SESSION_COLUMNS: &str = "id, project_id, agent, model, started_at, ended_at, last_activity_at, status,
     duration_seconds, summary, prompt_tokens, completion_tokens, cache_read_tokens,
     cache_creation_tokens, cost_usd, lines_added, lines_removed, tags, raw_log_path, title";

// --- Ingest (parser/watcher) side ---

pub fn upsert_project(
    conn: &Connection,
    id: &str,
    name: &str,
    path: &str,
    timestamp: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO projects (id, name, path, created_at, last_active)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET
            last_active = MAX(last_active, excluded.last_active)",
        params![id, name, path, timestamp],
    )?;
    Ok(())
}

/// Upserts a session with monotonic accumulation of token deltas — safe to
/// replay if a log file is ever re-scanned from offset 0. Returns true if a
/// new session row was created (vs. an existing one updated).
pub fn upsert_session(
    conn: &Connection,
    session_id: &str,
    project_id: &str,
    agent: &str,
    model: Option<&str>,
    timestamp: i64,
    raw_log_path: &str,
    delta: &TokenDelta,
) -> rusqlite::Result<bool> {
    let existed: bool = conn
        .query_row(
            "SELECT 1 FROM sessions WHERE id = ?1",
            params![session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();

    // A delta source contributes this record's own tokens, so the counters accumulate. A
    // cumulative source re-reports the session total in full on every record, so the counters
    // take the larger value instead — which also makes the write idempotent, so re-tailing a
    // file from offset 0 (after a restart, or the repair in migration 0008) converges on the
    // right totals rather than multiplying them by the record count.
    let fold = match delta.kind {
        UsageKind::Delta => {
            "prompt_tokens = prompt_tokens + excluded.prompt_tokens,
             completion_tokens = completion_tokens + excluded.completion_tokens,
             cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
             cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens"
        }
        UsageKind::Cumulative => {
            "prompt_tokens = MAX(prompt_tokens, excluded.prompt_tokens),
             completion_tokens = MAX(completion_tokens, excluded.completion_tokens),
             cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens),
             cache_creation_tokens = MAX(cache_creation_tokens, excluded.cache_creation_tokens)"
        }
    };

    conn.execute(
        &format!(
            "INSERT INTO sessions (
            id, project_id, agent, model, started_at, last_activity_at, status,
            prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens,
            raw_log_path
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'active', ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            model = COALESCE(excluded.model, model),
            started_at = MIN(started_at, excluded.started_at),
            last_activity_at = MAX(last_activity_at, excluded.last_activity_at),
            status = 'active',
            {fold}"
        ),
        params![
            session_id,
            project_id,
            agent,
            model,
            timestamp,
            delta.prompt_tokens,
            delta.completion_tokens,
            delta.cache_read_tokens,
            delta.cache_creation_tokens,
            raw_log_path,
        ],
    )?;

    Ok(!existed)
}

pub fn insert_file_changed(
    conn: &Connection,
    session_id: &str,
    file_path: &str,
    change_type: &str,
    lines_added: i64,
    lines_removed: i64,
    occurred_at: i64,
    old_content: Option<&str>,
    new_content: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO files_changed (session_id, file_path, change_type, lines_added, lines_removed, occurred_at, old_content, new_content)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            session_id,
            file_path,
            change_type,
            lines_added,
            lines_removed,
            occurred_at,
            old_content,
            new_content,
        ],
    )?;
    conn.execute(
        "UPDATE sessions SET lines_added = lines_added + ?2, lines_removed = lines_removed + ?3 WHERE id = ?1",
        params![session_id, lines_added, lines_removed],
    )?;
    Ok(())
}

pub fn get_ingest_state(conn: &Connection, file_path: &str) -> rusqlite::Result<IngestState> {
    let result = conn
        .query_row(
            "SELECT byte_offset, partial_line FROM ingest_state WHERE file_path = ?1",
            params![file_path],
            |row| {
                Ok(IngestState {
                    byte_offset: row.get(0)?,
                    partial_line: row.get(1)?,
                })
            },
        )
        .optional()?;
    Ok(result.unwrap_or(IngestState {
        byte_offset: 0,
        partial_line: String::new(),
    }))
}

pub fn set_ingest_state(
    conn: &Connection,
    file_path: &str,
    byte_offset: i64,
    partial_line: &str,
    mtime: i64,
) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO ingest_state (file_path, byte_offset, partial_line, last_mtime, last_ingested_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(file_path) DO UPDATE SET
            byte_offset = excluded.byte_offset,
            partial_line = excluded.partial_line,
            last_mtime = excluded.last_mtime,
            last_ingested_at = excluded.last_ingested_at",
        params![file_path, byte_offset, partial_line, mtime, now],
    )?;
    Ok(())
}

/// Clears the stored before/after text on file changes older than `before_epoch`, keeping the
/// rows themselves so path/line-count history and every aggregate over it stay intact. Those
/// two blobs are the bulk of the database — they exist to render an on-demand diff for a
/// recent change, which is not worth unbounded growth for edits nobody will open again.
/// Returns how many rows were cleared.
pub fn prune_file_diff_content(conn: &Connection, before_epoch: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE files_changed
         SET old_content = NULL, new_content = NULL
         WHERE occurred_at < ?1 AND (old_content IS NOT NULL OR new_content IS NOT NULL)",
        params![before_epoch],
    )
}

// --- Read side (frontend commands) ---

/// Lists projects for display. A project row can exist for a directory the watcher noticed but that
/// never actually ran a session (e.g. a bare `.claude` dir with no activity yet); the inner
/// `JOIN sessions` excludes those — a directory with 0 sessions and $0 spent isn't something
/// the user should see listed.
pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<ProjectSummary>> {
    let sql = "SELECT p.id, p.name, p.path, p.lang, p.stack, p.created_at, p.last_active,
                COUNT(s.id) as session_count,
                COALESCE(SUM(s.cost_usd), 0.0) as total_cost_usd,
                GROUP_CONCAT(DISTINCT s.agent) as agents
         FROM projects p
         JOIN sessions s ON s.project_id = p.id
         GROUP BY p.id
         HAVING COUNT(s.id) > 0
         ORDER BY p.last_active DESC";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| {
        let agents: Option<String> = row.get(9)?;
        Ok(ProjectSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            lang: row.get(3)?,
            stack: row.get(4)?,
            created_at: row.get(5)?,
            last_active: row.get(6)?,
            session_count: row.get(7)?,
            total_cost_usd: row.get(8)?,
            agents: agents
                .map(|s| s.split(',').map(String::from).collect())
                .unwrap_or_default(),
        })
    })?;
    rows.collect()
}

/// Lists every session for display, most-recently-active first.
pub fn list_sessions(conn: &Connection) -> rusqlite::Result<Vec<Session>> {
    let sql = format!("SELECT {SESSION_COLUMNS} FROM sessions ORDER BY last_activity_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_session)?;
    rows.collect()
}

pub fn get_session_detail(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<(Session, Vec<FileChanged>)>> {
    let sql = format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1");
    let session = conn
        .query_row(&sql, params![session_id], row_to_session)
        .optional()?;

    let Some(session) = session else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT id, session_id, file_path, change_type, lines_added, lines_removed, occurred_at
         FROM files_changed WHERE session_id = ?1 ORDER BY occurred_at ASC",
    )?;
    let files = stmt
        .query_map(params![session_id], |row| {
            Ok(FileChanged {
                id: row.get(0)?,
                session_id: row.get(1)?,
                file_path: row.get(2)?,
                change_type: row.get(3)?,
                lines_added: row.get(4)?,
                lines_removed: row.get(5)?,
                occurred_at: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some((session, files)))
}

/// Just the session row, no `files_changed` join — for callers (e.g. transcript export) that
/// only need session metadata and would otherwise pay for an unused query.
pub fn get_session(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<Session>> {
    let sql = format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1");
    conn.query_row(&sql, params![session_id], row_to_session)
        .optional()
}

/// Before/after text spanning every `files_changed` row for one file within one session,
/// folded into a single before→after pair: `old_content` from the earliest edit,
/// `new_content` from the most recent. Backs the "view diff" command's per-file (not
/// per-edit) view — a file touched by several tool calls in one session shows one cumulative
/// diff of everything that session did to it, rather than one diff per tool call.
pub struct FileDiffSpan {
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    /// When the most recent edit in this span occurred — shown in the diff view so a
    /// multi-edit file's diff is still attributable to a point in time.
    pub latest_occurred_at: i64,
    pub edit_count: i64,
}

pub fn file_diff_span(
    conn: &Connection,
    session_id: &str,
    file_path: &str,
) -> rusqlite::Result<Option<FileDiffSpan>> {
    let mut stmt = conn.prepare(
        "SELECT old_content, new_content, occurred_at FROM files_changed
         WHERE session_id = ?1 AND file_path = ?2 ORDER BY occurred_at ASC",
    )?;
    let rows: Vec<(Option<String>, Option<String>, i64)> = stmt
        .query_map(params![session_id, file_path], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let last = rows.last().expect("non-empty per the check above");

    Ok(Some(FileDiffSpan {
        old_content: first.0.clone(),
        new_content: last.1.clone(),
        latest_occurred_at: last.2,
        edit_count: rows.len() as i64,
    }))
}

// --- Idle-session sweep / summarization / tagging (Phase 2) ---

pub fn sessions_to_finalize(
    conn: &Connection,
    idle_threshold_secs: i64,
    now: i64,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM sessions WHERE status = 'active' AND (?1 - last_activity_at) > ?2",
    )?;
    let ids = stmt
        .query_map(params![now, idle_threshold_secs], |row| row.get(0))?
        .collect();
    ids
}

pub fn finalize_session(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions
         SET status = 'ended',
             ended_at = last_activity_at,
             duration_seconds = last_activity_at - COALESCE(started_at, last_activity_at)
         WHERE id = ?1",
        params![session_id],
    )?;
    Ok(())
}

pub fn sessions_needing_summary(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM sessions WHERE status = 'ended' AND summary IS NULL")?;
    let ids = stmt.query_map([], |row| row.get(0))?.collect();
    ids
}

pub fn update_summary(conn: &Connection, session_id: &str, summary: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET summary = ?2 WHERE id = ?1",
        params![session_id, summary],
    )?;
    Ok(())
}

/// Sets `title` from a session's "ai-title" record.
pub fn update_session_title(
    conn: &Connection,
    session_id: &str,
    title: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET title = ?2 WHERE id = ?1",
        params![session_id, title],
    )?;
    Ok(())
}

pub fn sessions_needing_tags(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM sessions WHERE status = 'ended' AND tags IS NULL")?;
    let ids = stmt.query_map([], |row| row.get(0))?.collect();
    ids
}

pub fn update_tags(conn: &Connection, session_id: &str, tags_json: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET tags = ?2 WHERE id = ?1",
        params![session_id, tags_json],
    )?;
    Ok(())
}

/// Looks up just `raw_log_path` for a single session — used by the tag-classification sweep,
/// which needs this one field per id and shouldn't pull a full `list_sessions()` scan to get
/// it.
pub fn session_raw_log_path(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT raw_log_path FROM sessions WHERE id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .optional()
}

// --- Cost recompute (pricing-table edits applied without re-parsing logs) ---

pub fn update_cost(conn: &Connection, session_id: &str, cost_usd: f64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET cost_usd = ?2 WHERE id = ?1",
        params![session_id, cost_usd],
    )?;
    Ok(())
}

/// Single-session variant of `all_session_token_totals`, used right after `upsert_session` to
/// read back the now-updated accumulated totals for cost recomputation (see
/// `session_builder::ingest_record`) without re-parsing logs.
pub fn session_token_totals(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<SessionTokenTotals>> {
    conn.query_row(
        "SELECT id, model, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens
         FROM sessions WHERE id = ?1",
        params![session_id],
        |row| {
            Ok(SessionTokenTotals {
                id: row.get(0)?,
                model: row.get(1)?,
                prompt_tokens: row.get(2)?,
                completion_tokens: row.get(3)?,
                cache_read_tokens: row.get(4)?,
                cache_creation_tokens: row.get(5)?,
            })
        },
    )
    .optional()
}

pub fn all_session_token_totals(conn: &Connection) -> rusqlite::Result<Vec<SessionTokenTotals>> {
    let mut stmt = conn.prepare(
        "SELECT id, model, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens
         FROM sessions",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SessionTokenTotals {
            id: row.get(0)?,
            model: row.get(1)?,
            prompt_tokens: row.get(2)?,
            completion_tokens: row.get(3)?,
            cache_read_tokens: row.get(4)?,
            cache_creation_tokens: row.get(5)?,
        })
    })?;
    rows.collect()
}

// --- Dashboard (spend + activity summary) ---

/// Cost and session-count totals grouped by `agent`. Populated from whichever agents'
/// watchers have actually ingested sessions — Claude Code, Codex, Gemini, and Cursor all write
/// their own `agent` value via `upsert_session` (see `parser/{claude_jsonl,codex_jsonl,
/// gemini_log,cursor_jsonl}.rs`).
pub fn agent_usage(conn: &Connection) -> rusqlite::Result<Vec<AgentUsage>> {
    let mut stmt = conn.prepare(
        "SELECT agent, COUNT(*) as session_count, COALESCE(SUM(cost_usd), 0.0) as total_cost_usd
         FROM sessions
         GROUP BY agent
         ORDER BY total_cost_usd DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AgentUsage {
            agent: row.get(0)?,
            session_count: row.get(1)?,
            total_cost_usd: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// Per-model rollup for the Dashboard's "spend by model" breakdown. `model` is `None` for
/// sessions ingested before any model string was seen (e.g. metadata-only sessions), which the
/// frontend renders as "Unknown". A session records a single `model` (the last one seen on it),
/// so this attributes the session's whole cost to that model — the same granularity every other
/// per-session number here uses, not a per-message split.
#[derive(Debug, Clone, Serialize)]
pub struct ModelUsage {
    pub model: Option<String>,
    pub session_count: i64,
    pub total_cost_usd: f64,
}

/// Cost and session-count totals grouped by `model`, highest spend first. Names the raw model
/// id (`claude-opus-5`, etc.); the frontend maps it to a display label ("Opus 5") via
/// `models.ts` so the mapping lives in one place on the TS side.
pub fn model_usage(conn: &Connection) -> rusqlite::Result<Vec<ModelUsage>> {
    let mut stmt = conn.prepare(
        "SELECT model, COUNT(*) as session_count, COALESCE(SUM(cost_usd), 0.0) as total_cost_usd
         FROM sessions
         GROUP BY model
         ORDER BY total_cost_usd DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ModelUsage {
            model: row.get(0)?,
            session_count: row.get(1)?,
            total_cost_usd: row.get(2)?,
        })
    })?;
    rows.collect()
}

// --- Spend report (Reports view) ---
//
// All three queries below window on `last_activity_at` rather than `started_at`: every
// session row has a non-null `last_activity_at` (see `Session`'s field docs), while
// `started_at` is nullable, so windowing on it would silently drop sessions that never got a
// `started_at` recorded. "Report window" therefore means "sessions with activity in this
// window," not "sessions started in this window."

/// Headline totals for the report window: overall spend, session count, and raw token
/// totals across every ingested agent. `avg_cost_per_session` is left for the caller to
/// derive (`total_cost_usd / session_count`) rather than computed here, since the caller
/// already has to guard the zero-session case for display anyway.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ReportTotals {
    pub total_cost_usd: f64,
    pub session_count: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
}

pub fn report_totals(conn: &Connection, since_epoch: i64) -> rusqlite::Result<ReportTotals> {
    conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0.0), COUNT(*),
                COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0)
         FROM sessions
         WHERE last_activity_at >= ?1",
        params![since_epoch],
        |row| {
            Ok(ReportTotals {
                total_cost_usd: row.get(0)?,
                session_count: row.get(1)?,
                prompt_tokens: row.get(2)?,
                completion_tokens: row.get(3)?,
                cache_read_tokens: row.get(4)?,
                cache_creation_tokens: row.get(5)?,
            })
        },
    )
}

/// One row per project with any activity in the window, highest spend first — the report's
/// "where did the money go" breakdown. Unlike `list_projects`, this only returns projects
/// with at least one session inside the window (inner join), since a project untouched in
/// the reporting period isn't part of the report.
#[derive(Debug, Clone, Serialize)]
pub struct ReportProjectRow {
    pub project_id: String,
    pub project_name: String,
    pub session_count: i64,
    pub total_cost_usd: f64,
}

pub fn report_by_project(
    conn: &Connection,
    since_epoch: i64,
) -> rusqlite::Result<Vec<ReportProjectRow>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, COUNT(s.id), COALESCE(SUM(s.cost_usd), 0.0)
         FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE s.last_activity_at >= ?1
         GROUP BY p.id
         ORDER BY 4 DESC",
    )?;
    let rows = stmt.query_map(params![since_epoch], |row| {
        Ok(ReportProjectRow {
            project_id: row.get(0)?,
            project_name: row.get(1)?,
            session_count: row.get(2)?,
            total_cost_usd: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// Same shape as `agent_usage` but windowed to the report period — kept as a separate query
/// rather than adding a `since` parameter to `agent_usage` itself, since the Dashboard's
/// all-time call site has no window to pass.
pub fn agent_usage_since(conn: &Connection, since_epoch: i64) -> rusqlite::Result<Vec<AgentUsage>> {
    let mut stmt = conn.prepare(
        "SELECT agent, COUNT(*) as session_count, COALESCE(SUM(cost_usd), 0.0) as total_cost_usd
         FROM sessions
         WHERE last_activity_at >= ?1
         GROUP BY agent
         ORDER BY total_cost_usd DESC",
    )?;
    let rows = stmt.query_map(params![since_epoch], |row| {
        Ok(AgentUsage {
            agent: row.get(0)?,
            session_count: row.get(1)?,
            total_cost_usd: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// Spend broken down by tag, highest spend first. `tags` is stored as a JSON array string
/// (see `tags::classify`); a session tagged with more than one tag contributes its full cost
/// to each of its tags, so per-tag totals across the whole table can sum to more than
/// `report_totals`'s grand total — that's expected for a multi-label breakdown, not a bug.
/// Unpacked in Rust rather than via SQLite's `json_each` so a malformed `tags` cell (there
/// shouldn't be one, but nothing enforces it at the schema level) is skipped instead of
/// failing the whole query.
#[derive(Debug, Clone, Serialize)]
pub struct ReportTagRow {
    pub tag: String,
    pub session_count: i64,
    pub total_cost_usd: f64,
}

pub fn report_by_tag(conn: &Connection, since_epoch: i64) -> rusqlite::Result<Vec<ReportTagRow>> {
    let mut stmt = conn.prepare(
        "SELECT tags, cost_usd FROM sessions WHERE last_activity_at >= ?1 AND tags IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![since_epoch], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    })?;

    let mut by_tag: HashMap<String, (i64, f64)> = HashMap::new();
    for row in rows {
        let (tags_json, cost_usd) = row?;
        let Ok(tags) = serde_json::from_str::<Vec<String>>(&tags_json) else {
            continue;
        };
        for tag in tags {
            let entry = by_tag.entry(tag).or_insert((0, 0.0));
            entry.0 += 1;
            entry.1 += cost_usd;
        }
    }

    let mut out: Vec<ReportTagRow> = by_tag
        .into_iter()
        .map(|(tag, (session_count, total_cost_usd))| ReportTagRow {
            tag,
            session_count,
            total_cost_usd,
        })
        .collect();
    out.sort_by(|a, b| {
        b.total_cost_usd
            .partial_cmp(&a.total_cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// The Dashboard's "active now" widget: which project + session (if any) is currently
/// `status = 'active'`, most-recently-active first when several sessions are active at
/// once (e.g. Claude Code running in more than one repo simultaneously).
#[derive(Debug, Clone, Serialize)]
pub struct ActiveSessionSummary {
    pub session_id: String,
    /// Falls back to `summary`, then to a fixed placeholder, on the frontend — this stays
    /// the raw nullable column so the frontend's fallback chain is in one place.
    pub session_title: Option<String>,
    pub session_summary: Option<String>,
    pub project_id: String,
    pub project_name: String,
}

pub fn most_recent_active_session(
    conn: &Connection,
) -> rusqlite::Result<Option<ActiveSessionSummary>> {
    conn.query_row(
        "SELECT s.id, s.title, s.summary, s.project_id, p.name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.status = 'active'
         ORDER BY s.last_activity_at DESC
         LIMIT 1",
        [],
        |row| {
            Ok(ActiveSessionSummary {
                session_id: row.get(0)?,
                session_title: row.get(1)?,
                session_summary: row.get(2)?,
                project_id: row.get(3)?,
                project_name: row.get(4)?,
            })
        },
    )
    .optional()
}

/// Daily activity counts since `since_epoch` (unix seconds), keyed by `YYYY-MM-DD` (local
/// SQLite `date()` output, which is UTC since these timestamps are UTC). A day's count is
/// "sessions started that day" plus "file edits made that day" — two different event kinds
/// summed together, since either is evidence of a day worked on, matching what a GitHub
/// commit-style heatmap is meant to convey. Returned as a sparse map (only days with any
/// activity) — the caller fills in zero-activity days when building a fixed-length window,
/// since walking 365 dense days here would mean serializing hundreds of zero rows out of SQL
/// for no reason.
pub fn daily_activity_counts(
    conn: &Connection,
    since_epoch: i64,
) -> rusqlite::Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare(
        "SELECT d, SUM(c) FROM (
            SELECT date(started_at, 'unixepoch') AS d, COUNT(*) AS c
            FROM sessions
            WHERE started_at IS NOT NULL AND started_at >= ?1
            GROUP BY d
            UNION ALL
            SELECT date(occurred_at, 'unixepoch') AS d, COUNT(*) AS c
            FROM files_changed
            WHERE occurred_at >= ?1
            GROUP BY d
         )
         GROUP BY d",
    )?;
    let rows = stmt.query_map(params![since_epoch], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    rows.collect()
}

#[cfg(test)]
mod token_fold_tests {
    use super::*;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0004_session_title.sql")).unwrap();
        conn
    }

    fn ingest(conn: &Connection, agent: &str, kind: UsageKind, prompt: i64, completion: i64) {
        upsert_project(conn, "p1", "fixture", "/fixture", 1000).unwrap();
        upsert_session(
            conn,
            "s1",
            "p1",
            agent,
            Some("m"),
            1000,
            "/log.jsonl",
            &TokenDelta {
                kind,
                prompt_tokens: prompt,
                completion_tokens: completion,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
        )
        .unwrap();
    }

    fn totals(conn: &Connection) -> (i64, i64) {
        conn.query_row(
            "SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = 's1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn delta_records_accumulate() {
        let conn = in_memory_db();
        ingest(&conn, "claude", UsageKind::Delta, 100, 10);
        ingest(&conn, "claude", UsageKind::Delta, 50, 5);
        assert_eq!(totals(&conn), (150, 15));
    }

    /// The bug this fold exists to prevent: three `token_count` events reporting a session
    /// total of 100 → 300 → 600 must leave the session at 600, not their 1000-token sum.
    #[test]
    fn cumulative_records_keep_the_running_total_rather_than_summing_it() {
        let conn = in_memory_db();
        ingest(&conn, "codex", UsageKind::Cumulative, 100, 10);
        ingest(&conn, "codex", UsageKind::Cumulative, 300, 30);
        ingest(&conn, "codex", UsageKind::Cumulative, 600, 60);
        assert_eq!(totals(&conn), (600, 60));
    }

    /// What makes migration 0008's repair work: re-tailing a log from offset 0 replays every
    /// record, and the totals must land where they already were.
    #[test]
    fn replaying_cumulative_records_is_idempotent() {
        let conn = in_memory_db();
        for _ in 0..2 {
            ingest(&conn, "codex", UsageKind::Cumulative, 100, 10);
            ingest(&conn, "codex", UsageKind::Cumulative, 600, 60);
        }
        assert_eq!(totals(&conn), (600, 60));
    }

    /// Codex re-reports the same total on an idle turn; that must not walk the counter back
    /// either, which is why the fold is MAX rather than a plain assignment.
    #[test]
    fn a_lower_cumulative_report_never_lowers_the_stored_total() {
        let conn = in_memory_db();
        ingest(&conn, "codex", UsageKind::Cumulative, 600, 60);
        ingest(&conn, "codex", UsageKind::Cumulative, 100, 10);
        assert_eq!(totals(&conn), (600, 60));
    }
}

#[cfg(test)]
mod prune_tests {
    use super::*;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0004_session_title.sql")).unwrap();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, agent, started_at, last_activity_at, status, raw_log_path)
             VALUES ('s1', 'p1', 'claude', 1000, 1000, 'active', '')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn clears_content_before_the_cutoff_and_keeps_the_row() {
        let conn = in_memory_db();
        insert_file_changed(&conn, "s1", "old.rs", "edit", 1, 1, 100, Some("was"), Some("now"))
            .unwrap();

        assert_eq!(prune_file_diff_content(&conn, 200).unwrap(), 1);

        let (path, added, old, new): (String, i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT file_path, lines_added, old_content, new_content FROM files_changed",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((path.as_str(), added), ("old.rs", 1));
        assert_eq!((old, new), (None, None));
    }

    #[test]
    fn leaves_content_at_or_after_the_cutoff_alone() {
        let conn = in_memory_db();
        insert_file_changed(&conn, "s1", "new.rs", "edit", 1, 1, 300, Some("was"), Some("now"))
            .unwrap();

        assert_eq!(prune_file_diff_content(&conn, 200).unwrap(), 0);

        let new: Option<String> = conn
            .query_row("SELECT new_content FROM files_changed", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new.as_deref(), Some("now"));
    }

    #[test]
    fn a_second_prune_reports_nothing_left_to_clear() {
        let conn = in_memory_db();
        insert_file_changed(&conn, "s1", "old.rs", "edit", 1, 1, 100, Some("was"), Some("now"))
            .unwrap();

        prune_file_diff_content(&conn, 200).unwrap();
        assert_eq!(prune_file_diff_content(&conn, 200).unwrap(), 0);
    }
}

#[cfg(test)]
mod file_diff_span_tests {
    use super::*;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0004_session_title.sql")).unwrap();
        conn
    }

    fn seed_session(conn: &Connection, session_id: &str) {
        upsert_project(conn, "p1", "fixture", "/fixture", 1000).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, agent, started_at, last_activity_at, status, raw_log_path)
             VALUES (?1, 'p1', 'claude', 1000, 1000, 'active', '')",
            params![session_id],
        )
        .unwrap();
    }

    #[test]
    fn folds_multiple_edits_to_the_same_file_into_one_before_after_span() {
        let conn = in_memory_db();
        seed_session(&conn, "s1");

        insert_file_changed(&conn, "s1", "src/main.rs", "write", 3, 0, 100, None, Some("fn main() {}")).unwrap();
        insert_file_changed(&conn, "s1", "src/main.rs", "edit", 1, 0, 200, Some("fn main() {}"), Some("fn main() { a(); }")).unwrap();
        insert_file_changed(&conn, "s1", "src/main.rs", "edit", 1, 0, 300, Some("fn main() { a(); }"), Some("fn main() { a(); b(); }")).unwrap();

        let span = file_diff_span(&conn, "s1", "src/main.rs").unwrap().unwrap();

        assert_eq!(span.old_content.as_deref(), None, "before-text is from the earliest edit (a Write, so None)");
        assert_eq!(span.new_content.as_deref(), Some("fn main() { a(); b(); }"), "after-text is from the most recent edit");
        assert_eq!(span.latest_occurred_at, 300);
        assert_eq!(span.edit_count, 3);
    }

    #[test]
    fn returns_none_when_the_session_never_touched_that_file() {
        let conn = in_memory_db();
        seed_session(&conn, "s1");
        insert_file_changed(&conn, "s1", "src/main.rs", "write", 1, 0, 100, None, Some("x")).unwrap();

        assert!(file_diff_span(&conn, "s1", "src/other.rs").unwrap().is_none());
    }

    #[test]
    fn does_not_mix_edits_from_a_different_session_to_the_same_path() {
        let conn = in_memory_db();
        seed_session(&conn, "s1");
        seed_session(&conn, "s2");
        insert_file_changed(&conn, "s1", "src/main.rs", "write", 1, 0, 100, None, Some("from s1")).unwrap();
        insert_file_changed(&conn, "s2", "src/main.rs", "write", 1, 0, 200, None, Some("from s2")).unwrap();

        let span = file_diff_span(&conn, "s1", "src/main.rs").unwrap().unwrap();
        assert_eq!(span.new_content.as_deref(), Some("from s1"));
        assert_eq!(span.edit_count, 1);
    }
}

#[cfg(test)]
mod report_tests {
    use super::*;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0004_session_title.sql")).unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_session(
        conn: &Connection,
        session_id: &str,
        project_id: &str,
        agent: &str,
        last_activity_at: i64,
        cost_usd: f64,
        tags: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO sessions (id, project_id, agent, started_at, last_activity_at, status, cost_usd, tags, raw_log_path)
             VALUES (?1, ?2, ?3, ?4, ?4, 'ended', ?5, ?6, '')",
            params![session_id, project_id, agent, last_activity_at, cost_usd, tags],
        )
        .unwrap();
    }

    #[test]
    fn report_totals_sums_only_sessions_inside_the_window() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        seed_session(&conn, "s1", "p1", "claude", 2000, 1.50, None);
        seed_session(&conn, "s2", "p1", "claude", 500, 9.00, None); // before the window

        let totals = report_totals(&conn, 1000).unwrap();
        assert_eq!(totals.session_count, 1);
        assert_eq!(totals.total_cost_usd, 1.50);
    }

    #[test]
    fn report_by_project_orders_highest_spend_first_and_excludes_untouched_projects() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "quiet", "/quiet", 1000).unwrap();
        upsert_project(&conn, "p2", "busy", "/busy", 1000).unwrap();
        seed_session(&conn, "s1", "p2", "claude", 2000, 5.0, None);
        seed_session(&conn, "s2", "p2", "claude", 2100, 5.0, None);
        // p1 has no sessions at all inside (or outside) the window.

        let rows = report_by_project(&conn, 1000).unwrap();
        assert_eq!(rows.len(), 1, "a project with zero sessions in the window must not appear");
        assert_eq!(rows[0].project_name, "busy");
        assert_eq!(rows[0].session_count, 2);
        assert_eq!(rows[0].total_cost_usd, 10.0);
    }

    #[test]
    fn report_by_tag_credits_full_cost_to_every_tag_on_a_multi_tagged_session() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        seed_session(&conn, "s1", "p1", "claude", 2000, 4.0, Some(r#"["feature","bugfix"]"#));
        seed_session(&conn, "s2", "p1", "claude", 2000, 2.0, Some(r#"["feature"]"#));
        seed_session(&conn, "s3", "p1", "claude", 2000, 100.0, None); // untagged, must be skipped

        let rows = report_by_tag(&conn, 1000).unwrap();
        let feature = rows.iter().find(|r| r.tag == "feature").unwrap();
        let bugfix = rows.iter().find(|r| r.tag == "bugfix").unwrap();
        assert_eq!(feature.session_count, 2);
        assert_eq!(feature.total_cost_usd, 6.0);
        assert_eq!(bugfix.session_count, 1);
        assert_eq!(bugfix.total_cost_usd, 4.0);
    }

    #[test]
    fn report_by_tag_skips_malformed_json_instead_of_failing_the_whole_query() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        seed_session(&conn, "s1", "p1", "claude", 2000, 3.0, Some("not valid json"));
        seed_session(&conn, "s2", "p1", "claude", 2000, 1.0, Some(r#"["docs"]"#));

        let rows = report_by_tag(&conn, 1000).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tag, "docs");
    }

    #[test]
    fn agent_usage_since_only_counts_sessions_inside_the_window() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        seed_session(&conn, "s1", "p1", "claude", 2000, 3.0, None);
        seed_session(&conn, "s2", "p1", "codex", 500, 7.0, None); // before the window

        let rows = agent_usage_since(&conn, 1000).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent, "claude");
        assert_eq!(rows[0].total_cost_usd, 3.0);
    }

    #[test]
    fn model_usage_groups_by_model_orders_by_spend_and_keeps_null_model() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        // Two opus-5 sessions and one fable-5, plus one metadata-only session with no model.
        let insert = |id: &str, model: Option<&str>, cost: f64| {
            conn.execute(
                "INSERT INTO sessions (id, project_id, agent, model, started_at, last_activity_at, status, cost_usd, raw_log_path)
                 VALUES (?1, 'p1', 'claude', ?2, 2000, 2000, 'ended', ?3, '')",
                params![id, model, cost],
            )
            .unwrap();
        };
        insert("s1", Some("claude-opus-5"), 4.0);
        insert("s2", Some("claude-opus-5"), 2.0);
        insert("s3", Some("claude-fable-5"), 10.0);
        insert("s4", None, 1.0);

        let rows = model_usage(&conn).unwrap();
        assert_eq!(rows.len(), 3, "opus-5 rows collapse into one; null model is its own group");

        // Highest spend first: fable-5 (10) > opus-5 (6) > null (1).
        assert_eq!(rows[0].model.as_deref(), Some("claude-fable-5"));
        assert_eq!(rows[0].session_count, 1);
        assert_eq!(rows[0].total_cost_usd, 10.0);

        assert_eq!(rows[1].model.as_deref(), Some("claude-opus-5"));
        assert_eq!(rows[1].session_count, 2);
        assert_eq!(rows[1].total_cost_usd, 6.0);

        assert_eq!(rows[2].model, None);
        assert_eq!(rows[2].session_count, 1);
    }
}

#[cfg(test)]
mod list_query_tests {
    use super::*;
    use std::collections::HashSet;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0004_session_title.sql")).unwrap();
        conn
    }

    /// Insert a project plus one session per id in `session_ids`.
    fn seed(conn: &Connection, project_id: &str, created_at: i64, session_ids: &[&str]) {
        upsert_project(conn, project_id, project_id, &format!("/{project_id}"), created_at).unwrap();
        for sid in session_ids {
            conn.execute(
                "INSERT INTO sessions (id, project_id, agent, started_at, last_activity_at, status, cost_usd, raw_log_path)
                 VALUES (?1, ?2, 'claude', ?3, ?3, 'active', 1.0, '')",
                params![sid, project_id, created_at],
            )
            .unwrap();
        }
    }

    /// Five projects, oldest → newest = p1 → p5, two sessions each (s1..s10 in ingest order).
    fn seed_five_projects(conn: &Connection) {
        seed(conn, "p1", 1000, &["s1", "s2"]);
        seed(conn, "p2", 2000, &["s3", "s4"]);
        seed(conn, "p3", 3000, &["s5", "s6"]);
        seed(conn, "p4", 4000, &["s7", "s8"]);
        seed(conn, "p5", 5000, &["s9", "s10"]);
    }

    fn ids<T, F: Fn(&T) -> String>(items: &[T], f: F) -> HashSet<String> {
        items.iter().map(f).collect()
    }

    fn set(strs: &[&str]) -> HashSet<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn lists_every_project_and_session() {
        let conn = in_memory_db();
        seed_five_projects(&conn);

        let projects = list_projects(&conn).unwrap();
        assert_eq!(
            ids(&projects, |p| p.id.clone()),
            set(&["p1", "p2", "p3", "p4", "p5"]),
        );

        let sessions = list_sessions(&conn).unwrap();
        assert_eq!(
            ids(&sessions, |s| s.id.clone()),
            set(&["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]),
        );

        // Each project's card sums its own sessions/cost.
        let p1 = projects.iter().find(|p| p.id == "p1").unwrap();
        assert_eq!(p1.session_count, 2);
        assert_eq!(p1.total_cost_usd, 2.0);
    }

    #[test]
    fn a_project_with_no_sessions_is_not_listed() {
        let conn = in_memory_db();
        // A directory the watcher noticed but that never ran a session.
        upsert_project(&conn, "empty", "empty", "/empty", 1000).unwrap();
        seed(&conn, "active", 2000, &["s1"]);

        let projects = list_projects(&conn).unwrap();
        assert_eq!(ids(&projects, |p| p.id.clone()), set(&["active"]));
    }
}
