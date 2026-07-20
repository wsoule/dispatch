//! Defensive, best-effort parser for OpenAI Codex CLI's rollout log format
//! (`~/.codex/sessions/**/rollout-*.jsonl`).
//!
//! **Unlike `claude_jsonl.rs`, this has not been verified against real Codex CLI output** —
//! there was no captured log available while building this. The line shapes below (a
//! `session_meta` header carrying `id`/`cwd`, `response_item` turns wrapping OpenAI
//! Responses-API-style items, and `event_msg` telemetry like `token_count`) reflect the best
//! available public/training knowledge of Codex CLI's rollout format as of this writing, not a
//! ground-truth sample. Treat every field access as a guess: `Option`-based throughout, no
//! `.unwrap()`/`.expect()`, unrecognized shapes are skipped rather than treated as fatal. This
//! is expected to need adjustment once real rollout files can be inspected.
//!
//! A structural difference from Claude Code's format (the reason this module needs a
//! per-file cache, unlike the fully self-contained `claude_jsonl`): Codex's `cwd` and session
//! id are only expected to appear once, on the file's leading `session_meta` line, not
//! repeated on every subsequent line. Every other record in the same file only carries a
//! `timestamp`. So `parse_line` is keyed by `raw_log_path` and remembers the last-seen
//! `session_meta` for that specific file, applying it to later lines from the same file.

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

/// Parses a single complete JSONL line from a Codex CLI rollout file. `raw_log_path` is used
/// purely as a cache key to remember this file's `session_meta` across calls — never persisted
/// or otherwise interpreted.
pub fn parse_line(line: &str, raw_log_path: &str) -> Option<ParsedRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "skipping malformed Codex CLI rollout JSONL line ({} bytes): {e}",
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
    let payload = value.get("payload");

    match record_type.as_str() {
        "session_meta" => {
            let session_id = payload
                .and_then(|p| p.get("id"))
                .and_then(Value::as_str)
                .map(String::from);
            let cwd = payload
                .and_then(|p| p.get("cwd"))
                .and_then(Value::as_str)
                .map(String::from);

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
                agent: "codex",
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
        "response_item" => {
            let ctx = cached_context(raw_log_path);
            let item_type = payload.and_then(|p| p.get("type")).and_then(Value::as_str);

            let text = match item_type {
                Some("message") => extract_message_text(payload?),
                _ => None,
            };

            Some(ParsedRecord {
                record_type,
                agent: "codex",
                cwd: ctx.cwd,
                git_branch: None,
                session_id: ctx.session_id,
                timestamp,
                model: None,
                usage: None,
                tool_uses: Vec::new(),
                text,
                ai_title: None,
            })
        }
        "event_msg" => {
            let ctx = cached_context(raw_log_path);
            let event_type = payload.and_then(|p| p.get("type")).and_then(Value::as_str);

            let usage = if event_type == Some("token_count") {
                extract_token_usage(payload?)
            } else {
                None
            };

            Some(ParsedRecord {
                record_type,
                agent: "codex",
                cwd: ctx.cwd,
                git_branch: None,
                session_id: ctx.session_id,
                timestamp,
                model: None,
                usage,
                tool_uses: Vec::new(),
                text: None,
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

/// Best-effort extraction of a `response_item` message's text: OpenAI Responses-API-shaped
/// content blocks with `"type": "input_text"` (user) or `"output_text"` (assistant).
fn extract_message_text(payload: &Value) -> Option<String> {
    let items = payload.get("content").and_then(Value::as_array)?;
    let blocks: Vec<&str> = items
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("input_text") | Some("output_text")
            )
        })
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect();
    if blocks.is_empty() {
        None
    } else {
        Some(blocks.join("\n"))
    }
}

/// Best-effort field names for a `token_count` event's usage payload — unverified, guessed
/// from OpenAI's usual `input_tokens`/`output_tokens`/`cached_input_tokens` naming.
fn extract_token_usage(payload: &Value) -> Option<Usage> {
    let info = payload.get("info").unwrap_or(payload);
    let totals = info.get("total_token_usage").unwrap_or(info);

    Some(Usage {
        input_tokens: totals.get("input_tokens").and_then(Value::as_i64).unwrap_or(0),
        output_tokens: totals.get("output_tokens").and_then(Value::as_i64).unwrap_or(0),
        cache_read_input_tokens: totals
            .get("cached_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_creation_input_tokens: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test uses its own fake path, since `parse_line`'s per-file cache is keyed by
    // `raw_log_path` — tests run in parallel threads, so sharing one path across tests races
    // on that global cache (distinct real files never collide this way in production).

    #[test]
    fn session_meta_yields_cwd_and_session_id() {
        let path = "/Users/testuser/.codex/sessions/2026/01/01/rollout-fixture-a.jsonl";
        let line = r#"{"timestamp":"2026-01-01T10:00:00Z","type":"session_meta","payload":{"id":"cx-1234","cwd":"/Users/testuser/Desktop/fixture-project"}}"#;
        let record = parse_line(line, path).expect("session_meta should parse");
        assert_eq!(record.agent, "codex");
        assert_eq!(record.session_id.as_deref(), Some("cx-1234"));
        assert_eq!(record.cwd.as_deref(), Some("/Users/testuser/Desktop/fixture-project"));
    }

    #[test]
    fn response_item_after_session_meta_inherits_cached_cwd_and_session_id() {
        let path = "/Users/testuser/.codex/sessions/2026/01/01/rollout-fixture-b.jsonl";
        let meta = r#"{"timestamp":"2026-01-01T10:00:00Z","type":"session_meta","payload":{"id":"cx-5678","cwd":"/tmp/proj"}}"#;
        parse_line(meta, path).unwrap();

        let user_msg = r#"{"timestamp":"2026-01-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello codex"}]}}"#;
        let record = parse_line(user_msg, path).expect("response_item should parse");
        assert_eq!(record.session_id.as_deref(), Some("cx-5678"));
        assert_eq!(record.cwd.as_deref(), Some("/tmp/proj"));
        assert_eq!(record.text.as_deref(), Some("hello codex"));
    }

    #[test]
    fn token_count_event_extracts_usage() {
        let path = "/Users/testuser/.codex/sessions/2026/01/01/rollout-fixture-c.jsonl";
        let meta = r#"{"timestamp":"2026-01-01T10:00:00Z","type":"session_meta","payload":{"id":"cx-9","cwd":"/tmp/proj2"}}"#;
        parse_line(meta, path).unwrap();

        let event = r#"{"timestamp":"2026-01-01T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":50,"cached_input_tokens":10}}}}"#;
        let record = parse_line(event, path).expect("event_msg should parse");
        let usage = record.usage.expect("token_count event should carry usage");
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.cache_read_input_tokens, 10);
    }

    #[test]
    fn unknown_top_level_type_is_skipped_not_fatal() {
        let path = "/Users/testuser/.codex/sessions/2026/01/01/rollout-fixture-d.jsonl";
        assert!(parse_line(
            r#"{"timestamp":"2026-01-01T00:00:00Z","type":"some-future-codex-record"}"#,
            path
        )
        .is_none());
    }

    #[test]
    fn malformed_json_line_is_skipped_without_panicking() {
        let path = "/Users/testuser/.codex/sessions/2026/01/01/rollout-fixture-e.jsonl";
        assert!(parse_line("not json at all", path).is_none());
        assert!(parse_line("", path).is_none());
    }
}
