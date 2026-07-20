//! Defensive, best-effort parser for Cursor Agent CLI's local session logs
//! (`~/.cursor/**/*.jsonl`).
//!
//! **Not verified against real Cursor Agent CLI output.** The PRD's agent-log survey calls
//! this format "partial JSONL" — self-contained per-line like Claude Code's (each line repeats
//! its own `sessionId`/`cwd`/`timestamp`, so no cross-line file-context cache is needed here,
//! unlike `codex_jsonl.rs`/`gemini_log.rs`), but missing token-usage data: Cursor's CLI doesn't
//! appear to expose raw prompt/completion token counts locally, so `usage` is always `None`
//! here and sessions ingested from this parser will show `$0.00` cost until/unless a real
//! sample proves otherwise. Every field access is `Option`-based; unrecognized shapes are
//! skipped, never fatal.

use super::record::ParsedRecord;
use serde_json::Value;

/// Parses a single complete JSONL line from a Cursor Agent CLI session log.
pub fn parse_line(line: &str) -> Option<ParsedRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "skipping malformed Cursor Agent CLI JSONL line ({} bytes): {e}",
                trimmed.len()
            );
            return None;
        }
    };

    let record_type = value.get("type").and_then(Value::as_str)?.to_string();
    match record_type.as_str() {
        "user" | "assistant" => {}
        _ => return None,
    }

    let cwd = value.get("cwd").and_then(Value::as_str).map(String::from);
    let session_id = value.get("sessionId").and_then(Value::as_str).map(String::from);
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp());
    let model = if record_type == "assistant" {
        value.get("model").and_then(Value::as_str).map(String::from)
    } else {
        None
    };
    let text = value.get("text").and_then(Value::as_str).map(String::from);

    Some(ParsedRecord {
        record_type,
        agent: "cursor",
        cwd,
        git_branch: None,
        session_id,
        timestamp,
        model,
        usage: None,
        tool_uses: Vec::new(),
        text,
        ai_title: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_line_extracts_cwd_session_id_and_text() {
        let line = r#"{"type":"user","sessionId":"cur-1","cwd":"/Users/testuser/Desktop/fixture-project","timestamp":"2026-01-01T10:00:00Z","text":"fix this bug"}"#;
        let record = parse_line(line).expect("user line should parse");
        assert_eq!(record.agent, "cursor");
        assert_eq!(record.session_id.as_deref(), Some("cur-1"));
        assert_eq!(record.cwd.as_deref(), Some("/Users/testuser/Desktop/fixture-project"));
        assert_eq!(record.text.as_deref(), Some("fix this bug"));
        assert!(record.usage.is_none(), "Cursor logs carry no token usage");
    }

    #[test]
    fn assistant_line_extracts_model() {
        let line = r#"{"type":"assistant","sessionId":"cur-1","cwd":"/tmp/proj","timestamp":"2026-01-01T10:00:01Z","model":"cursor-composer-1","text":"done"}"#;
        let record = parse_line(line).expect("assistant line should parse");
        assert_eq!(record.model.as_deref(), Some("cursor-composer-1"));
        assert!(record.usage.is_none());
    }

    #[test]
    fn unknown_record_type_is_skipped_not_fatal() {
        assert!(parse_line(
            r#"{"type":"some-future-cursor-record","sessionId":"s","timestamp":"2026-01-01T00:00:00Z"}"#
        )
        .is_none());
    }

    #[test]
    fn malformed_json_line_is_skipped_without_panicking() {
        assert!(parse_line("not json at all").is_none());
        assert!(parse_line("").is_none());
    }
}
