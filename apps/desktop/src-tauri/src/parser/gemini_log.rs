//! Defensive, best-effort parser for Gemini CLI's local session logs (`~/.gemini/tmp/**`).
//!
//! **Not verified against real Gemini CLI output.** The PRD's own agent-log survey calls
//! Gemini CLI's format "custom JSON" rather than JSONL — this parser simplifies that to
//! line-delimited JSON (one record per line) so it can reuse the same byte-offset file tailer
//! as every other agent, rather than inventing a separate whole-file-diffing mechanism for a
//! format that hasn't been directly inspected. If real Gemini CLI logs turn out to be a single
//! rewritten JSON document per session instead, this module (and its watcher wiring) will need
//! to change to a different replay strategy.
//!
//! Field names for token usage (`promptTokenCount`/`candidatesTokenCount`/
//! `cachedContentTokenCount`) are the real `UsageMetadata` field names from the Gemini API
//! response shape, so those are on firmer ground than the surrounding log-envelope shape
//! (`session_start` header, per-turn `user`/`model` records), which is a best guess. As with
//! `codex_jsonl.rs`, `cwd`/session id are assumed to appear once on a leading `session_start`
//! line and are cached per `raw_log_path` for later lines in the same file.

use super::record::{ParsedRecord, Usage};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Default)]
struct FileContext {
    session_id: Option<String>,
    cwd: Option<String>,
}

fn context_cache() -> &'static Mutex<HashMap<String, FileContext>> {
    static CACHE: OnceLock<Mutex<HashMap<String, FileContext>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Parses a single complete line from a Gemini CLI session log. `raw_log_path` is used purely
/// as a cache key to remember this file's `session_start` header across calls.
pub fn parse_line(line: &str, raw_log_path: &str) -> Option<ParsedRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "skipping malformed Gemini CLI log line ({} bytes): {e}",
                trimmed.len()
            );
            return None;
        }
    };

    let record_type = value.get("type").and_then(Value::as_str)?.to_string();
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp());

    match record_type.as_str() {
        "session_start" => {
            let session_id = value.get("sessionId").and_then(Value::as_str).map(String::from);
            let cwd = value.get("cwd").and_then(Value::as_str).map(String::from);

            let mut cache = context_cache().lock().unwrap();
            cache.insert(
                raw_log_path.to_string(),
                FileContext {
                    session_id: session_id.clone(),
                    cwd: cwd.clone(),
                },
            );
            drop(cache);

            Some(ParsedRecord {
                record_type,
                agent: "gemini",
                cwd,
                git_branch: None,
                session_id,
                timestamp,
                model: None,
                usage: None,
                tool_uses: Vec::new(),
                text: None,
                ai_title: None,
            })
        }
        "user" | "model" => {
            let ctx = cached_context(raw_log_path);
            let text = value.get("text").and_then(Value::as_str).map(String::from);
            let model = if record_type == "model" {
                value.get("model").and_then(Value::as_str).map(String::from)
            } else {
                None
            };
            let usage = value.get("usageMetadata").map(extract_usage_metadata);

            Some(ParsedRecord {
                record_type,
                agent: "gemini",
                cwd: ctx.cwd,
                git_branch: None,
                session_id: ctx.session_id,
                timestamp,
                model,
                usage,
                tool_uses: Vec::new(),
                text,
                ai_title: None,
            })
        }
        _ => None,
    }
}

fn cached_context(raw_log_path: &str) -> FileContext {
    context_cache()
        .lock()
        .unwrap()
        .get(raw_log_path)
        .cloned()
        .unwrap_or_default()
}

/// Maps the Gemini API's real `UsageMetadata` field names onto the shared `Usage` shape.
/// `cachedContentTokenCount` is the closest analog to `cache_read_input_tokens`; Gemini's API
/// has no separate cache-write count, so `cache_creation_input_tokens` is always 0 here.
fn extract_usage_metadata(usage: &Value) -> Usage {
    Usage {
        input_tokens: usage.get("promptTokenCount").and_then(Value::as_i64).unwrap_or(0),
        output_tokens: usage.get("candidatesTokenCount").and_then(Value::as_i64).unwrap_or(0),
        cache_read_input_tokens: usage
            .get("cachedContentTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_creation_input_tokens: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test uses its own fake path, since `parse_line`'s per-file cache is keyed by
    // `raw_log_path` — tests run in parallel threads, so sharing one path across tests races
    // on that global cache (distinct real files never collide this way in production).

    #[test]
    fn session_start_yields_cwd_and_session_id() {
        let path = "/Users/testuser/.gemini/tmp/fixturehash/logs-a.jsonl";
        let line = r#"{"type":"session_start","timestamp":"2026-01-01T10:00:00Z","sessionId":"gm-1","cwd":"/Users/testuser/Desktop/fixture-project"}"#;
        let record = parse_line(line, path).expect("session_start should parse");
        assert_eq!(record.agent, "gemini");
        assert_eq!(record.session_id.as_deref(), Some("gm-1"));
        assert_eq!(record.cwd.as_deref(), Some("/Users/testuser/Desktop/fixture-project"));
    }

    #[test]
    fn model_turn_after_session_start_inherits_cached_context_and_extracts_usage() {
        let path = "/Users/testuser/.gemini/tmp/fixturehash/logs-b.jsonl";
        let start = r#"{"type":"session_start","timestamp":"2026-01-01T10:00:00Z","sessionId":"gm-2","cwd":"/tmp/proj"}"#;
        parse_line(start, path).unwrap();

        let model_turn = r#"{"type":"model","timestamp":"2026-01-01T10:00:01Z","model":"gemini-3-pro","text":"hi from gemini","usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":20,"cachedContentTokenCount":5}}"#;
        let record = parse_line(model_turn, path).expect("model turn should parse");
        assert_eq!(record.session_id.as_deref(), Some("gm-2"));
        assert_eq!(record.cwd.as_deref(), Some("/tmp/proj"));
        assert_eq!(record.model.as_deref(), Some("gemini-3-pro"));
        assert_eq!(record.text.as_deref(), Some("hi from gemini"));
        let usage = record.usage.expect("model turn should carry usage");
        assert_eq!(usage.input_tokens, 40);
        assert_eq!(usage.output_tokens, 20);
        assert_eq!(usage.cache_read_input_tokens, 5);
    }

    #[test]
    fn user_turn_has_no_model_but_still_inherits_context() {
        let path = "/Users/testuser/.gemini/tmp/fixturehash/logs-c.jsonl";
        let start = r#"{"type":"session_start","timestamp":"2026-01-01T10:00:00Z","sessionId":"gm-3","cwd":"/tmp/proj3"}"#;
        parse_line(start, path).unwrap();

        let user_turn = r#"{"type":"user","timestamp":"2026-01-01T10:00:01Z","text":"hello"}"#;
        let record = parse_line(user_turn, path).expect("user turn should parse");
        assert_eq!(record.model, None);
        assert_eq!(record.text.as_deref(), Some("hello"));
        assert_eq!(record.session_id.as_deref(), Some("gm-3"));
    }

    #[test]
    fn unknown_top_level_type_is_skipped_not_fatal() {
        let path = "/Users/testuser/.gemini/tmp/fixturehash/logs-d.jsonl";
        assert!(parse_line(
            r#"{"type":"some-future-gemini-record","timestamp":"2026-01-01T00:00:00Z"}"#,
            path
        )
        .is_none());
    }

    #[test]
    fn malformed_json_line_is_skipped_without_panicking() {
        let path = "/Users/testuser/.gemini/tmp/fixturehash/logs-e.jsonl";
        assert!(parse_line("not json at all", path).is_none());
        assert!(parse_line("", path).is_none());
    }
}
