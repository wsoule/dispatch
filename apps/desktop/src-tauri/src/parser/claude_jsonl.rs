//! Defensive, best-effort parser for Claude Code's `~/.claude/projects/**/*.jsonl` format.
//!
//! This format is undocumented and explicitly marked internal by Anthropic — it may change
//! between Claude Code versions. Every field access here is `Option`-based on purpose: no
//! `.unwrap()`/`.expect()` on anything derived from a log line. An unrecognized `type` or a
//! malformed line is skipped and logged, never treated as fatal. Verified against real log
//! files on this machine (not just illustrative examples) as of Claude Code ~2.1.x.

use super::record::{ParsedRecord, ToolUse, Usage};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Record types seen in real logs that carry no session content — safe to ignore.
const INERT_TYPES: &[&str] = &[
    "last-prompt",
    "mode",
    "permission-mode",
    "attachment",
    "file-history-snapshot",
    "queue-operation",
];

/// Parses a single complete JSONL line. Returns `None` for malformed JSON, records with no
/// `type` field, or record types that carry nothing worth persisting — never errors out, since
/// one bad/unknown line must never stop the rest of the file from being processed.
pub fn parse_line(line: &str) -> Option<ParsedRecord> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "skipping malformed Claude Code JSONL line ({} bytes): {e}",
                trimmed.len()
            );
            return None;
        }
    };

    let record_type = value.get("type").and_then(Value::as_str)?.to_string();

    match record_type.as_str() {
        "user" | "assistant" | "system" | "ai-title" => {}
        t if INERT_TYPES.contains(&t) => return None,
        other => {
            log_unknown_type_once(other);
            return None;
        }
    }

    let cwd = value
        .get("cwd")
        .and_then(Value::as_str)
        .map(String::from);
    let git_branch = value
        .get("gitBranch")
        .and_then(Value::as_str)
        .map(String::from);
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(String::from);
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp());

    let message = value.get("message");
    let model = message
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
        .map(String::from);

    let usage = message.and_then(|m| m.get("usage")).map(|u| Usage {
        input_tokens: u.get("input_tokens").and_then(Value::as_i64).unwrap_or(0),
        output_tokens: u.get("output_tokens").and_then(Value::as_i64).unwrap_or(0),
        cache_read_input_tokens: u
            .get("cache_read_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_creation_input_tokens: u
            .get("cache_creation_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    });

    let content = message.and_then(|m| m.get("content"));

    let tool_uses = content
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(extract_tool_use).collect())
        .unwrap_or_default();

    let text = extract_text(&record_type, content);
    let ai_title = if record_type == "ai-title" {
        value.get("aiTitle").and_then(Value::as_str).map(String::from)
    } else {
        None
    };

    Some(ParsedRecord {
        record_type,
        agent: "claude",
        cwd,
        git_branch,
        session_id,
        timestamp,
        model,
        usage,
        tool_uses,
        text,
        ai_title,
    })
}

/// Extracts prompt/response text per `ParsedRecord.text`'s documented rules. `content` is
/// `message.content` (whatever shape it happens to be, or absent entirely).
fn extract_text(record_type: &str, content: Option<&Value>) -> Option<String> {
    match record_type {
        "user" => content.and_then(Value::as_str).map(String::from),
        "assistant" => {
            let items = content.and_then(Value::as_array)?;
            let blocks: Vec<&str> = items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect();
            if blocks.is_empty() {
                None
            } else {
                Some(blocks.join("\n"))
            }
        }
        _ => None,
    }
}

fn extract_tool_use(item: &Value) -> Option<ToolUse> {
    if item.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }
    let name = item.get("name").and_then(Value::as_str)?;
    let input = item.get("input")?;

    match name {
        "Write" => Some(ToolUse::Write {
            file_path: input.get("file_path").and_then(Value::as_str)?.to_string(),
            content: input
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        "Edit" => Some(ToolUse::Edit {
            file_path: input.get("file_path").and_then(Value::as_str)?.to_string(),
            old_string: input
                .get("old_string")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            new_string: input
                .get("new_string")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        "MultiEdit" => {
            let file_path = input.get("file_path").and_then(Value::as_str)?.to_string();
            let edits = input
                .get("edits")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| {
                            let old = e.get("old_string").and_then(Value::as_str)?.to_string();
                            let new = e.get("new_string").and_then(Value::as_str)?.to_string();
                            Some((old, new))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(ToolUse::MultiEdit { file_path, edits })
        }
        // Best-effort: NotebookEdit's exact field names weren't confirmed against a real
        // captured record (only Write/Edit were). Never panics either way since every access
        // is Option-based; worst case this tool use is silently skipped.
        "NotebookEdit" => Some(ToolUse::NotebookEdit {
            file_path: input
                .get("notebook_path")
                .and_then(Value::as_str)?
                .to_string(),
            old_string: input
                .get("old_string")
                .and_then(Value::as_str)
                .map(String::from),
            new_string: input
                .get("new_source")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        _ => None,
    }
}

fn log_unknown_type_once(record_type: &str) {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let set = SEEN.get_or_init(|| Mutex::new(HashSet::new()));
    let mut set = set.lock().unwrap();
    if set.insert(record_type.to_string()) {
        log::warn!("encountered unknown Claude Code JSONL record type: {record_type:?} (ignoring)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tests/fixtures/session_basic.jsonl` is a hand-built, fully synthetic file that
    /// mirrors the exact record shapes captured from real `~/.claude/projects/**/*.jsonl`
    /// files on this machine (field names, nesting, inert-type list) without containing any
    /// real session content. See PLAN.md's "Grounding note" for the real-log inspection this
    /// is based on.
    const SESSION_BASIC_FIXTURE: &str =
        include_str!("../../tests/fixtures/session_basic.jsonl");

    fn parsed_fixture_lines() -> Vec<ParsedRecord> {
        SESSION_BASIC_FIXTURE
            .lines()
            .filter_map(parse_line)
            .collect()
    }

    #[test]
    fn inert_and_unknown_header_lines_produce_no_parsed_record() {
        // Fixture's first 5 lines are last-prompt/mode/permission-mode/attachment/
        // file-history-snapshot (all inert, several with no cwd/timestamp at all) - none of
        // them should turn into a ParsedRecord, and parsing must not panic on any of them.
        let records = parsed_fixture_lines();
        // 14 total lines: 5 inert header lines + 1 user + 1 ai-title + 4 assistant +
        // 1 system + 1 unknown-future-type (inert-by-ignoring) + 1 queue-operation (inert) =
        // user + ai-title + 4 assistant + system = 7 real records survive.
        assert_eq!(records.len(), 7, "expected exactly 7 real records, got: {records:#?}");
    }

    #[test]
    fn ai_title_record_yields_its_title_and_no_other_type_does() {
        let records = parsed_fixture_lines();
        let ai_title_record = records
            .iter()
            .find(|r| r.record_type == "ai-title")
            .expect("fixture has an ai-title record");
        assert_eq!(
            ai_title_record.ai_title.as_deref(),
            Some("Add hello world and fix greeting")
        );
        assert!(
            records
                .iter()
                .filter(|r| r.record_type != "ai-title")
                .all(|r| r.ai_title.is_none()),
            "only the ai-title record should carry ai_title"
        );
    }

    #[test]
    fn unknown_record_type_is_skipped_not_fatal() {
        // Line 11 in the fixture is `future-record-type-not-yet-known`, a type this parser
        // has never seen. It carries cwd/timestamp (so it *would* be extractable if it were
        // user/assistant/system) but must still be silently ignored, never panic.
        assert!(parse_line(
            r#"{"type":"future-record-type-not-yet-known","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}"#
        )
        .is_none());
    }

    #[test]
    fn token_sums_across_assistant_records_match_fixture() {
        let records = parsed_fixture_lines();
        let (input, output, cache_read, cache_creation) = records
            .iter()
            .filter(|r| r.record_type == "assistant")
            .filter_map(|r| r.usage.as_ref())
            .fold((0, 0, 0, 0), |(i, o, cr, cc), u| {
                (
                    i + u.input_tokens,
                    o + u.output_tokens,
                    cr + u.cache_read_input_tokens,
                    cc + u.cache_creation_input_tokens,
                )
            });

        // Sums of the 4 assistant records' usage blocks in session_basic.jsonl:
        // input:  120 + 15 + 8 + 5   = 148
        // output: 340 + 90 + 210 + 60 = 700
        // cache_read: 5000 + 5400 + 5600 + 5800 = 21800
        // cache_creation: 200 + 50 + 30 + 10 = 290
        assert_eq!(input, 148);
        assert_eq!(output, 700);
        assert_eq!(cache_read, 21800);
        assert_eq!(cache_creation, 290);
    }

    #[test]
    fn model_string_extracted_from_assistant_message() {
        let records = parsed_fixture_lines();
        let assistant = records
            .iter()
            .find(|r| r.record_type == "assistant")
            .expect("fixture has at least one assistant record");
        assert_eq!(assistant.model.as_deref(), Some("claude-opus-4-8"));
    }

    #[test]
    fn write_tool_use_extracted_with_full_content() {
        let records = parsed_fixture_lines();
        let write = records
            .iter()
            .flat_map(|r| &r.tool_uses)
            .find_map(|t| match t {
                ToolUse::Write { file_path, content } => Some((file_path, content)),
                _ => None,
            })
            .expect("fixture has a Write tool_use");
        assert_eq!(write.0, "src/main.rs");
        assert_eq!(write.1, "fn main() {\n    println!(\"hello\");\n}\n");
    }

    #[test]
    fn edit_tool_use_extracted_with_old_and_new_string() {
        let records = parsed_fixture_lines();
        let edit = records
            .iter()
            .flat_map(|r| &r.tool_uses)
            .find_map(|t| match t {
                ToolUse::Edit {
                    file_path,
                    old_string,
                    new_string,
                } => Some((file_path, old_string, new_string)),
                _ => None,
            })
            .expect("fixture has an Edit tool_use");
        assert_eq!(edit.0, "src/main.rs");
        assert!(edit.1.contains("println!(\"a\")"));
        assert!(edit.2.contains("println!(\"b\")"));
    }

    #[test]
    fn multi_edit_tool_use_extracts_all_edits() {
        let records = parsed_fixture_lines();
        let multi_edit = records
            .iter()
            .flat_map(|r| &r.tool_uses)
            .find_map(|t| match t {
                ToolUse::MultiEdit { file_path, edits } => Some((file_path, edits)),
                _ => None,
            })
            .expect("fixture has a MultiEdit tool_use");
        assert_eq!(multi_edit.0, "src/lib.rs");
        assert_eq!(multi_edit.1.len(), 2);
    }

    #[test]
    fn notebook_edit_tool_use_extracted_from_notebook_path_and_new_source() {
        let records = parsed_fixture_lines();
        let notebook_edit = records
            .iter()
            .flat_map(|r| &r.tool_uses)
            .find_map(|t| match t {
                ToolUse::NotebookEdit {
                    file_path,
                    old_string,
                    new_string,
                } => Some((file_path, old_string, new_string)),
                _ => None,
            })
            .expect("fixture has a NotebookEdit tool_use");
        assert_eq!(notebook_edit.0, "notebook.ipynb");
        assert_eq!(notebook_edit.1.as_deref(), Some("print(1)\n"));
        assert_eq!(notebook_edit.2, "print(2)\n");
    }

    #[test]
    fn system_record_carries_cwd_and_git_branch_but_no_usage() {
        let records = parsed_fixture_lines();
        let system = records
            .iter()
            .find(|r| r.record_type == "system")
            .expect("fixture has a system record");
        assert_eq!(system.cwd.as_deref(), Some("/Users/testuser/Desktop/fixture-project"));
        assert_eq!(system.git_branch.as_deref(), Some("main"));
        assert!(system.usage.is_none());
        assert!(system.tool_uses.is_empty());
    }

    #[test]
    fn malformed_json_line_is_skipped_without_panicking() {
        assert!(parse_line("not json at all").is_none());
        assert!(parse_line(r#"{"type": "user", "message": {"role": "user", "content": "cut off mid-w"#).is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
    }

    #[test]
    fn malformed_line_fixture_only_yields_the_two_valid_records() {
        let fixture = include_str!("../../tests/fixtures/malformed_line.jsonl");
        let records: Vec<_> = fixture.lines().filter_map(parse_line).collect();
        assert_eq!(records.len(), 2, "the truncated middle line must be skipped, not fatal");
        assert_eq!(records[0].session_id.as_deref(), Some("fx-malformed-0000-0000-0000-000000000000"));
        assert_eq!(records[1].session_id.as_deref(), Some("fx-malformed-0000-0000-0000-000000000000"));
    }

    #[test]
    fn user_record_text_is_the_plain_string_content() {
        let records = parsed_fixture_lines();
        let user = records
            .iter()
            .find(|r| r.record_type == "user")
            .expect("fixture has a user record");
        assert_eq!(
            user.text.as_deref(),
            Some("Add a hello world main function and fix the greeting in foo().")
        );
    }

    #[test]
    fn assistant_record_text_skips_tool_use_block_and_captures_only_text_block() {
        let records = parsed_fixture_lines();
        // Fixture's first assistant record (uuid-3) has both a "text" block
        // ("I'll create the main function.") and a "tool_use" block (Write) - only the text
        // block's content should end up in `text`.
        let assistant = records
            .iter()
            .filter(|r| r.record_type == "assistant")
            .nth(0)
            .expect("fixture has at least one assistant record");
        assert_eq!(assistant.text.as_deref(), Some("I'll create the main function."));
    }

    #[test]
    fn assistant_record_with_only_tool_use_blocks_has_no_text() {
        let records = parsed_fixture_lines();
        // Fixture's second assistant record (uuid-4) has only a tool_use (Edit) block, no
        // text block at all.
        let assistant = records
            .iter()
            .filter(|r| r.record_type == "assistant")
            .nth(1)
            .expect("fixture has a second assistant record");
        assert_eq!(assistant.text, None);
    }

    #[test]
    fn system_record_text_is_always_none() {
        let records = parsed_fixture_lines();
        let system = records
            .iter()
            .find(|r| r.record_type == "system")
            .expect("fixture has a system record");
        assert_eq!(system.text, None);
    }

    #[test]
    fn unrecognized_model_string_and_missing_usage_fields_never_panic() {
        // `<synthetic>` and similar sentinels appear in real logs (see PLAN.md's grounding
        // note) - the parser must tolerate them, pricing lookup handles them separately.
        let record = parse_line(
            r#"{"type":"assistant","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp",
               "message":{"model":"<synthetic>","content":[]}}"#,
        )
        .expect("well-formed assistant record should still parse");
        assert_eq!(record.model.as_deref(), Some("<synthetic>"));
        // No `usage` key at all in this line - must default cleanly, not panic/error.
        assert!(record.usage.is_none());
    }
}
