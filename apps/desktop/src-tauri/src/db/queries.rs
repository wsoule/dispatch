use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::collections::HashMap;
use uuid::Uuid;

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

    conn.execute(
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
            prompt_tokens = prompt_tokens + excluded.prompt_tokens,
            completion_tokens = completion_tokens + excluded.completion_tokens,
            cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
            cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens",
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

// --- Read side (frontend commands) ---

/// Lists projects for display. A project row can exist for a directory Relay noticed but that
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

/// Sets `title` from a session's "ai-title" record. Also renames that session's linked
/// board card away from its "New session" placeholder (see `auto_create_card_for_session`)
/// if it's still sitting on that placeholder — this arrives well before the idle-sweep's
/// tag/summary passes would otherwise be the first thing to give the card a real name, and
/// a no-op `UPDATE ... WHERE title = 'New session'` is harmless if the user already renamed
/// it themselves.
pub fn update_session_title(
    conn: &Connection,
    session_id: &str,
    title: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET title = ?2 WHERE id = ?1",
        params![session_id, title],
    )?;
    conn.execute(
        "UPDATE cards SET title = ?2, updated_at = ?3 WHERE session_id = ?1 AND title = 'New session'",
        params![session_id, title, chrono::Utc::now().timestamp()],
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

/// Project-scoped variant of `most_recent_active_session`, returning just the session id —
/// used by `commands::launch_or_attach_session` to decide whether to resume an existing
/// session for a project or start a fresh one.
pub fn most_recent_active_session_id_for_project(
    conn: &Connection,
    project_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM sessions WHERE project_id = ?1 AND status = 'active'
         ORDER BY last_activity_at DESC LIMIT 1",
        params![project_id],
        |row| row.get(0),
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

// --- Kanban board ---

#[derive(Debug, Clone, Serialize)]
pub struct Board {
    pub id: String,
    pub project_id: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Column {
    pub id: String,
    pub board_id: String,
    pub name: String,
    pub role: Option<String>,
    pub position: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Card {
    pub id: String,
    pub board_id: String,
    pub column_id: String,
    pub session_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The four columns every new board is seeded with, in display order. Roles are fixed at
/// creation time and never reassigned in v1 — auto-sync (`sync_card_for_session`) depends on
/// exactly one column per board carrying each role.
const SEEDED_COLUMNS: [(&str, &str); 4] = [
    ("Todo", "todo"),
    ("In Progress", "in_progress"),
    ("Review", "review"),
    ("Done", "done"),
];

/// Returns the board id for `project_id`, creating the board and its four role-tagged
/// columns if this is the first time this project has been seen. Idempotent and safe to call
/// on every project touch — relies on the caller already holding the single shared DB lock
/// (see `db::Db`), so the existence check and insert below can't race with another writer.
pub fn ensure_board_for_project(conn: &Connection, project_id: &str) -> rusqlite::Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM boards WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(board_id) = existing {
        return Ok(board_id);
    }

    let board_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO boards (id, project_id, created_at) VALUES (?1, ?2, ?3)",
        params![board_id, project_id, now],
    )?;

    for (position, (name, role)) in SEEDED_COLUMNS.iter().enumerate() {
        conn.execute(
            "INSERT INTO columns (id, board_id, name, role, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![Uuid::new_v4().to_string(), board_id, name, role, position as i64, now],
        )?;
    }

    Ok(board_id)
}

/// Full board state for the board view: the board row, its columns in display order, and
/// every card on it. Calls `ensure_board_for_project` first so a project with sessions but no
/// prior board access still renders a real (empty) board rather than the frontend having to
/// handle a "no board yet" state.
pub fn get_board(
    conn: &Connection,
    project_id: &str,
) -> rusqlite::Result<(Board, Vec<Column>, Vec<Card>)> {
    let board_id = ensure_board_for_project(conn, project_id)?;

    let board = conn.query_row(
        "SELECT id, project_id, created_at FROM boards WHERE id = ?1",
        params![board_id],
        |row| {
            Ok(Board {
                id: row.get(0)?,
                project_id: row.get(1)?,
                created_at: row.get(2)?,
            })
        },
    )?;

    let mut col_stmt = conn.prepare(
        "SELECT id, board_id, name, role, position, created_at FROM columns
         WHERE board_id = ?1 ORDER BY position ASC",
    )?;
    let columns = col_stmt
        .query_map(params![board_id], |row| {
            Ok(Column {
                id: row.get(0)?,
                board_id: row.get(1)?,
                name: row.get(2)?,
                role: row.get(3)?,
                position: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut card_stmt = conn.prepare(
        "SELECT id, board_id, column_id, session_id, title, description, position, created_at, updated_at
         FROM cards WHERE board_id = ?1 ORDER BY position ASC",
    )?;
    let cards = card_stmt
        .query_map(params![board_id], |row| {
            Ok(Card {
                id: row.get(0)?,
                board_id: row.get(1)?,
                column_id: row.get(2)?,
                session_id: row.get(3)?,
                title: row.get(4)?,
                description: row.get(5)?,
                position: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok((board, columns, cards))
}

fn next_position_in_column(conn: &Connection, column_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM cards WHERE column_id = ?1",
        params![column_id],
        |row| row.get(0),
    )
}

/// Manual card creation — used both for the "+ Add card" affordance on unlinked columns and,
/// with `session_id = None`, for pre-session planning cards a user later attaches to a real
/// session via `link_session_to_card`.
pub fn create_card(
    conn: &Connection,
    board_id: &str,
    column_id: &str,
    title: &str,
    description: Option<&str>,
) -> rusqlite::Result<Card> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let position = next_position_in_column(conn, column_id)?;

    conn.execute(
        "INSERT INTO cards (id, board_id, column_id, session_id, title, description, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?7)",
        params![id, board_id, column_id, title, description, position, now],
    )?;

    Ok(Card {
        id,
        board_id: board_id.to_string(),
        column_id: column_id.to_string(),
        session_id: None,
        title: title.to_string(),
        description: description.map(str::to_string),
        position,
        created_at: now,
        updated_at: now,
    })
}

/// How long a card stays eligible to adopt a freshly-spawned session after
/// `commands::launch_or_attach_session` stamps it (see `adopt_pending_card_for_session`).
/// Long enough to cover a cold `claude` boot writing its first log line, short enough that an
/// unrelated session started minutes later in the same project won't get misattributed.
const PENDING_LAUNCH_WINDOW_SECS: i64 = 120;

/// Marks `card_id` as awaiting the session a just-launched terminal will create. The card's
/// session id can't be known at launch time (Claude Code generates it), so the ingest path
/// reconciles later via `adopt_pending_card_for_session`. Idempotent — re-stamping just
/// refreshes the window.
pub fn set_card_pending_launch(conn: &Connection, card_id: &str) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE cards SET pending_launch_at = ?2 WHERE id = ?1",
        params![card_id, now],
    )?;
    Ok(())
}

/// Reconciles a brand-new session against a card that spawned it. If `project_id` has an
/// unlinked card stamped with a recent `pending_launch_at` (within `PENDING_LAUNCH_WINDOW_SECS`,
/// most-recent stamp wins), links `session_id` into that card, clears the stamp, and syncs it
/// to the `in_progress` column — then returns `true` so the caller skips auto-creating a
/// duplicate. Returns `false` (leaving the normal `auto_create_card_for_session` path to run)
/// when no eligible card exists. The card keeps its user-authored title; only the linkage
/// changes. See `commands::launch_or_attach_session` for the launch-side stamp.
pub fn adopt_pending_card_for_session(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
) -> rusqlite::Result<bool> {
    let cutoff = chrono::Utc::now().timestamp() - PENDING_LAUNCH_WINDOW_SECS;
    let card_id: Option<String> = conn
        .query_row(
            "SELECT c.id
             FROM cards c
             JOIN boards b ON b.id = c.board_id
             WHERE b.project_id = ?1
               AND c.session_id IS NULL
               AND c.pending_launch_at IS NOT NULL
               AND c.pending_launch_at >= ?2
             ORDER BY c.pending_launch_at DESC
             LIMIT 1",
            params![project_id, cutoff],
            |row| row.get(0),
        )
        .optional()?;
    let Some(card_id) = card_id else {
        return Ok(false);
    };

    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE cards SET session_id = ?2, pending_launch_at = NULL, updated_at = ?3 WHERE id = ?1",
        params![card_id, session_id, now],
    )?;
    sync_card_for_session(conn, session_id, "in_progress")?;
    Ok(true)
}

/// A card whose `session_id` matches an ingested session, created the moment that session
/// starts (see `session_builder::ingest_record`). No-ops if a card is already linked to this
/// session (replay-safe, same spirit as `upsert_session`'s idempotent accumulation) or if the
/// board's `in_progress` column can't be found (shouldn't happen in v1 — role columns aren't
/// deletable — but degrading silently beats panicking the ingest path over a UI-layer row).
pub fn auto_create_card_for_session(
    conn: &Connection,
    board_id: &str,
    session_id: &str,
    title: &str,
) -> rusqlite::Result<()> {
    let already_linked: bool = conn
        .query_row(
            "SELECT 1 FROM cards WHERE session_id = ?1",
            params![session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if already_linked {
        return Ok(());
    }

    let column_id: Option<String> = conn
        .query_row(
            "SELECT id FROM columns WHERE board_id = ?1 AND role = 'in_progress'",
            params![board_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(column_id) = column_id else {
        return Ok(());
    };

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let position = next_position_in_column(conn, &column_id)?;

    conn.execute(
        "INSERT INTO cards (id, board_id, column_id, session_id, title, description, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?7)",
        params![id, board_id, column_id, session_id, title, position, now],
    )?;

    Ok(())
}

/// Moves whichever card is linked to `session_id` to its board's column with the given
/// `role`, appending it to the end of that column. Called on every session status
/// transition (start → 'in_progress', idle-sweep finalize → 'review') — always wins over
/// wherever the user last dragged the card, per the design's "auto-sync always wins on
/// transition" rule. No-ops if no card is linked to this session, or if the target role
/// column doesn't exist on the card's board.
pub fn sync_card_for_session(conn: &Connection, session_id: &str, role: &str) -> rusqlite::Result<()> {
    let linked: Option<(String, String)> = conn
        .query_row(
            "SELECT id, board_id FROM cards WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((card_id, board_id)) = linked else {
        return Ok(());
    };

    let column_id: Option<String> = conn
        .query_row(
            "SELECT id FROM columns WHERE board_id = ?1 AND role = ?2",
            params![board_id, role],
            |row| row.get(0),
        )
        .optional()?;
    let Some(column_id) = column_id else {
        return Ok(());
    };

    let now = chrono::Utc::now().timestamp();
    let position = next_position_in_column(conn, &column_id)?;
    conn.execute(
        "UPDATE cards SET column_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
        params![card_id, column_id, position, now],
    )?;

    Ok(())
}

pub fn move_card(conn: &Connection, card_id: &str, column_id: &str, position: i64) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE cards SET column_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
        params![card_id, column_id, position, now],
    )?;
    Ok(())
}

/// Everything `commands::launch_or_attach_session` needs about one card in a single query:
/// its own title/description/session_id, its column's role (to check it landed on the
/// seeded "in_progress" column), and its project's id + filesystem path (to know where to
/// launch/attach a terminal session).
#[derive(Debug, Clone)]
pub struct CardLaunchContext {
    pub title: String,
    pub description: Option<String>,
    pub session_id: Option<String>,
    pub column_role: Option<String>,
    pub project_id: String,
    pub project_path: String,
}

pub fn card_launch_context(
    conn: &Connection,
    card_id: &str,
) -> rusqlite::Result<Option<CardLaunchContext>> {
    conn.query_row(
        "SELECT c.title, c.description, c.session_id, col.role, p.id, p.path
         FROM cards c
         JOIN columns col ON col.id = c.column_id
         JOIN boards b ON b.id = c.board_id
         JOIN projects p ON p.id = b.project_id
         WHERE c.id = ?1",
        params![card_id],
        |row| {
            Ok(CardLaunchContext {
                title: row.get(0)?,
                description: row.get(1)?,
                session_id: row.get(2)?,
                column_role: row.get(3)?,
                project_id: row.get(4)?,
                project_path: row.get(5)?,
            })
        },
    )
    .optional()
}

pub fn update_card(
    conn: &Connection,
    card_id: &str,
    title: &str,
    description: Option<&str>,
) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE cards SET title = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
        params![card_id, title, description, now],
    )?;
    Ok(())
}

pub fn delete_card(conn: &Connection, card_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM cards WHERE id = ?1", params![card_id])?;
    Ok(())
}

/// Attaches an existing session to a manually-created planning card — the escape hatch from
/// the design's "user can link a pre-existing Todo card instead of getting a duplicate
/// auto-created one" rule. If `session_id` already backs a different (auto-created) card,
/// that duplicate is deleted first, since `cards.session_id` is UNIQUE. Immediately syncs the
/// card to whichever column matches the session's *current* status, so linking a card to an
/// already-active or already-ended session doesn't leave it stranded wherever it was created.
pub fn link_session_to_card(conn: &Connection, card_id: &str, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM cards WHERE session_id = ?1 AND id != ?2",
        params![session_id, card_id],
    )?;

    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE cards SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![card_id, session_id, now],
    )?;

    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;
    let role = match status.as_deref() {
        Some("ended") => "review",
        _ => "in_progress",
    };
    sync_card_for_session(conn, session_id, role)
}

pub fn create_column(conn: &Connection, board_id: &str, name: &str) -> rusqlite::Result<Column> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM columns WHERE board_id = ?1",
        params![board_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO columns (id, board_id, name, role, position, created_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
        params![id, board_id, name, position, now],
    )?;

    Ok(Column {
        id,
        board_id: board_id.to_string(),
        name: name.to_string(),
        role: None,
        position,
        created_at: now,
    })
}

pub fn rename_column(conn: &Connection, column_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE columns SET name = ?2 WHERE id = ?1",
        params![column_id, name],
    )?;
    Ok(())
}

#[cfg(test)]
mod file_diff_span_tests {
    use super::*;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0003_kanban.sql")).unwrap();
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
        conn.execute_batch(include_str!("../../migrations/0003_kanban.sql")).unwrap();
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
}

#[cfg(test)]
mod kanban_tests {
    use super::*;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0003_kanban.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0004_session_title.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0005_plan.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0006_card_pending_launch.sql")).unwrap();
        conn
    }

    fn seed_session_only(conn: &Connection, project_id: &str, session_id: &str) {
        conn.execute(
            "INSERT INTO sessions (id, project_id, agent, started_at, last_activity_at, status, raw_log_path)
             VALUES (?1, ?2, 'claude', 1000, 1000, 'active', '')",
            params![session_id, project_id],
        )
        .unwrap();
    }

    fn seed_project_and_session(conn: &Connection, project_id: &str, session_id: &str) {
        upsert_project(conn, project_id, "fixture", "/fixture", 1000).unwrap();
        seed_session_only(conn, project_id, session_id);
    }

    fn column_role_for_card(conn: &Connection, card_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT col.role FROM cards c JOIN columns col ON col.id = c.column_id WHERE c.id = ?1",
            params![card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn ensure_board_for_project_is_idempotent_and_seeds_four_role_columns() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();

        let board_id_1 = ensure_board_for_project(&conn, "p1").unwrap();
        let board_id_2 = ensure_board_for_project(&conn, "p1").unwrap();
        assert_eq!(board_id_1, board_id_2, "second call must not create a second board");

        let column_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM columns WHERE board_id = ?1", params![board_id_1], |r| r.get(0))
            .unwrap();
        assert_eq!(column_count, 4);

        let roles: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT role FROM columns WHERE board_id = ?1 ORDER BY position ASC")
                .unwrap();
            stmt.query_map(params![board_id_1], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert_eq!(roles, vec!["todo", "in_progress", "review", "done"]);
    }

    #[test]
    fn sync_card_for_session_moves_linked_card_to_the_target_role_column() {
        let conn = in_memory_db();
        seed_project_and_session(&conn, "p1", "s1");
        let board_id = ensure_board_for_project(&conn, "p1").unwrap();
        auto_create_card_for_session(&conn, &board_id, "s1", "New session").unwrap();

        let card_id: String = conn.query_row("SELECT id FROM cards", [], |r| r.get(0)).unwrap();
        assert_eq!(column_role_for_card(&conn, &card_id).as_deref(), Some("in_progress"));

        sync_card_for_session(&conn, "s1", "review").unwrap();
        assert_eq!(column_role_for_card(&conn, &card_id).as_deref(), Some("review"));
    }

    #[test]
    fn sync_card_for_session_is_a_noop_when_no_card_is_linked() {
        let conn = in_memory_db();
        seed_project_and_session(&conn, "p1", "s1");
        ensure_board_for_project(&conn, "p1").unwrap();

        // No card was ever created for "s1" — must not error.
        sync_card_for_session(&conn, "s1", "review").unwrap();

        let card_count: i64 = conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0)).unwrap();
        assert_eq!(card_count, 0);
    }

    #[test]
    fn link_session_to_card_replaces_any_prior_auto_created_card_for_that_session() {
        let conn = in_memory_db();
        seed_project_and_session(&conn, "p1", "s1");
        let board_id = ensure_board_for_project(&conn, "p1").unwrap();

        // Simulates the session starting first (auto-creates a card)...
        auto_create_card_for_session(&conn, &board_id, "s1", "New session").unwrap();
        let auto_card_id: String = conn.query_row("SELECT id FROM cards", [], |r| r.get(0)).unwrap();

        // ...then the user retroactively linking it to a manual planning card instead.
        let todo_column_id: String = conn
            .query_row("SELECT id FROM columns WHERE board_id = ?1 AND role = 'todo'", params![board_id], |r| r.get(0))
            .unwrap();
        let manual_card = create_card(&conn, &board_id, &todo_column_id, "Plan the thing", None).unwrap();

        link_session_to_card(&conn, &manual_card.id, "s1").unwrap();

        let card_count: i64 = conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0)).unwrap();
        assert_eq!(card_count, 1, "the duplicate auto-created card must be gone");

        let remaining_id: String = conn.query_row("SELECT id FROM cards", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining_id, manual_card.id);
        assert_ne!(remaining_id, auto_card_id);

        // Session "s1" is still 'active', so linking must place the card in 'in_progress'.
        assert_eq!(column_role_for_card(&conn, &manual_card.id).as_deref(), Some("in_progress"));
    }

    #[test]
    fn link_session_to_card_places_card_in_review_for_an_already_ended_session() {
        let conn = in_memory_db();
        seed_project_and_session(&conn, "p1", "s1");
        conn.execute("UPDATE sessions SET status = 'ended' WHERE id = 's1'", []).unwrap();
        let board_id = ensure_board_for_project(&conn, "p1").unwrap();

        let todo_column_id: String = conn
            .query_row("SELECT id FROM columns WHERE board_id = ?1 AND role = 'todo'", params![board_id], |r| r.get(0))
            .unwrap();
        let manual_card = create_card(&conn, &board_id, &todo_column_id, "Plan the thing", None).unwrap();

        link_session_to_card(&conn, &manual_card.id, "s1").unwrap();

        assert_eq!(column_role_for_card(&conn, &manual_card.id).as_deref(), Some("review"));
    }

    #[test]
    fn adopt_pending_card_for_session_links_stamped_card_and_skips_auto_create() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        let board_id = ensure_board_for_project(&conn, "p1").unwrap();
        let in_progress_id: String = conn
            .query_row("SELECT id FROM columns WHERE board_id = ?1 AND role = 'in_progress'", params![board_id], |r| r.get(0))
            .unwrap();

        // A user-authored planning card that was just used to spawn a terminal session.
        let card = create_card(&conn, &board_id, &in_progress_id, "Fix the linkedin section", None).unwrap();
        set_card_pending_launch(&conn, &card.id).unwrap();

        // The session Claude Code creates then gets ingested.
        seed_session_only(&conn, "p1", "s1");
        let adopted = adopt_pending_card_for_session(&conn, "p1", "s1").unwrap();
        assert!(adopted, "the stamped card should have adopted the new session");

        // Exactly one card, still the user's card and title, now linked and with the stamp cleared.
        let card_count: i64 = conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0)).unwrap();
        assert_eq!(card_count, 1, "no duplicate card should have been created");
        let (title, session_id, pending): (String, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT title, session_id, pending_launch_at FROM cards WHERE id = ?1",
                params![card.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "Fix the linkedin section");
        assert_eq!(session_id.as_deref(), Some("s1"));
        assert_eq!(pending, None);
    }

    #[test]
    fn adopt_pending_card_for_session_ignores_expired_stamp() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        let board_id = ensure_board_for_project(&conn, "p1").unwrap();
        let in_progress_id: String = conn
            .query_row("SELECT id FROM columns WHERE board_id = ?1 AND role = 'in_progress'", params![board_id], |r| r.get(0))
            .unwrap();
        let card = create_card(&conn, &board_id, &in_progress_id, "Stale plan", None).unwrap();
        // Stamp far outside the adoption window.
        let stale = chrono::Utc::now().timestamp() - PENDING_LAUNCH_WINDOW_SECS - 60;
        conn.execute("UPDATE cards SET pending_launch_at = ?2 WHERE id = ?1", params![card.id, stale]).unwrap();

        seed_session_only(&conn, "p1", "s1");
        let adopted = adopt_pending_card_for_session(&conn, "p1", "s1").unwrap();
        assert!(!adopted, "an expired stamp must fall through to the auto-create path");
        // Card is untouched (still unlinked) so the caller will auto-create as normal.
        let session_id: Option<String> = conn
            .query_row("SELECT session_id FROM cards WHERE id = ?1", params![card.id], |r| r.get(0))
            .unwrap();
        assert_eq!(session_id, None);
    }

    #[test]
    fn card_launch_context_reports_project_path_and_column_role_for_an_unlinked_card() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/Users/testuser/fixture", 1000).unwrap();
        let board_id = ensure_board_for_project(&conn, "p1").unwrap();
        let in_progress_column_id: String = conn
            .query_row(
                "SELECT id FROM columns WHERE board_id = ?1 AND role = 'in_progress'",
                params![board_id],
                |r| r.get(0),
            )
            .unwrap();
        let card = create_card(
            &conn,
            &board_id,
            &in_progress_column_id,
            "Fix the login bug",
            Some("Repros on SSO cookie expiry"),
        )
        .unwrap();

        let context = card_launch_context(&conn, &card.id).unwrap().unwrap();
        assert_eq!(context.title, "Fix the login bug");
        assert_eq!(context.description.as_deref(), Some("Repros on SSO cookie expiry"));
        assert_eq!(context.session_id, None);
        assert_eq!(context.column_role.as_deref(), Some("in_progress"));
        assert_eq!(context.project_id, "p1");
        assert_eq!(context.project_path, "/Users/testuser/fixture");
    }

    #[test]
    fn card_launch_context_returns_none_for_an_unknown_card_id() {
        let conn = in_memory_db();
        assert!(card_launch_context(&conn, "does-not-exist").unwrap().is_none());
    }

    #[test]
    fn most_recent_active_session_id_for_project_picks_the_active_one_and_ignores_other_projects() {
        let conn = in_memory_db();
        seed_project_and_session(&conn, "p1", "s1");
        // An ended session for the same project must not be picked...
        conn.execute(
            "INSERT INTO sessions (id, project_id, agent, started_at, last_activity_at, status, raw_log_path)
             VALUES ('s0', 'p1', 'claude', 900, 900, 'ended', '')",
            [],
        )
        .unwrap();
        // ...nor an active session belonging to a different project.
        upsert_project(&conn, "p2", "fixture2", "/fixture2", 1000).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, agent, started_at, last_activity_at, status, raw_log_path)
             VALUES ('s2', 'p2', 'claude', 1000, 1000, 'active', '')",
            [],
        )
        .unwrap();

        let result = most_recent_active_session_id_for_project(&conn, "p1").unwrap();
        assert_eq!(result.as_deref(), Some("s1"));
    }

    #[test]
    fn most_recent_active_session_id_for_project_returns_none_when_nothing_is_active() {
        let conn = in_memory_db();
        upsert_project(&conn, "p1", "fixture", "/fixture", 1000).unwrap();
        assert_eq!(most_recent_active_session_id_for_project(&conn, "p1").unwrap(), None);
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
        conn.execute_batch(include_str!("../../migrations/0003_kanban.sql")).unwrap();
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
        // A directory Relay noticed but that never ran a session.
        upsert_project(&conn, "empty", "empty", "/empty", 1000).unwrap();
        seed(&conn, "active", 2000, &["s1"]);

        let projects = list_projects(&conn).unwrap();
        assert_eq!(ids(&projects, |p| p.id.clone()), set(&["active"]));
    }
}
