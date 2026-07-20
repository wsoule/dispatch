mod tail;

use crate::db::Db;
use crate::parser::{self, ParsedRecord};
use notify_debouncer_mini::new_debouncer;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE_MS: u64 = 500;

pub fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Best-effort guess at Codex CLI's session log root — see `parser::codex_jsonl`'s module doc
/// for how confident (or not) that format is. Unverified against a real installation.
pub fn codex_sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

/// Best-effort guess at Gemini CLI's session log root — see `parser::gemini_log`'s module doc.
/// Unverified against a real installation.
pub fn gemini_logs_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".gemini").join("tmp"))
}

/// Best-effort guess at Cursor Agent CLI's session log root — see `parser::cursor_jsonl`'s
/// module doc. Unverified against a real installation.
pub fn cursor_logs_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor").join("logs"))
}

/// One entry per agent CLI this app knows how to tail. `parse_line` always takes the file's
/// path as its second argument for a uniform fn-pointer type across every agent, even though
/// only `codex`/`gemini` actually use it (they need it to recall per-file session context —
/// see their module docs); `claude`/`cursor`'s closures just ignore it.
struct AgentSource {
    agent: &'static str,
    root: fn() -> Option<PathBuf>,
    extension: &'static str,
    parse_line: fn(&str, &Path) -> Option<ParsedRecord>,
}

const AGENT_SOURCES: &[AgentSource] = &[
    AgentSource {
        agent: "claude",
        root: claude_projects_dir,
        extension: "jsonl",
        parse_line: |line, _path| parser::parse_line(line),
    },
    AgentSource {
        agent: "codex",
        root: codex_sessions_dir,
        extension: "jsonl",
        parse_line: |line, path| parser::parse_codex_line(line, &path.to_string_lossy()),
    },
    AgentSource {
        agent: "gemini",
        root: gemini_logs_dir,
        extension: "jsonl",
        parse_line: |line, path| parser::parse_gemini_line(line, &path.to_string_lossy()),
    },
    AgentSource {
        agent: "cursor",
        root: cursor_logs_dir,
        extension: "jsonl",
        parse_line: |line, _path| parser::parse_cursor_line(line),
    },
];

/// Starts the FS watcher on a dedicated thread, across every known agent CLI: backfills every
/// pre-existing session file once at startup (resuming from `ingest_state`, never
/// double-processing), then watches for live appends and newly created files/directories.
pub fn start(app_handle: AppHandle) {
    let mut roots: Vec<(PathBuf, &'static AgentSource)> = Vec::new();

    for source in AGENT_SOURCES {
        let Some(dir) = (source.root)() else {
            log::warn!(
                "could not resolve home directory; {} log watching disabled",
                source.agent
            );
            continue;
        };
        backfill(&app_handle, &dir, source);
        roots.push((dir, source));
    }

    std::thread::spawn(move || {
        if let Err(e) = run_watcher(app_handle, roots) {
            log::error!("agent log watcher exited with error: {e:#}");
        }
    });
}

fn backfill(app_handle: &AppHandle, watch_dir: &Path, source: &AgentSource) {
    if !watch_dir.exists() {
        log::info!(
            "{} does not exist yet; will start watching once {} creates it",
            watch_dir.display(),
            source.agent
        );
        return;
    }

    // Recursive rather than a fixed depth, since agents differ in how deeply they nest session
    // files (Claude Code: `projects/<hash>/<session>.jsonl`, Codex's assumed layout goes one
    // level deeper still with dated subdirectories) — matches the recursive live watch below.
    let mut stack = vec![watch_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some(source.extension) {
                process_file(app_handle, &path, source);
            }
        }
    }
}

fn run_watcher(app_handle: AppHandle, roots: Vec<(PathBuf, &'static AgentSource)>) -> notify::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), tx)?;

    // Watch each root's parent instead if the root doesn't exist yet — notify can't watch a
    // nonexistent path, but a recursive watch on an existing ancestor still picks up the root
    // (and everything under it) the moment its owning agent creates it. Two sources can
    // resolve to the same ancestor (e.g. neither `~/.codex/sessions` nor `~/.gemini/tmp`
    // exists yet, but both fall back to `~`) — dedup so notify never gets the same path twice.
    let mut watched_targets: Vec<PathBuf> = Vec::new();
    for (root, source) in &roots {
        let target = if root.exists() {
            root.clone()
        } else {
            root.parent().map(Path::to_path_buf).unwrap_or_else(|| root.clone())
        };
        if !watched_targets.contains(&target) {
            debouncer.watcher().watch(&target, notify::RecursiveMode::Recursive)?;
            watched_targets.push(target.clone());
        }
        log::info!("watching {} for {} session logs", target.display(), source.agent);
    }

    for result in rx {
        match result {
            Ok(events) => {
                for event in events {
                    let Some(source) = source_for_path(&event.path, &roots) else {
                        continue;
                    };
                    if event.path.extension().and_then(|e| e.to_str()) == Some(source.extension) {
                        process_file(&app_handle, &event.path, source);
                    }
                }
            }
            Err(e) => log::warn!("watcher error: {e:?}"),
        }
    }

    Ok(())
}

/// Finds which agent source's root a changed path falls under — needed since one debouncer
/// now watches every agent's log tree at once (or, before a given root exists, a shared
/// ancestor covering more than just that one agent's root).
fn source_for_path<'a>(
    path: &Path,
    roots: &[(PathBuf, &'a AgentSource)],
) -> Option<&'a AgentSource> {
    roots
        .iter()
        .find(|(root, _)| path.starts_with(root))
        .map(|(_, source)| *source)
}

fn process_file(app_handle: &AppHandle, path: &Path, source: &AgentSource) {
    let db = app_handle.state::<Db>();
    let conn = db.0.lock().unwrap();

    let lines = match tail::read_new_lines(&conn, path) {
        Ok(lines) => lines,
        Err(e) => {
            log::warn!("failed to tail {}: {e:#}", path.display());
            return;
        }
    };

    if lines.is_empty() {
        return;
    }

    let raw_log_path = path.to_string_lossy().to_string();
    let mut anything_changed = false;
    let mut session_created = false;

    for line in lines {
        let Some(record) = (source.parse_line)(&line, path) else {
            continue;
        };
        match parser::ingest_record(&conn, &raw_log_path, record) {
            Ok(outcome) => {
                if outcome.project_touched.is_some()
                    || outcome.session_created.is_some()
                    || outcome.session_updated.is_some()
                {
                    anything_changed = true;
                }
                if outcome.session_created.is_some() {
                    session_created = true;
                }
            }
            Err(e) => log::warn!("failed to ingest record from {}: {e:#}", path.display()),
        }
    }

    drop(conn);

    if anything_changed {
        let _ = app_handle.emit(
            "data-changed",
            serde_json::json!({
                "entity": "session",
                "kind": if session_created { "created" } else { "updated" },
            }),
        );
    }
}
