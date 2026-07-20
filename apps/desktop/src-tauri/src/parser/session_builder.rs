use super::record::{ParsedRecord, ToolUse};
use crate::cost::pricing;
use crate::db::queries::{self, TokenDelta};
use rusqlite::Connection;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// What changed as a result of ingesting one record — lets the watcher decide what
/// `data-changed` events to emit without re-querying the DB just to find out.
#[derive(Debug, Default)]
pub struct IngestOutcome {
    pub project_touched: Option<String>,
    pub session_created: Option<String>,
    pub session_updated: Option<String>,
}

pub fn ingest_record(
    conn: &Connection,
    raw_log_path: &str,
    record: ParsedRecord,
) -> anyhow::Result<IngestOutcome> {
    let mut outcome = IngestOutcome::default();

    // "ai-title" records carry neither `cwd` nor a `timestamp` (see claude_jsonl's doc
    // comment) — they're Claude Code's own auto-generated session title, always emitted
    // after the session row already exists (its first `user` record creates it), so this
    // is handled as its own early branch rather than falling into the cwd/timestamp checks
    // below, which it would never pass.
    if record.record_type == "ai-title" {
        if let (Some(session_id), Some(title)) = (record.session_id.clone(), record.ai_title.clone())
        {
            queries::update_session_title(conn, &session_id, &title)?;
            outcome.session_updated = Some(session_id);
        }
        return Ok(outcome);
    }

    // No cwd means we have no idea which project this belongs to — nothing to persist.
    let Some(cwd) = record.cwd.clone() else {
        return Ok(outcome);
    };
    // No timestamp means we can't place this in time (real logs have such lines, e.g.
    // some records preceding the first user/attachment record) — skip persisting.
    let Some(timestamp) = record.timestamp else {
        return Ok(outcome);
    };

    let project_id = project_id_for_path(&cwd);

    let project_name = std::path::Path::new(&cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&cwd)
        .to_string();

    queries::upsert_project(conn, &project_id, &project_name, &cwd, timestamp)?;
    outcome.project_touched = Some(project_id.clone());

    // `system` records only carry cwd/gitBranch metadata refresh, no session content.
    let Some(session_id) = record.session_id.clone() else {
        return Ok(outcome);
    };

    let delta = record
        .usage
        .as_ref()
        .map(|u| TokenDelta {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            cache_read_tokens: u.cache_read_input_tokens,
            cache_creation_tokens: u.cache_creation_input_tokens,
        })
        .unwrap_or_default();

    let created = queries::upsert_session(
        conn,
        &session_id,
        &project_id,
        record.agent,
        record.model.as_deref(),
        timestamp,
        raw_log_path,
        &delta,
    )?;

    if created {
        outcome.session_created = Some(session_id.clone());

        // Board/columns are ensured (not just looked up) here since this may be the very
        // first session ever seen for this project. Card title is a placeholder — no
        // first-user-text is available yet at this point in ingestion (that's only extracted
        // later, from the raw log, by the idle-sweep's tag/summary passes) — the user can
        // rename it once they open the card.
        let board_id = queries::ensure_board_for_project(conn, &project_id)?;
        // If the user spawned this session from a card (launch_or_attach_session stamped it),
        // adopt it into that card instead of minting a duplicate. Falls back to auto-create
        // when nothing is awaiting a launch in this project.
        if !queries::adopt_pending_card_for_session(conn, &project_id, &session_id)? {
            queries::auto_create_card_for_session(conn, &board_id, &session_id, "New session")?;
        }
    } else {
        outcome.session_updated = Some(session_id.clone());
    }

    // Recompute cost_usd from the now-updated accumulated totals (not the delta just applied)
    // so this stays consistent with `all_session_token_totals` + `update_cost`'s use for
    // recomputing every session's cost after a pricing-table edit, without re-parsing logs.
    if let Some(totals) = queries::session_token_totals(conn, &session_id)? {
        let cost = pricing::cost_usd(
            totals.model.as_deref(),
            totals.prompt_tokens,
            totals.completion_tokens,
            totals.cache_read_tokens,
            totals.cache_creation_tokens,
        );
        queries::update_cost(conn, &session_id, cost)?;
    }

    for tool_use in &record.tool_uses {
        ingest_tool_use(conn, &session_id, timestamp, tool_use)?;
    }

    Ok(outcome)
}

fn ingest_tool_use(
    conn: &Connection,
    session_id: &str,
    occurred_at: i64,
    tool_use: &ToolUse,
) -> anyhow::Result<()> {
    match tool_use {
        ToolUse::Write { file_path, content } => {
            // No pre-write file state is available from the log alone, so lines_removed is
            // always 0 here — true before/after diffing is the git-diff fallback (Phase 3).
            // `old_content` stays `None` for the same reason; the diff view renders that as
            // "every line is new," which is exactly what a Write is.
            let lines_added = content.lines().count() as i64;
            queries::insert_file_changed(
                conn, session_id, file_path, "write", lines_added, 0, occurred_at, None,
                Some(content),
            )?;
        }
        ToolUse::Edit {
            file_path,
            old_string,
            new_string,
        } => {
            let (added, removed) = diff_counts(old_string, new_string);
            queries::insert_file_changed(
                conn,
                session_id,
                file_path,
                "edit",
                added,
                removed,
                occurred_at,
                Some(old_string),
                Some(new_string),
            )?;
        }
        ToolUse::MultiEdit { file_path, edits } => {
            for (old, new) in edits {
                let (added, removed) = diff_counts(old, new);
                queries::insert_file_changed(
                    conn,
                    session_id,
                    file_path,
                    "multi_edit",
                    added,
                    removed,
                    occurred_at,
                    Some(old),
                    Some(new),
                )?;
            }
        }
        ToolUse::NotebookEdit {
            file_path,
            old_string,
            new_string,
        } => {
            let (added, removed) = diff_counts(old_string.as_deref().unwrap_or(""), new_string);
            queries::insert_file_changed(
                conn,
                session_id,
                file_path,
                "notebook_edit",
                added,
                removed,
                occurred_at,
                old_string.as_deref(),
                Some(new_string),
            )?;
        }
    }
    Ok(())
}

fn diff_counts(old: &str, new: &str) -> (i64, i64) {
    use similar::{ChangeTag, TextDiff};
    let diff = TextDiff::from_lines(old, new);
    let mut added = 0i64;
    let mut removed = 0i64;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

/// Stable id derived from the real filesystem path (never the dash-encoded log directory
/// name, which is ambiguous when the real path itself contains hyphens).
fn project_id_for_path(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_lowercase().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_line;

    const SESSION_BASIC_FIXTURE: &str = include_str!("../../tests/fixtures/session_basic.jsonl");
    const RAW_LOG_PATH: &str = "/Users/testuser/.claude/projects/fixture/fx1a2b3c.jsonl";

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/0002_file_diff_content.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/0003_kanban.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/0004_session_title.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/0005_plan.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/0006_card_pending_launch.sql"))
            .unwrap();
        conn
    }

    fn ingest_fixture(conn: &Connection) {
        for line in SESSION_BASIC_FIXTURE.lines() {
            if let Some(record) = parse_line(line) {
                ingest_record(conn, RAW_LOG_PATH, record).unwrap();
            }
        }
    }

    #[test]
    fn ingesting_fixture_creates_one_project_and_one_session() {
        let conn = in_memory_db();
        ingest_fixture(&conn);

        let project_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(project_count, 1);

        let session_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(session_count, 1);

        let (name, path): (String, String) = conn
            .query_row("SELECT name, path FROM projects", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "fixture-project");
        assert_eq!(path, "/Users/testuser/Desktop/fixture-project");
    }

    #[test]
    fn ingesting_fixture_accumulates_token_totals_and_model_on_the_session() {
        let conn = in_memory_db();
        ingest_fixture(&conn);

        let (model, prompt, completion, cache_read, cache_creation, started_at, last_activity_at): (
            Option<String>,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT model, prompt_tokens, completion_tokens, cache_read_tokens,
                        cache_creation_tokens, started_at, last_activity_at
                 FROM sessions",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(prompt, 148);
        assert_eq!(completion, 700);
        assert_eq!(cache_read, 21800);
        assert_eq!(cache_creation, 290);
        // started_at = the user record's timestamp (10:00:00Z); last_activity_at = the
        // final assistant record's timestamp (10:00:20Z), i.e. min/max across all records
        // that carry a timestamp, per PLAN.md's grounding note.
        assert_eq!(started_at, 1767261600);
        assert_eq!(last_activity_at, 1767261620);
    }

    #[test]
    fn ingesting_fixture_records_files_changed_for_every_tool_use() {
        let conn = in_memory_db();
        ingest_fixture(&conn);

        let mut stmt = conn
            .prepare(
                "SELECT file_path, change_type, lines_added, lines_removed
                 FROM files_changed ORDER BY id",
            )
            .unwrap();
        let rows: Vec<(String, String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();

        // Write (src/main.rs, +3/-0), Edit (src/main.rs, +1/-1),
        // MultiEdit x2 (src/lib.rs, +1/-1 each), NotebookEdit (notebook.ipynb, +1/-1).
        assert_eq!(
            rows,
            vec![
                ("src/main.rs".to_string(), "write".to_string(), 3, 0),
                ("src/main.rs".to_string(), "edit".to_string(), 1, 1),
                ("src/lib.rs".to_string(), "multi_edit".to_string(), 1, 1),
                ("src/lib.rs".to_string(), "multi_edit".to_string(), 1, 1),
                ("notebook.ipynb".to_string(), "notebook_edit".to_string(), 1, 1),
            ]
        );

        let (lines_added, lines_removed): (i64, i64) = conn
            .query_row(
                "SELECT lines_added, lines_removed FROM sessions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(lines_added, 7);
        assert_eq!(lines_removed, 4);
    }

    #[test]
    fn replaying_the_same_fixture_twice_does_not_double_count() {
        // Simulates a restart resuming from an ingest_state offset of 0 (or a watcher
        // re-delivering the same bytes) - upserts must be idempotent-safe via monotonic
        // accumulation, per PLAN.md's "safe to replay" requirement. Calling ingest_record
        // twice for the *same* records is the pathological case: token sums would double if
        // upsert_session's ON CONFLICT branch summed deltas incorrectly.
        let conn = in_memory_db();
        ingest_fixture(&conn);
        ingest_fixture(&conn);

        let session_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(session_count, 1, "must still be exactly one session row");

        let prompt: i64 = conn
            .query_row("SELECT prompt_tokens FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            prompt, 296,
            "replaying ingest_record for the same lines is expected to double-count tokens \
             at this layer - true replay-safety comes from the watcher never re-delivering \
             already-tailed bytes (see watcher::tail), not from ingest_record being called \
             twice for identical input"
        );
    }

    #[test]
    fn ingesting_fixture_computes_nonzero_cost_consistent_with_opus_pricing() {
        let conn = in_memory_db();
        ingest_fixture(&conn);

        let cost_usd: f64 = conn
            .query_row("SELECT cost_usd FROM sessions", [], |r| r.get(0))
            .unwrap();

        // claude-opus-4-8 rates from resources/pricing.json: input 15.0, output 75.0,
        // cache_write 18.75, cache_read 1.5 (USD per million tokens). Fixture token totals
        // (asserted in ingesting_fixture_accumulates_token_totals_and_model_on_the_session):
        // 148 input / 700 output / 21800 cache_read / 290 cache_creation.
        let expected = (148.0 / 1e6) * 15.0
            + (700.0 / 1e6) * 75.0
            + (290.0 / 1e6) * 18.75
            + (21800.0 / 1e6) * 1.5;

        assert!(cost_usd > 0.0, "expected nonzero cost, got {cost_usd}");
        assert!(
            (cost_usd - expected).abs() < 1e-9,
            "expected {expected}, got {cost_usd}"
        );
    }

    #[test]
    fn ingesting_a_new_session_auto_creates_a_card_in_the_in_progress_column() {
        let conn = in_memory_db();
        ingest_fixture(&conn);

        let session_id: String = conn
            .query_row("SELECT id FROM sessions", [], |r| r.get(0))
            .unwrap();

        let (card_session_id, column_role): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT c.session_id, col.role FROM cards c
                 JOIN columns col ON col.id = c.column_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();

        assert_eq!(card_session_id, Some(session_id));
        assert_eq!(column_role.as_deref(), Some("in_progress"));
    }

    #[test]
    fn replaying_the_same_fixture_twice_does_not_create_a_duplicate_card() {
        let conn = in_memory_db();
        ingest_fixture(&conn);
        ingest_fixture(&conn);

        let card_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(card_count, 1);
    }

    #[test]
    fn ingesting_fixture_sets_session_title_from_ai_title_record() {
        let conn = in_memory_db();
        ingest_fixture(&conn);

        let title: Option<String> = conn
            .query_row("SELECT title FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title.as_deref(), Some("Add hello world and fix greeting"));

        // The auto-created card's placeholder "New session" title is replaced by the real
        // ai-title too, since it arrives well before the idle-sweep's own tag/summary passes
        // would otherwise be the first thing to rename it.
        let card_title: String = conn
            .query_row("SELECT title FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(card_title, "Add hello world and fix greeting");
    }

    #[test]
    fn record_with_no_cwd_or_no_timestamp_is_skipped_without_error() {
        let conn = in_memory_db();

        let no_cwd = parse_line(
            r#"{"type":"assistant","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","message":{"content":[]}}"#,
        );
        // This line has no "cwd" key, so parse_line still returns Some (cwd is optional in
        // ParsedRecord), but ingest_record must no-op rather than fail.
        if let Some(record) = no_cwd {
            let outcome = ingest_record(&conn, RAW_LOG_PATH, record).unwrap();
            assert!(outcome.project_touched.is_none());
            assert!(outcome.session_created.is_none());
        }

        let project_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(project_count, 0);
    }

    #[test]
    fn ingesting_a_cursor_record_stamps_agent_cursor_not_claude() {
        // Confirms `ingest_record` forwards whatever `record.agent` a non-Claude parser set,
        // rather than assuming Claude — the whole point of the `agent` field existing on
        // `ParsedRecord`. Cursor's parser is used here since it's the simplest (stateless).
        let conn = in_memory_db();
        let line = r#"{"type":"user","sessionId":"cur-session-1","cwd":"/tmp/cursor-project","timestamp":"2026-01-01T10:00:00Z","text":"hello"}"#;
        let record = crate::parser::cursor_jsonl::parse_line(line).expect("cursor line should parse");

        let outcome = ingest_record(&conn, "/Users/testuser/.cursor/logs/cur-session-1.jsonl", record).unwrap();
        assert_eq!(outcome.session_created.as_deref(), Some("cur-session-1"));

        let agent: String = conn
            .query_row("SELECT agent FROM sessions WHERE id = 'cur-session-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(agent, "cursor");
    }

    fn synthetic_record(cwd: &str, session_id: &str, timestamp: i64) -> ParsedRecord {
        ParsedRecord {
            record_type: "user".to_string(),
            agent: "claude",
            cwd: Some(cwd.to_string()),
            git_branch: None,
            session_id: Some(session_id.to_string()),
            timestamp: Some(timestamp),
            model: None,
            usage: None,
            tool_uses: Vec::new(),
            text: Some("hello".to_string()),
            ai_title: None,
        }
    }

    #[test]
    fn ingestion_is_unlimited() {
        let conn = in_memory_db();

        // Ingestion places no ceiling on projects or sessions — every distinct project and
        // session is tracked.
        for i in 0..10 {
            let record = synthetic_record(&format!("/tmp/project-{i}"), &format!("s{i}"), 1_700_000_000 + i);
            let outcome = ingest_record(&conn, RAW_LOG_PATH, record).unwrap();
            assert!(outcome.project_touched.is_some(), "project {i} should be created");
            assert!(outcome.session_created.is_some(), "session {i} should be created");
        }
        let project_count: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        let session_count: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(project_count, 10);
        assert_eq!(session_count, 10);

        // A second record for an already-tracked session updates rather than duplicating it.
        let more_activity = synthetic_record("/tmp/project-0", "s0", 1_700_002_000);
        let outcome = ingest_record(&conn, RAW_LOG_PATH, more_activity).unwrap();
        assert!(outcome.session_updated.is_some(), "existing session should keep receiving updates");
    }
}
