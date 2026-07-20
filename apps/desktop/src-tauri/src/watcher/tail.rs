use crate::db::queries;
use rusqlite::Connection;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Reads any bytes appended to `path` since the last recorded offset, returning complete
/// lines only. A trailing incomplete line (the watcher fired mid-flush, a real possibility
/// since Claude Code appends while we're reading) is buffered back into `ingest_state` for
/// next time rather than parsed prematurely. Offset/partial-line bookkeeping is updated in
/// the same call so a crash between reading and processing can't silently skip bytes.
pub fn read_new_lines(conn: &Connection, path: &Path) -> anyhow::Result<Vec<String>> {
    let path_str = path.to_string_lossy().to_string();
    let state = queries::get_ingest_state(conn, &path_str)?;

    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();

    // If the file is shorter than our recorded offset (shouldn't happen for Claude Code's
    // append-only logs, but never trust external state), restart from 0 rather than seek
    // past EOF and silently miss everything that follows.
    let start_offset = if (state.byte_offset as u64) > file_len {
        0
    } else {
        state.byte_offset as u64
    };

    file.seek(SeekFrom::Start(start_offset))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;

    let new_text = String::from_utf8_lossy(&buf);
    let combined = format!("{}{}", state.partial_line, new_text);

    let mut lines: Vec<String> = combined.split('\n').map(String::from).collect();
    // Last element is "" if `combined` ended in `\n`, or an incomplete trailing line
    // otherwise — either way it must not be parsed yet.
    let trailing_partial = lines.pop().unwrap_or_default();

    let new_offset = start_offset + buf.len() as u64;
    let mtime = file
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    queries::set_ingest_state(conn, &path_str, new_offset as i64, &trailing_partial, mtime)?;

    Ok(lines.into_iter().filter(|l| !l.trim().is_empty()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Cleans up its file on drop so a failing assertion can't leak a stray temp file.
    struct TempFile(std::path::PathBuf);

    impl TempFile {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "relay-tail-test-{}-{name}.jsonl",
                std::process::id()
            ));
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, contents: &str) {
            std::fs::write(&self.0, contents).unwrap();
        }

        fn append(&self, contents: &str) {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&self.0)
                .unwrap();
            f.write_all(contents.as_bytes()).unwrap();
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql"))
            .unwrap();
        conn
    }

    const MALFORMED_FIXTURE: &str = include_str!("../../tests/fixtures/malformed_line.jsonl");

    #[test]
    fn returns_all_complete_lines_including_malformed_ones_and_advances_offset_to_eof() {
        // tail.rs's job is byte-accurate line splitting, not JSON validity - a malformed but
        // newline-terminated line is a "complete line" at this layer (parser::parse_line is
        // what rejects it later). This mirrors PLAN.md verification item: "truncated mid-JSON
        // line is skipped [by the parser], rest of file still processes, byte_offset still
        // advances past it" - the byte_offset half of that guarantee lives here.
        let file = TempFile::new("malformed");
        file.write(MALFORMED_FIXTURE);
        let conn = in_memory_db();

        let lines = read_new_lines(&conn, file.path()).unwrap();
        assert_eq!(lines.len(), 3, "all 3 newline-terminated lines returned, malformed one included");

        let expected_offset = MALFORMED_FIXTURE.len() as i64;
        let state = queries::get_ingest_state(&conn, &file.path().to_string_lossy()).unwrap();
        assert_eq!(state.byte_offset, expected_offset);
        assert_eq!(state.partial_line, "");
    }

    #[test]
    fn trailing_incomplete_line_is_buffered_not_returned() {
        let file = TempFile::new("partial");
        // No trailing newline - simulates the watcher firing mid-write.
        file.write(r#"{"type":"user","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp","message":{"role":"user","content":"a"}}
{"type":"user","sessionId":"s","timestamp":"2026-01-01T00:00:01Z","cwd":"/tmp","message":{"role":"user","conte"#);
        let conn = in_memory_db();

        let lines = read_new_lines(&conn, file.path()).unwrap();
        assert_eq!(lines.len(), 1, "only the first, complete line is returned");

        let state = queries::get_ingest_state(&conn, &file.path().to_string_lossy()).unwrap();
        assert!(
            state.partial_line.starts_with(r#"{"type":"user","sessionId":"s","timestamp":"2026-01-01T00:00:01Z"#),
            "incomplete trailing line must be buffered as partial_line, got: {}",
            state.partial_line
        );

        // Claude Code finishes the flush: the rest of the line plus its newline arrive.
        file.append(r#"nt":"b"}}"#);
        file.append("\n");

        let lines = read_new_lines(&conn, file.path()).unwrap();
        assert_eq!(lines.len(), 1, "the now-completed line is returned on the next tail");
        assert!(lines[0].contains(r#""content":"b"}}"#));

        let state = queries::get_ingest_state(&conn, &file.path().to_string_lossy()).unwrap();
        assert_eq!(state.partial_line, "");
    }

    #[test]
    fn resumes_from_stored_byte_offset_instead_of_reprocessing_from_scratch() {
        // Simulates an app restart mid-session: read once, then simulate a fresh process by
        // calling read_new_lines again against the *same* ingest_state row without the file
        // changing - it must return nothing new, not re-deliver already-tailed lines.
        let file = TempFile::new("resume");
        file.write("line one is not valid json but is newline-terminated\n");
        let conn = in_memory_db();

        let first = read_new_lines(&conn, file.path()).unwrap();
        assert_eq!(first.len(), 1);

        let second = read_new_lines(&conn, file.path()).unwrap();
        assert!(second.is_empty(), "no new bytes since last tail - nothing should be re-delivered");

        // Now Claude Code appends more while we were "away".
        file.append("line two also newline-terminated\n");
        let third = read_new_lines(&conn, file.path()).unwrap();
        assert_eq!(third.len(), 1);
        assert!(third[0].contains("line two"));
    }
}
