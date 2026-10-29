use super::*;
use crate::parser::{FileContext, ParsedRecord};
use rusqlite::Connection;
use std::io::Write;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.agents/ignore/history-ingestion-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        // Match filesystem event paths rather than retaining parent-directory components.
        Self(dir.canonicalize().unwrap())
    }
    fn path(&self) -> PathBuf {
        self.0.join("history.jsonl")
    }
    fn db(&self) -> Connection {
        crate::db::open(&self.0.join("history.db")).unwrap()
    }
    fn append(&self, bytes: &[u8]) {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path())
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn claude(line: &str, _: &mut FileContext) -> Option<ParsedRecord> {
    parser::parse_line(line)
}
fn drain(conn: &Connection, path: &Path, parse: tail::ParseLine) -> usize {
    let mut reader = tail::Reader::open(path).unwrap();
    let mut cursor = tail::cursor(conn, path).unwrap();
    if reader.recover_context(&mut cursor, parse).unwrap() {
        tail::persist_context(conn, path, &cursor).unwrap();
    }
    let mut count = 0;
    while let Some(mut segment) = reader.read_segment(cursor).unwrap() {
        apply_segment(conn, path, parse, &mut segment).unwrap();
        cursor = segment.cursor;
        count += 1;
    }
    count
}
fn snapshot(conn: &Connection, table: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
        .unwrap();
    let columns = stmt.column_count();
    stmt.query_map([], |r| (0..columns).map(|i| r.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
const BASIC: &str = include_str!("../../tests/fixtures/session_basic.jsonl");

#[test]
fn ordered_segment_matches_single_record_persistence_for_all_columns() {
    let fx = Fixture::new();
    // Multiple sessions/projects, out-of-order timestamps, model/title updates and tools.
    let input = format!(
        "{BASIC}{BASIC}\n{}\n{}\n{}\n",
        r#"{"type":"ai-title","sessionId":"fx1a2b3c-1111-2222-3333-444455556666","aiTitle":"latest"}"#,
        r#"{"type":"assistant","sessionId":"other","cwd":"/other","timestamp":"2025-01-01T00:00:00Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":11,"output_tokens":3},"content":[]}}"#,
        r#"{"type":"assistant","sessionId":"other","cwd":"/moved","timestamp":"2024-01-01T00:00:00Z","message":{"model":"claude-opus-4-6","usage":{"input_tokens":9,"output_tokens":2},"content":[]}}"#
    );
    fx.append(input.as_bytes());
    let old = Connection::open_in_memory().unwrap();
    for migration in [
        include_str!("../../migrations/0001_init.sql"),
        include_str!("../../migrations/0002_file_diff_content.sql"),
        include_str!("../../migrations/0004_session_title.sql"),
    ] {
        old.execute_batch(migration).unwrap();
    }
    for line in input.lines() {
        if let Some(record) = parser::parse_line(line) {
            parser::ingest_record(&old, &fx.path().to_string_lossy(), record).unwrap();
        }
    }
    let new = fx.db();
    drain(&new, &fx.path(), claude);
    for table in ["projects", "sessions", "files_changed"] {
        assert_eq!(snapshot(&old, table), snapshot(&new, table), "{table}");
    }
    assert_eq!(
        tail::cursor(&new, &fx.path()).unwrap().offset,
        input.len() as u64
    );
    assert_eq!(drain(&new, &fx.path(), claude), 0);
}

#[test]
fn rollback_during_records_and_at_checkpoint_keeps_whole_prefix_retryable() {
    for fail_checkpoint in [false, true] {
        let fx = Fixture::new();
        fx.append(BASIC.as_bytes());
        let conn = fx.db();
        let trigger = if fail_checkpoint {
            "CREATE TRIGGER fail BEFORE INSERT ON ingest_state BEGIN SELECT RAISE(ABORT, 'checkpoint'); END;"
        } else {
            "CREATE TRIGGER fail BEFORE INSERT ON files_changed BEGIN SELECT RAISE(ABORT, 'record'); END;"
        };
        conn.execute_batch(trigger).unwrap();
        let mut segment = tail::read_segment(&fx.path(), tail::cursor(&conn, &fx.path()).unwrap())
            .unwrap()
            .unwrap();
        assert!(apply_segment(&conn, &fx.path(), claude, &mut segment).is_err());
        for table in ["projects", "sessions", "files_changed", "ingest_state"] {
            assert!(snapshot(&conn, table).is_empty(), "{table}");
        }
        conn.execute_batch("DROP TRIGGER fail").unwrap();
        drop(conn); // Reopen after rollback, rather than retrying mutated parser state.
        let conn = fx.db();
        drain(&conn, &fx.path(), claude);
        let state = snapshot(&conn, "sessions");
        drop(conn); // Simulates process loss immediately after the successful commit.
        let conn = fx.db();
        assert_eq!(drain(&conn, &fx.path(), claude), 0);
        assert_eq!(state, snapshot(&conn, "sessions"));
    }
}

#[test]
fn codex_and_gemini_restore_context_after_restart_and_legacy_upgrade() {
    for (parse, header, event) in [
        (
            parser::codex_jsonl::parse_with_context as tail::ParseLine,
            r#"{"type":"session_meta","timestamp":"2026-01-01T00:00:00Z","payload":{"id":"s","cwd":"/context"}}"#,
            r#"{"type":"event_msg","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":20}}}}"#,
        ),
        (
            parser::gemini_log::parse_with_context as tail::ParseLine,
            r#"{"type":"session_start","timestamp":"2026-01-01T00:00:00Z","sessionId":"s","cwd":"/context"}"#,
            r#"{"type":"model","timestamp":"2026-01-01T00:00:01Z","model":"gemini-2.5-pro","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20}}"#,
        ),
    ] {
        let fx = Fixture::new();
        fx.append(format!("{header}\n{event}\n").as_bytes());
        let conn = fx.db();
        drain(&conn, &fx.path(), parse);
        drop(conn);
        fx.append(format!("{event}\n").as_bytes());
        let conn = fx.db();
        drain(&conn, &fx.path(), parse);
        let prompt: i64 = conn
            .query_row("SELECT prompt_tokens FROM sessions WHERE id='s'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            prompt,
            if header.contains("session_meta") {
                100
            } else {
                200
            }
        );
        conn.execute(
            "UPDATE ingest_state SET parser_context = NULL, partial_bytes = NULL",
            [],
        )
        .unwrap();
        drop(conn);
        fx.append(format!("{event}\n").as_bytes());
        let conn = fx.db();
        drain(&conn, &fx.path(), parse);
        let prompt: i64 = conn
            .query_row("SELECT prompt_tokens FROM sessions WHERE id='s'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            prompt,
            if header.contains("session_meta") {
                100
            } else {
                300
            }
        );
    }
}

#[test]
fn partial_utf8_survives_restart_and_appends_between_segments_are_not_duplicated() {
    let fx = Fixture::new();
    let line = r#"{"type":"ai-title","sessionId":"fx1a2b3c-1111-2222-3333-444455556666","aiTitle":"café"}"#;
    fx.append(BASIC.as_bytes());
    let split = line.find('é').unwrap() + 1; // Split inside a UTF-8 scalar.
    fx.append(&line.as_bytes()[..split]);
    let conn = fx.db();
    drain(&conn, &fx.path(), claude);
    drop(conn);
    fx.append(&line.as_bytes()[split..]);
    fx.append(b"\n");
    let conn = fx.db();
    drain(&conn, &fx.path(), claude);
    let title: String = conn
        .query_row("SELECT title FROM sessions LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "café");
    let initial_tokens: i64 = conn
        .query_row("SELECT prompt_tokens FROM sessions LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(tail::cursor(&conn, &fx.path()).unwrap().partial.is_empty());
    // Force multiple chunks and commit just one before an append/restart.
    fx.append("\n".repeat(tail::SEGMENT_BYTES as usize + 1).as_bytes());
    let mut segment = tail::read_segment(&fx.path(), tail::cursor(&conn, &fx.path()).unwrap())
        .unwrap()
        .unwrap();
    apply_segment(&conn, &fx.path(), claude, &mut segment).unwrap();
    drop(conn);
    fx.append(BASIC.as_bytes());
    let conn = fx.db();
    drain(&conn, &fx.path(), claude);
    assert_eq!(drain(&conn, &fx.path(), claude), 0);
    let tokens: i64 = conn
        .query_row("SELECT prompt_tokens FROM sessions LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(tokens, 2 * initial_tokens);
}

#[test]
fn shrink_discards_old_partial_and_replacement_detection_matches_existing_limitation() {
    let fx = Fixture::new();
    fx.append(b"old partial longer than replacement");
    let conn = fx.db();
    drain(&conn, &fx.path(), claude);
    std::fs::write(fx.path(), b"new\n").unwrap();
    drain(&conn, &fx.path(), claude);
    let cursor = tail::cursor(&conn, &fx.path()).unwrap();
    assert_eq!(cursor.offset, 4);
    assert!(cursor.partial.is_empty());
    std::fs::write(fx.path(), b"swap").unwrap();
    assert_eq!(
        drain(&conn, &fx.path(), claude),
        0,
        "same-size replacement remains undetected, as upstream"
    );
}

#[test]
fn watcher_registered_before_scan_queues_appends_for_the_same_cursor_owner() {
    let fx = Fixture::new();
    let root = fx.0.join("not-yet").join("sessions");
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = new_debouncer(Duration::from_millis(DEBOUNCE_MS), tx).unwrap();
    register_watches(&mut watcher, &[(root.clone(), &AGENT_SOURCES[0])]).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("history.jsonl");
    std::fs::write(&path, BASIC).unwrap();
    let conn = fx.db();
    drain(&conn, &path, claude); // Initial scan finishes before the live event is consumed.
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(BASIC.as_bytes())
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut observed_paths = Vec::new();
    loop {
        let events = rx
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .unwrap_or_else(|error| {
                panic!("waiting for {path:?}: {error}; observed paths: {observed_paths:?}")
            })
            .unwrap();
        observed_paths.extend(events.iter().map(|event| event.path.clone()));
        if events.iter().any(|event| event.path == path) {
            break;
        }
    }
    drain(&conn, &path, claude); // Queued catch-up and append events use the persisted cursor.
    assert_eq!(drain(&conn, &path, claude), 0);
    let expected = Connection::open_in_memory().unwrap();
    for migration in [
        include_str!("../../migrations/0001_init.sql"),
        include_str!("../../migrations/0002_file_diff_content.sql"),
        include_str!("../../migrations/0004_session_title.sql"),
    ] {
        expected.execute_batch(migration).unwrap();
    }
    for line in format!("{BASIC}{BASIC}").lines() {
        if let Some(record) = parser::parse_line(line) {
            parser::ingest_record(&expected, &path.to_string_lossy(), record).unwrap();
        }
    }
    for table in ["projects", "sessions", "files_changed"] {
        assert_eq!(snapshot(&conn, table), snapshot(&expected, table));
    }
}

#[test]
fn failed_context_update_and_multiple_headers_do_not_leak_parser_state() {
    let fx = Fixture::new();
    let parse = parser::codex_jsonl::parse_with_context;
    let input = concat!(
        "{\"type\":\"session_meta\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"payload\":{\"id\":\"one\",\"cwd\":\"/first\"}}\n",
        "{\"type\":\"event_msg\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":10}}}}\n",
        "{\"type\":\"session_meta\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"payload\":{\"id\":\"two\",\"cwd\":\"/second\"}}\n"
    );
    fx.append(input.as_bytes());
    let conn = fx.db();
    conn.execute_batch("CREATE TRIGGER fail BEFORE UPDATE ON ingest_state BEGIN SELECT RAISE(ABORT, 'context'); END;").unwrap();
    let mut segment = tail::read_segment(&fx.path(), tail::cursor(&conn, &fx.path()).unwrap())
        .unwrap()
        .unwrap();
    assert!(apply_segment(&conn, &fx.path(), parse, &mut segment).is_err());
    assert!(snapshot(&conn, "sessions").is_empty());
    assert_eq!(tail::cursor(&conn, &fx.path()).unwrap().offset, 0);
    conn.execute_batch("DROP TRIGGER fail").unwrap();
    drain(&conn, &fx.path(), parse);
    drop(conn);
    fx.append(b"{\"type\":\"event_msg\",\"timestamp\":\"2026-01-01T00:00:03Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":20}}}}\n");
    let conn = fx.db();
    drain(&conn, &fx.path(), parse);
    let totals: Vec<(String, i64)> = conn
        .prepare("SELECT id,prompt_tokens FROM sessions ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        totals,
        vec![("one".to_string(), 10), ("two".to_string(), 20)]
    );
}

#[test]
fn one_open_reader_preserves_generation_and_defers_appends_to_the_next_owner_turn() {
    let fx = Fixture::new();
    let original = format!(
        "{BASIC}{}{BASIC}",
        "\n".repeat(tail::SEGMENT_BYTES as usize)
    );
    fx.append(original.as_bytes());
    let conn = fx.db();
    let mut reader = tail::Reader::open(&fx.path()).unwrap();
    let cursor = tail::cursor(&conn, &fx.path()).unwrap();
    let mut first = reader.read_segment(cursor).unwrap().unwrap();
    apply_segment(&conn, &fx.path(), claude, &mut first).unwrap();
    fx.append(BASIC.as_bytes());
    let mut cursor = first.cursor;
    while let Some(mut segment) = reader.read_segment(cursor).unwrap() {
        apply_segment(&conn, &fx.path(), claude, &mut segment).unwrap();
        cursor = segment.cursor;
    }
    assert_eq!(
        tail::cursor(&conn, &fx.path()).unwrap().offset,
        original.len() as u64
    );
    let before: i64 = conn
        .query_row("SELECT prompt_tokens FROM sessions LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    drain(&conn, &fx.path(), claude);
    let after: i64 = conn
        .query_row("SELECT prompt_tokens FROM sessions LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(3 * before, 2 * after);
    assert_eq!(drain(&conn, &fx.path(), claude), 0);
    drop(reader);

    // A path replacement between chunks must not switch the still-open catch-up reader.
    let fx = Fixture::new();
    let original = "old\n".repeat(tail::SEGMENT_BYTES as usize);
    fx.append(original.as_bytes());
    let conn = fx.db();
    let mut reader = tail::Reader::open(&fx.path()).unwrap();
    let first = reader
        .read_segment(tail::cursor(&conn, &fx.path()).unwrap())
        .unwrap()
        .unwrap();
    std::fs::rename(fx.path(), fx.0.join("old.jsonl")).unwrap();
    std::fs::write(fx.path(), "new\n".repeat(tail::SEGMENT_BYTES as usize)).unwrap();
    let second = reader.read_segment(first.cursor).unwrap().unwrap();
    assert!(second.lines.iter().all(|line| line == "old"));
}
