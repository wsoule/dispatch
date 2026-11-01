mod tail;

use crate::db::Db;
use crate::parser;
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

/// Provider parsers share explicit, file-owned header context; stateless parsers ignore it.
struct AgentSource {
    agent: &'static str,
    root: fn() -> Option<PathBuf>,
    extension: &'static str,
    parse_line: tail::ParseLine,
}

const AGENT_SOURCES: &[AgentSource] = &[
    AgentSource {
        agent: "claude",
        root: claude_projects_dir,
        extension: "jsonl",
        parse_line: |line, _context| parser::parse_line(line),
    },
    AgentSource {
        agent: "codex",
        root: codex_sessions_dir,
        extension: "jsonl",
        parse_line: parser::codex_jsonl::parse_with_context,
    },
    AgentSource {
        agent: "gemini",
        root: gemini_logs_dir,
        extension: "jsonl",
        parse_line: parser::gemini_log::parse_with_context,
    },
    AgentSource {
        agent: "cursor",
        root: cursor_logs_dir,
        extension: "jsonl",
        parse_line: |line, _context| parser::parse_cursor_line(line),
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
        roots.push((dir, source));
    }

    // Register before scanning. Events queue during synchronous catch-up; the same owner
    // drains them afterward, so an append cannot fall between scan and registration.
    let (tx, rx) = std::sync::mpsc::channel();
    let debouncer = match new_debouncer(Duration::from_millis(DEBOUNCE_MS), tx) {
        Ok(mut debouncer) => {
            if let Err(e) = register_watches(&mut debouncer, &roots) {
                log::error!("could not register history watches: {e}");
            }
            Some(debouncer)
        }
        Err(e) => {
            log::error!("could not create history watcher: {e}");
            None
        }
    };
    // Watcher failure must not prevent the synchronous history import.
    for (dir, source) in &roots {
        backfill(&app_handle, dir, source);
    }
    if let Some(debouncer) = debouncer {
        std::thread::spawn(move || {
            let _debouncer = debouncer;
            run_watcher(app_handle, roots, rx);
        });
    }
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

fn register_watches(
    debouncer: &mut notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
    roots: &[(PathBuf, &'static AgentSource)],
) -> notify::Result<()> {
    // Watch each root's parent instead if the root doesn't exist yet — notify can't watch a
    // nonexistent path, but a recursive watch on an existing ancestor still picks up the root
    // (and everything under it) the moment its owning agent creates it. Two sources can
    // resolve to the same ancestor (e.g. neither `~/.codex/sessions` nor `~/.gemini/tmp`
    // exists yet, but both fall back to `~`) — dedup so notify never gets the same path twice.
    let mut watched_targets: Vec<PathBuf> = Vec::new();
    for (root, source) in roots {
        let mut target = root.clone();
        while !target.exists() {
            let Some(parent) = target.parent() else {
                break;
            };
            target = parent.to_path_buf();
        }
        if !watched_targets.contains(&target) {
            debouncer
                .watcher()
                .watch(&target, notify::RecursiveMode::Recursive)?;
            watched_targets.push(target.clone());
        }
        log::info!(
            "watching {} for {} session logs",
            target.display(),
            source.agent
        );
    }

    Ok(())
}

fn run_watcher(
    app_handle: AppHandle,
    roots: Vec<(PathBuf, &'static AgentSource)>,
    rx: std::sync::mpsc::Receiver<notify_debouncer_mini::DebounceEventResult>,
) {
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

/// Applies one bounded segment atomically; errors roll back effects and continuation alike.
fn apply_segment(
    conn: &rusqlite::Connection,
    path: &Path,
    parse: tail::ParseLine,
    segment: &mut tail::Segment,
) -> anyhow::Result<(bool, bool)> {
    let tx = conn.unchecked_transaction()?;
    let mut batch = parser::session_builder::IngestBatch::default();
    let mut changed = false;
    let mut created = false;
    for line in &segment.lines {
        let Some(record) = parse(line, &mut segment.cursor.context) else {
            continue;
        };
        let outcome = batch.ingest(&tx, &path.to_string_lossy(), record)?;
        changed |= outcome.project_touched.is_some()
            || outcome.session_created.is_some()
            || outcome.session_updated.is_some();
        created |= outcome.session_created.is_some();
    }
    batch.finish(&tx)?;
    tail::checkpoint(&tx, path, segment)?;
    tx.commit()?;
    Ok((changed, created))
}

/// Backfill and queued live events call this serially: one logical cursor owner per file.
fn process_file(app_handle: &AppHandle, path: &Path, source: &AgentSource) {
    let db = app_handle.state::<Db>();
    let result = (|| -> anyhow::Result<()> {
        let mut reader = tail::Reader::open(path)?;
        let mut cursor = tail::cursor(&db.0.lock().unwrap(), path)?;
        if reader.recover_context(&mut cursor, source.parse_line)? {
            tail::persist_context(&db.0.lock().unwrap(), path, &cursor)?;
        }
        while let Some(mut segment) = reader.read_segment(cursor)? {
            let (changed, created) = {
                let conn = db.0.lock().unwrap();
                apply_segment(&conn, path, source.parse_line, &mut segment)?
            };
            if changed {
                let _ = app_handle.emit(
                    "data-changed",
                    serde_json::json!({
                        "entity": "session", "kind": if created { "created" } else { "updated" }
                    }),
                );
            }
            cursor = segment.cursor;
        }
        Ok(())
    })();
    if let Err(e) = result {
        log::warn!("failed to ingest {}: {e:#}", path.display());
    }
}

#[cfg(test)]
mod tests;
