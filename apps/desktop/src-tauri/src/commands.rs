use crate::activity;
use crate::db::{queries, Db};
use crate::parser;
use crate::terminal;
use chrono::{Duration, NaiveDate, Utc};
use serde::Serialize;
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

#[cfg(test)]
mod tests {
    use super::*;

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
