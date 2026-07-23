use crate::activity;
use crate::db::{queries, Db};
use crate::parser;
use crate::registry;
use crate::sidecar;
use crate::terminal;
use chrono::{Duration, NaiveDate, Utc};
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use tauri::{Emitter, State};

/// Width of the Dashboard's GitHub-style activity heatmap, in days.
const HEATMAP_DAYS: i64 = 365;

#[tauri::command]
pub fn list_projects(db: State<'_, Db>) -> Result<Vec<queries::ProjectSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_sessions(db: State<'_, Db>) -> Result<Vec<queries::Session>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_sessions(&conn).map_err(|e| e.to_string())
}

/// Return shape for `get_session_detail` — wraps the session row together with its file
/// changes, since a frontend detail view needs both.
#[derive(Debug, Clone, Serialize)]
pub struct SessionDetail {
    pub session: queries::Session,
    pub files_changed: Vec<queries::FileChanged>,
}

#[tauri::command]
pub fn get_session_detail(
    db: State<'_, Db>,
    session_id: String,
) -> Result<Option<SessionDetail>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_session_detail(&conn, &session_id)
        .map(|opt| opt.map(|(session, files_changed)| SessionDetail { session, files_changed }))
        .map_err(|e| e.to_string())
}

/// Opens `path` in the user's editor: `$EDITOR <path>` if that env var is set, otherwise falls
/// back to VS Code's `code <path>` CLI. Spawns and returns immediately (doesn't wait for the
/// editor to exit) — this is triggered by a button click in the session detail modal and
/// shouldn't block the UI. A spawn failure (e.g. neither `$EDITOR` nor `code` is on `PATH`) is
/// an expected, recoverable case surfaced to the caller as an `Err`, not a panic.
#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    if let Ok(editor) = std::env::var("EDITOR") {
        if !editor.trim().is_empty() {
            return Command::new(&editor)
                .arg(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("failed to launch $EDITOR ({editor}): {e}"));
        }
    }

    Command::new("code")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch editor: $EDITOR is not set and `code` failed to start: {e}"))
}

/// Returns a 14-day daily git-commit-count sparkline for the project at `project_path`, for
/// the decorative `ActivityBars` component on each project card. Returns `Vec<i64>` directly,
/// not `Result` — see `activity`'s module doc comment for why: every failure mode (not a git
/// repo, no `git` on `PATH`, shellout failure) already degrades to `vec![0; 14]` inside
/// `activity::project_activity`, so there's no error state left for the frontend to handle.
#[tauri::command]
pub fn project_activity(project_path: String, cache: State<'_, activity::ActivityCache>) -> Vec<i64> {
    activity::project_activity(&project_path, &cache)
}

/// Width of a project's Overview-tab commit heatmap, in days — same window as the
/// Dashboard's heatmap, for visual consistency between the two.
const GIT_HEATMAP_DAYS: i64 = 365;

/// How many recent commits the Overview tab's "Recent commits" list shows.
const RECENT_COMMITS_LIMIT: usize = 8;

/// Richer git-derived context for a single project's Overview tab: a full-year commit
/// heatmap (reusing the Dashboard's `ActivityHeatmap` component on the frontend) plus a
/// short list of the most recent commits. Unlike `project_activity`'s 14-day sparkline,
/// this isn't cached — it's only fetched once per Overview-tab visit, and react-query's
/// own 30s `staleTime` already absorbs repeat mounts.
#[derive(Debug, Clone, Serialize)]
pub struct GitInsights {
    /// Oldest first, one entry per day, `GIT_HEATMAP_DAYS` long (today inclusive) — commit
    /// counts, not session/usage activity.
    pub commit_heatmap: Vec<DailyActivity>,
    /// Newest first, capped at `RECENT_COMMITS_LIMIT`. Empty if `project_path` isn't a git
    /// repo, `git` isn't on `PATH`, or the shellout otherwise fails — same "degrade
    /// silently" contract as `project_activity`.
    pub recent_commits: Vec<activity::CommitInfo>,
}

#[tauri::command]
pub fn project_git_insights(project_path: String) -> GitInsights {
    let timestamps = activity::git_log_timestamps(&project_path, GIT_HEATMAP_DAYS);

    let mut counts_by_day: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for ts in &timestamps {
        if let Some(dt) = chrono::DateTime::from_timestamp(*ts, 0) {
            *counts_by_day.entry(dt.format("%Y-%m-%d").to_string()).or_insert(0) += 1;
        }
    }

    let today = Utc::now().date_naive();
    let window_start = today - Duration::days(GIT_HEATMAP_DAYS - 1);
    let commit_heatmap = dense_daily_activity(window_start, today, &counts_by_day);

    let recent_commits = activity::git_recent_commits(&project_path, RECENT_COMMITS_LIMIT);

    GitInsights { commit_heatmap, recent_commits }
}

/// Caps how many diff lines `get_file_diff_for_session_file` will ever serialize over IPC —
/// a `Write` of a very large generated file (e.g. a lockfile) would otherwise dump the entire
/// thing into the UI. Generous enough that real edits never hit it in practice.
const MAX_DIFF_LINES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    /// "insert" | "delete" | "equal".
    pub tag: &'static str,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    pub lines: Vec<DiffLine>,
    pub truncated: bool,
    /// When the most recent edit folded into this diff occurred.
    pub occurred_at: i64,
    /// How many separate tool-call edits (across the session) were folded into this diff —
    /// the frontend uses this to label a multi-edit file distinctly from a single-edit one.
    pub edit_count: i64,
}

/// Builds a single cumulative line-level diff for everything one session did to one file —
/// before-text from that file's earliest edit in the session, after-text from its most
/// recent — rather than one diff per tool call. Returns `Ok(None)` if this session never
/// touched `file_path`; returns `Ok(Some(FileDiff { lines: vec![], .. }))` if it did but
/// every row predates the migration that started capturing `old_content`/`new_content` (both
/// `NULL`) — the frontend tells these two "nothing to show" cases apart to explain *why*
/// there's no diff rather than just showing a blank panel.
#[tauri::command]
pub fn get_file_diff_for_session_file(
    db: State<'_, Db>,
    session_id: String,
    file_path: String,
) -> Result<Option<FileDiff>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some(span) = queries::file_diff_span(&conn, &session_id, &file_path).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };

    if span.old_content.is_none() && span.new_content.is_none() {
        return Ok(Some(FileDiff {
            lines: Vec::new(),
            truncated: false,
            occurred_at: span.latest_occurred_at,
            edit_count: span.edit_count,
        }));
    }

    let old = span.old_content.unwrap_or_default();
    let new = span.new_content.unwrap_or_default();

    use similar::{ChangeTag, TextDiff};
    let diff = TextDiff::from_lines(&old, &new);
    let mut lines = Vec::new();
    let mut truncated = false;
    for change in diff.iter_all_changes() {
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            break;
        }
        let tag = match change.tag() {
            ChangeTag::Insert => "insert",
            ChangeTag::Delete => "delete",
            ChangeTag::Equal => "equal",
        };
        lines.push(DiffLine {
            tag,
            content: change.value().trim_end_matches('\n').to_string(),
        });
    }

    Ok(Some(FileDiff {
        lines,
        truncated,
        occurred_at: span.latest_occurred_at,
        edit_count: span.edit_count,
    }))
}

/// One day's worth of Dashboard heatmap data — a dense, zero-filled point (unlike
/// `queries::daily_activity_counts`'s sparse map) so the frontend can render a fixed grid
/// without doing its own gap-filling.
#[derive(Debug, Clone, Serialize)]
pub struct DailyActivity {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    pub total_cost_usd: f64,
    pub total_sessions: i64,
    /// Count of every project Relay knows about — independent of `top_projects`'s cap, so
    /// this stays accurate once there are more projects than the "highest usage" list shows.
    pub total_projects: i64,
    /// Oldest first, one entry per day, `HEATMAP_DAYS` long (today inclusive).
    pub daily_activity: Vec<DailyActivity>,
    /// Highest-spend projects first, capped for display — see `TOP_PROJECTS_LIMIT`.
    pub top_projects: Vec<queries::ProjectSummary>,
    pub agent_usage: Vec<queries::AgentUsage>,
    /// The most-recently-active `status = 'active'` session, if any — powers the Dashboard's
    /// "active now" widget.
    pub active_session: Option<queries::ActiveSessionSummary>,
}

/// How many projects the Dashboard's "highest usage" list shows.
const TOP_PROJECTS_LIMIT: usize = 5;

#[tauri::command]
pub fn dashboard_stats(db: State<'_, Db>) -> Result<DashboardStats, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Headline numbers (total_cost_usd/total_sessions/total_projects/top_projects) all derive
    // from this one list.
    let mut projects = queries::list_projects(&conn).map_err(|e| e.to_string())?;
    let total_cost_usd: f64 = projects.iter().map(|p| p.total_cost_usd).sum();
    let total_sessions: i64 = projects.iter().map(|p| p.session_count).sum();
    let total_projects = projects.len() as i64;

    // `list_projects` orders by `last_active DESC`; the Dashboard's "highest usage" list
    // needs spend order instead, so re-sort here rather than adding a second SQL query.
    projects.sort_by(|a, b| {
        b.total_cost_usd
            .partial_cmp(&a.total_cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    projects.truncate(TOP_PROJECTS_LIMIT);

    let agent_usage = queries::agent_usage(&conn).map_err(|e| e.to_string())?;
    let active_session =
        queries::most_recent_active_session(&conn).map_err(|e| e.to_string())?;

    let today = Utc::now().date_naive();
    let window_start = today - Duration::days(HEATMAP_DAYS - 1);
    let since_epoch = window_start
        .and_hms_opt(0, 0, 0)
        .expect("midnight is always a valid time")
        .and_utc()
        .timestamp();
    let counts_by_day =
        queries::daily_activity_counts(&conn, since_epoch).map_err(|e| e.to_string())?;

    let daily_activity = dense_daily_activity(window_start, today, &counts_by_day);

    Ok(DashboardStats {
        total_cost_usd,
        total_sessions,
        total_projects,
        daily_activity,
        top_projects: projects,
        agent_usage,
        active_session,
    })
}

/// Walks `[start, end]` inclusive, one entry per calendar day, filling in `0` for any day
/// missing from `counts_by_day` — split out from `dashboard_stats` so the date-walking logic
/// is unit-testable without a DB connection.
fn dense_daily_activity(
    start: NaiveDate,
    end: NaiveDate,
    counts_by_day: &std::collections::HashMap<String, i64>,
) -> Vec<DailyActivity> {
    let mut out = Vec::new();
    let mut day = start;
    while day <= end {
        let date = day.format("%Y-%m-%d").to_string();
        let count = counts_by_day.get(&date).copied().unwrap_or(0);
        out.push(DailyActivity { date, count });
        day += Duration::days(1);
    }
    out
}

// --- Reports ---

/// Aggregated report payload for the Reports view: headline totals plus three breakdowns
/// (by project, by tag, by agent), all windowed to the same `[since_epoch, now]` range.
/// `range_days`/`since_epoch` are echoed back so the frontend and `render_report_markdown`
/// can label the window without recomputing it from `Utc::now()` a second time.
#[derive(Debug, Clone, Serialize)]
pub struct ReportData {
    pub range_days: i64,
    pub since_epoch: i64,
    pub totals: queries::ReportTotals,
    pub by_project: Vec<queries::ReportProjectRow>,
    pub by_tag: Vec<queries::ReportTagRow>,
    pub by_agent: Vec<queries::AgentUsage>,
}

fn build_report(conn: &rusqlite::Connection, range_days: i64) -> Result<ReportData, String> {
    let since_epoch = (Utc::now() - Duration::days(range_days)).timestamp();

    Ok(ReportData {
        range_days,
        since_epoch,
        totals: queries::report_totals(conn, since_epoch).map_err(|e| e.to_string())?,
        by_project: queries::report_by_project(conn, since_epoch).map_err(|e| e.to_string())?,
        by_tag: queries::report_by_tag(conn, since_epoch).map_err(|e| e.to_string())?,
        by_agent: queries::agent_usage_since(conn, since_epoch).map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub fn generate_report(db: State<'_, Db>, range_days: i64) -> Result<ReportData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    build_report(&conn, range_days)
}

/// Renders the same data `generate_report` returns as a standalone Markdown document, writes
/// it to disk, and returns the absolute path — a shareable artifact for the manager/team-lead
/// audience the Reports view exists for, not just an in-app table. Written under the user's
/// Downloads directory (falling back to their home directory if that can't be resolved, e.g. a
/// locked-down sandbox) rather than the app-data directory, since the whole point is for the
/// user to find this file and hand it to someone else.
#[tauri::command]
pub fn export_report(db: State<'_, Db>, range_days: i64) -> Result<String, String> {
    let report = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        build_report(&conn, range_days)?
    };

    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "could not resolve a directory to save the report into".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let filename = format!("relay-report-{}.md", Utc::now().format("%Y-%m-%d-%H%M%S"));
    let path = dir.join(filename);
    std::fs::write(&path, render_report_markdown(&report)).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

fn render_report_markdown(report: &ReportData) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Relay spend report — last {} days\n\n", report.range_days));
    out.push_str(&format!("Generated {}\n\n", Utc::now().format("%Y-%m-%d %H:%M UTC")));

    out.push_str("## Totals\n\n");
    out.push_str(&format!("- Total spend: ${:.2}\n", report.totals.total_cost_usd));
    out.push_str(&format!("- Sessions: {}\n", report.totals.session_count));
    let avg = if report.totals.session_count > 0 {
        report.totals.total_cost_usd / report.totals.session_count as f64
    } else {
        0.0
    };
    out.push_str(&format!("- Avg cost / session: ${avg:.2}\n"));
    out.push_str(&format!(
        "- Tokens: {} prompt, {} completion, {} cache read, {} cache write\n\n",
        report.totals.prompt_tokens,
        report.totals.completion_tokens,
        report.totals.cache_read_tokens,
        report.totals.cache_creation_tokens
    ));

    out.push_str("## By project\n\n| Project | Sessions | Spend |\n|---|---:|---:|\n");
    for row in &report.by_project {
        out.push_str(&format!(
            "| {} | {} | ${:.2} |\n",
            row.project_name, row.session_count, row.total_cost_usd
        ));
    }

    out.push_str("\n## By tag\n\n| Tag | Sessions | Spend |\n|---|---:|---:|\n");
    for row in &report.by_tag {
        out.push_str(&format!(
            "| {} | {} | ${:.2} |\n",
            row.tag, row.session_count, row.total_cost_usd
        ));
    }

    out.push_str("\n## By agent\n\n| Agent | Sessions | Spend |\n|---|---:|---:|\n");
    for row in &report.by_agent {
        out.push_str(&format!(
            "| {} | {} | ${:.2} |\n",
            row.agent, row.session_count, row.total_cost_usd
        ));
    }

    out
}

/// Opens `url` in the user's default browser — macOS only, matching Relay's current
/// platform scope.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open {url}: {e}"))
}

/// Reveals `path` in Finder — macOS only, matching Relay's current platform scope (see the
/// README's "Requirements"). Used by the Reports view's "Reveal in Finder" button right after
/// `export_report` writes a file, so the user doesn't have to hunt through Downloads for it.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to reveal {path} in Finder: {e}"))
}

/// Renders `session_id`'s raw Claude Code log as a readable Markdown transcript and writes it
/// to the user's Downloads directory, mirroring `export_report`'s save-and-return-path
/// contract so the frontend can reuse the same `reveal_in_finder` follow-up action.
#[tauri::command]
pub fn export_transcript(db: State<'_, Db>, session_id: String) -> Result<String, String> {
    let session = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_session(&conn, &session_id).map_err(|e| e.to_string())?
    };
    let session = session.ok_or_else(|| format!("session {session_id} not found"))?;

    let transcript = parser::render_markdown(&session.raw_log_path).map_err(|e| e.to_string())?;

    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "could not resolve a directory to save the transcript into".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let filename = format!(
        "relay-transcript-{}-{}.md",
        &session.id[..8],
        Utc::now().format("%Y-%m-%d-%H%M%S")
    );
    let path = dir.join(filename);
    std::fs::write(&path, format!("{}{transcript}", render_transcript_header(&session)))
        .map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

fn render_transcript_header(session: &queries::Session) -> String {
    let title = session
        .title
        .as_deref()
        .or(session.summary.as_deref())
        .unwrap_or("Untitled session");

    format!(
        "# {title}\n\n- Session: {}\n- Model: {}\n- Status: {}\n- Cost: ${:.2}\n\n---\n\n",
        session.id,
        session.model.as_deref().unwrap_or("unknown"),
        session.status,
        session.cost_usd,
    )
}

// --- Kanban board ---

/// Emits the same coarse `data-changed` event every other mutation path uses — the frontend
/// hook invalidates by query key, not by payload, so a new event *kind* isn't needed here.
fn emit_data_changed(app: &tauri::AppHandle) {
    let _ = app.emit("data-changed", serde_json::json!({ "entity": "board", "kind": "updated" }));
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardData {
    pub board: queries::Board,
    pub columns: Vec<queries::Column>,
    pub cards: Vec<queries::Card>,
}

#[tauri::command]
pub fn get_board(db: State<'_, Db>, project_id: String) -> Result<BoardData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_board(&conn, &project_id)
        .map(|(board, columns, cards)| BoardData { board, columns, cards })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_card(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    board_id: String,
    column_id: String,
    title: String,
    description: Option<String>,
) -> Result<queries::Card, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let card = queries::create_card(&conn, &board_id, &column_id, &title, description.as_deref())
        .map_err(|e| e.to_string())?;
    drop(conn);
    emit_data_changed(&app);
    Ok(card)
}

#[tauri::command]
pub fn move_card(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    card_id: String,
    column_id: String,
    position: i64,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::move_card(&conn, &card_id, &column_id, position).map_err(|e| e.to_string())?;
    drop(conn);
    emit_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn update_card(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    card_id: String,
    title: String,
    description: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_card(&conn, &card_id, &title, description.as_deref()).map_err(|e| e.to_string())?;
    drop(conn);
    emit_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_card(app: tauri::AppHandle, db: State<'_, Db>, card_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_card(&conn, &card_id).map_err(|e| e.to_string())?;
    drop(conn);
    emit_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn link_session_to_card(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    card_id: String,
    session_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::link_session_to_card(&conn, &card_id, &session_id).map_err(|e| e.to_string())?;
    drop(conn);
    emit_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn create_column(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    board_id: String,
    name: String,
) -> Result<queries::Column, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let column = queries::create_column(&conn, &board_id, &name).map_err(|e| e.to_string())?;
    drop(conn);
    emit_data_changed(&app);
    Ok(column)
}

#[tauri::command]
pub fn rename_column(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    column_id: String,
    name: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_column(&conn, &column_id, &name).map_err(|e| e.to_string())?;
    drop(conn);
    emit_data_changed(&app);
    Ok(())
}

/// Called when a card with no linked session is dropped onto a board's seeded "in_progress"
/// column: attaches the card's title/description as a prompt to a live `claude` CLI session
/// already running for that project (if one's open in a Terminal.app tab), resumes the most
/// recently active session for that project in a new Terminal window (if Relay's own DB
/// shows one active but no matching tab was found), or starts a brand new session otherwise.
///
/// Returns a short outcome string (`"attached_existing_tab"`, `"resumed_in_new_window"`,
/// `"started_new_window"`, or a `"skipped: ..."` reason) rather than `()` — purely for the
/// frontend to log, not surfaced as an error, since "the card wasn't actually eligible" is
/// an expected outcome (e.g. a card already linked to a session, or the frontend racing a
/// second drop event) rather than a failure.
///
/// Deliberately releases the DB lock before calling `terminal::attach_or_launch` — that call
/// blocks for a couple of seconds (AppleScript delays while a new Terminal window's `claude`
/// boots up), and holding the single shared connection mutex across that would stall every
/// other DB access for the duration, the same lock-discipline concern documented on
/// `lib.rs`'s idle sweep.
#[tauri::command]
pub fn launch_or_attach_session(db: State<'_, Db>, card_id: String) -> Result<String, String> {
    let prepared = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;

        let Some(context) = queries::card_launch_context(&conn, &card_id).map_err(|e| e.to_string())?
        else {
            return Ok("skipped: card not found".to_string());
        };
        if context.session_id.is_some() {
            return Ok("skipped: card is already linked to a session".to_string());
        }
        if context.column_role.as_deref() != Some("in_progress") {
            return Ok("skipped: card is not on the in_progress column".to_string());
        }

        let resume_id =
            queries::most_recent_active_session_id_for_project(&conn, &context.project_id)
                .map_err(|e| e.to_string())?;

        // Stamp the card so the session Claude Code is about to create gets adopted into it by
        // the ingest path (queries::adopt_pending_card_for_session), rather than spawning a
        // duplicate auto-created card. Done here, before the lock is released and the terminal
        // opens, so the stamp is durable well before the first log line lands.
        queries::set_card_pending_launch(&conn, &card_id).map_err(|e| e.to_string())?;

        (context, resume_id)
    };
    let (context, resume_id) = prepared;

    let mut prompt = context.title;
    if let Some(description) = context.description.filter(|d| !d.trim().is_empty()) {
        prompt.push_str("\n\n");
        prompt.push_str(&description);
    }

    terminal::attach_or_launch(&context.project_path, resume_id.as_deref(), &prompt)
        .map_err(|e| e.to_string())
}

// --- Dispatch task sidecar (Phase 2R, Slice R2) ---

/// Ensures a `dispatchd` daemon is running for `root` (a project's absolute
/// path) and returns its port, spawning one if needed — see `sidecar`'s
/// module doc comment for the fast-path/spawn/poll behavior this delegates
/// to. `root` here is a project path, not the monorepo root; `manifest_dir`
/// (this crate's own `CARGO_MANIFEST_DIR`, baked in at compile time) is what
/// dev-only bin resolution walks up from to find `packages/server/src/bin.ts`.
#[tauri::command]
pub async fn ensure_dispatchd(
    app: tauri::AppHandle,
    children: State<'_, sidecar::DispatchdChildren>,
    root: String,
) -> Result<u16, String> {
    let launch = resolve_daemon_launch(&app)?;
    sidecar::ensure_dispatchd(&sidecar::BunSpawner, &children, launch, &root).await
}

/// Picks how to start dispatchd for the running build. A dev build runs the TS
/// entry through `bun` from this checkout (`CARGO_MANIFEST_DIR`); a packaged
/// release runs the two standalone binaries bundled under the app's Resource
/// dir, so the shipped app depends on neither `bun` nor the checkout.
fn resolve_daemon_launch(
    app: &tauri::AppHandle,
) -> Result<sidecar::DaemonLaunch, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(sidecar::dev_launch(Path::new(env!("CARGO_MANIFEST_DIR"))))
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        let dispatchd = app
            .path()
            .resolve("resources/dispatchd", tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("cannot locate bundled dispatchd: {e}"))?;
        let mcp = app
            .path()
            .resolve(
                "resources/dispatch-mcp",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("cannot locate bundled MCP server: {e}"))?;
        Ok(sidecar::DaemonLaunch::Bundled { dispatchd, mcp })
    }
}

/// True if `root` has a `.dispatch/` directory — gates whether
/// `ProjectDetail` offers a Tasks tab at all, before ever calling
/// `ensure_dispatchd`.
#[tauri::command]
pub fn has_dispatch(root: String) -> bool {
    sidecar::has_dispatch(&root)
}

/// Extracts a `--root <path>` (or `--root=<path>`) value from a process's
/// argument list, if present. This is how a packaged/standalone launch tells the
/// app which project to open — e.g. `open -a Dispatch --args --root /path/to/proj`
/// or `dispatch-desktop --root /path/to/proj` — the first link in
/// `resolve_project_root`'s chain.
fn root_arg_from(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--root=") {
            return Some(value.to_string());
        }
        if arg == "--root" {
            return iter.next().cloned();
        }
    }
    None
}

/// Resolves the single project this window opens to, in priority order:
///
/// 1. An explicit `--root <path>` launch argument (validated absolute + an
///    existing directory) — how a packaged build is pointed at a project.
/// 2. The registry's most-recently-opened project — "reopen what I last had
///    open" across app restarts, and where the add-project/switcher flow's
///    selection persists to.
/// 3. A dev-only walk up from `CARGO_MANIFEST_DIR` (`apps/desktop/src-tauri` ->
///    three levels up to the monorepo root). This is the original single-project
///    behavior, kept as the fallback for a `tauri dev` run started with neither
///    a `--root` arg nor any registry entries yet. Deliberately *not*
///    `std::env::current_dir()`: `cargo run`'s cwd is this crate's own directory
///    (verified live via `lsof -p <pid> -d cwd`), which has no `.dispatch/`, so
///    cwd would silently send every launch to the get-started screen; walking up
///    from `CARGO_MANIFEST_DIR` (baked in at compile time) is the same trick
///    `sidecar::dispatchd_bin_path` uses, correct across worktrees.
///
/// Split from the `#[tauri::command]` wrapper so the chain is unit-testable with
/// injected args/registry rather than the process's real argv and the machine's
/// real `~/.dispatch/projects.json`.
fn resolve_project_root(
    args: &[String],
    registry_recent: Option<String>,
    manifest_dir: &Path,
) -> Result<String, String> {
    if let Some(root) = root_arg_from(args) {
        let path = Path::new(&root);
        if !path.is_absolute() {
            return Err(format!("--root must be an absolute path, got: {root}"));
        }
        if !path.is_dir() {
            return Err(format!("--root path does not exist: {root}"));
        }
        return Ok(root);
    }

    if let Some(recent) = registry_recent {
        // A stale registry entry (project deleted/moved on disk) falls through to
        // the dev walk-up rather than surfacing an error for a directory the user
        // can no longer open anyway.
        if Path::new(&recent).is_dir() {
            return Ok(recent);
        }
    }

    manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "project root path is not valid UTF-8".to_string())
}

/// The single project this window is scoped to — see `resolve_project_root` for
/// the launch-arg -> registry -> dev-walk-up resolution chain.
#[tauri::command]
pub fn current_project_root() -> Result<String, String> {
    let args: Vec<String> = std::env::args().collect();
    resolve_project_root(
        &args,
        registry::most_recent_path(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    )
}

// --- Project registry + onboarding (Task 8) ---

/// Every project the user has added/opened, for the sidebar's project switcher.
/// Reads `~/.dispatch/projects.json`; a missing/corrupt file reads as an empty
/// list (see `registry::list`), so this never errors.
#[tauri::command]
pub fn list_registered_projects() -> Vec<registry::RegisteredProject> {
    registry::list()
}

/// Registers `path` as a project (validating it's an existing directory first)
/// and returns the normalized absolute path stored for it — the caller then
/// switches the window to that normalized path.
#[tauri::command]
pub fn add_project(path: String) -> Result<String, String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    registry::upsert(&path).map(|entry| entry.path)
}

/// Stamps `lastOpenedAt` for `path` in the registry (adding it if absent), so the
/// switcher's "most recently opened" ordering and `current_project_root`'s
/// reopen-last chain stay current. Fired whenever the window switches projects.
#[tauri::command]
pub fn touch_project_opened(path: String) -> Result<(), String> {
    registry::touch_opened(&path)
}

/// One GitHub repository from `gh repo list`. `name_with_owner` (e.g.
/// `octocat/hello-world`) is what `clone_github_repo` clones; `name` is the bare
/// repo name for display and as the clone target's directory name. Serializes
/// `camelCase` both to match `gh`'s `--json` output (deserialize) and the
/// frontend's `GithubRepo` interface (serialize).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub name_with_owner: String,
    pub name: String,
    /// Empty string when the repo has no description (`gh` emits `""`, not null).
    #[serde(default)]
    pub description: String,
}

/// Verifies the GitHub CLI is installed and authenticated, turning both failure
/// modes into a clear, actionable error string rather than a cryptic downstream
/// clone/list failure. Runs `gh auth status`, which exits non-zero when `gh` is
/// present but unauthenticated.
fn ensure_gh_authenticated() -> Result<(), String> {
    let output = Command::new("gh")
        .arg("auth")
        .arg("status")
        .output()
        .map_err(|e| {
            format!("GitHub CLI (`gh`) is not installed or not on PATH: {e} — https://cli.github.com")
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "GitHub CLI is not authenticated — run `gh auth login`.\n{}",
            stderr.trim()
        ));
    }
    Ok(())
}

/// Lists the authenticated user's GitHub repositories (up to 100) via `gh repo
/// list`. Runs on a blocking thread pool so the shellout can't freeze the UI.
/// Errors cleanly when `gh` is missing/unauthenticated (see
/// `ensure_gh_authenticated`).
#[tauri::command]
pub async fn list_github_repos() -> Result<Vec<GithubRepo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ensure_gh_authenticated()?;
        let output = Command::new("gh")
            .args([
                "repo",
                "list",
                "--json",
                "nameWithOwner,name,description",
                "--limit",
                "100",
            ])
            .output()
            .map_err(|e| format!("failed to run `gh repo list`: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "`gh repo list` failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        serde_json::from_slice::<Vec<GithubRepo>>(&output.stdout)
            .map_err(|e| format!("could not parse `gh repo list` output: {e}"))
    })
    .await
    .map_err(|e| format!("gh task panicked: {e}"))?
}

/// Clones `name_with_owner` into `parent_dir`/<repo-name> via `gh repo clone` and
/// returns the absolute path of the new checkout. Errors if the target already
/// exists (rather than letting `gh` fail or clone into an unexpected place).
/// Runs on a blocking thread pool so the (potentially slow) clone can't freeze
/// the UI.
#[tauri::command]
pub async fn clone_github_repo(
    name_with_owner: String,
    parent_dir: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo_name = name_with_owner
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("invalid repository name: {name_with_owner}"))?;
        let target = Path::new(&parent_dir).join(repo_name);
        if target.exists() {
            return Err(format!(
                "a folder already exists at {} — pick a different location or remove it first",
                target.display()
            ));
        }
        let output = Command::new("gh")
            .arg("repo")
            .arg("clone")
            .arg(&name_with_owner)
            .arg(&target)
            .output()
            .map_err(|e| format!("failed to run `gh repo clone`: {e} — is `gh` installed?"))?;
        if !output.status.success() {
            return Err(format!(
                "`gh repo clone` failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("clone task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_project_root_walks_up_three_levels_to_the_monorepo_root() {
        // With no `--root` arg and no registry entry, the dev fallback walks three levels up
        // from this crate (`apps/desktop/src-tauri`) to the checkout root — identifiable here
        // by its root `package.json` (every workspace app/package has its own, but only the
        // root one sits at this exact level). Mirrors `sidecar`'s
        // `dispatchd_bin_path_resolves_to_a_real_file_in_this_checkout`.
        let result =
            resolve_project_root(&[], None, Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        assert!(
            Path::new(&result).join("package.json").is_file(),
            "expected {result} to be the monorepo root (no package.json found there)"
        );
    }

    #[test]
    fn resolve_project_root_does_not_resolve_to_the_process_working_directory() {
        // Regression guard for the bug this function exists to avoid: the Tauri CLI's `cargo
        // run` sets its cwd to this crate's own directory, not the monorepo root, so the dev
        // fallback must never be implemented in terms of `std::env::current_dir()` again.
        let result =
            resolve_project_root(&[], None, Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let cwd = std::env::current_dir().unwrap().to_str().unwrap().to_string();
        assert_ne!(result, cwd);
    }

    #[test]
    fn root_arg_from_reads_both_spaced_and_equals_forms() {
        assert_eq!(
            root_arg_from(&["app".to_string(), "--root".to_string(), "/x".to_string()]),
            Some("/x".to_string())
        );
        assert_eq!(
            root_arg_from(&["app".to_string(), "--root=/y".to_string()]),
            Some("/y".to_string())
        );
        assert_eq!(root_arg_from(&["app".to_string()]), None);
    }

    #[test]
    fn resolve_project_root_prefers_a_valid_root_arg_over_everything() {
        // An existing absolute dir passed via `--root` wins over both the registry and the dev
        // walk-up. Use the OS temp dir as a guaranteed-existing absolute directory.
        let tmp = std::env::temp_dir();
        let tmp_str = tmp.to_str().unwrap().to_string();
        let args = vec!["app".to_string(), "--root".to_string(), tmp_str.clone()];
        let result = resolve_project_root(
            &args,
            Some("/some/registry/path".to_string()),
            Path::new(env!("CARGO_MANIFEST_DIR")),
        )
        .unwrap();
        assert_eq!(result, tmp_str);
    }

    #[test]
    fn resolve_project_root_rejects_a_relative_or_missing_root_arg() {
        let relative = vec!["app".to_string(), "--root".to_string(), "rel/path".to_string()];
        assert!(
            resolve_project_root(&relative, None, Path::new(env!("CARGO_MANIFEST_DIR"))).is_err()
        );

        let missing = vec![
            "app".to_string(),
            "--root".to_string(),
            "/no/such/dir/anywhere-12345".to_string(),
        ];
        assert!(
            resolve_project_root(&missing, None, Path::new(env!("CARGO_MANIFEST_DIR"))).is_err()
        );
    }

    #[test]
    fn resolve_project_root_uses_a_valid_registry_entry_when_no_root_arg() {
        // An existing registry path (again the temp dir stands in for a real project) is used
        // when there's no `--root` arg.
        let tmp = std::env::temp_dir();
        let tmp_str = tmp.to_str().unwrap().to_string();
        let result = resolve_project_root(
            &[],
            Some(tmp_str.clone()),
            Path::new(env!("CARGO_MANIFEST_DIR")),
        )
        .unwrap();
        assert_eq!(result, tmp_str);
    }

    #[test]
    fn resolve_project_root_ignores_a_stale_registry_entry() {
        // A registry entry pointing at a deleted/moved directory falls through to the dev
        // walk-up rather than erroring.
        let result = resolve_project_root(
            &[],
            Some("/no/such/dir/anywhere-12345".to_string()),
            Path::new(env!("CARGO_MANIFEST_DIR")),
        )
        .unwrap();
        assert!(Path::new(&result).join("package.json").is_file());
    }

    #[test]
    fn dense_daily_activity_fills_gaps_and_keeps_range_inclusive() {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 1, 3).unwrap();
        let mut counts = std::collections::HashMap::new();
        counts.insert("2026-01-02".to_string(), 5);

        let result = dense_daily_activity(start, end, &counts);

        assert_eq!(
            result.iter().map(|d| (d.date.as_str(), d.count)).collect::<Vec<_>>(),
            vec![("2026-01-01", 0), ("2026-01-02", 5), ("2026-01-03", 0)],
        );
    }
}
