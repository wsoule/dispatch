//! Re-reads a session's raw `.jsonl` log to extract the prompt/response text excerpts that
//! both tag auto-classification (this task) and AI summarization (a later task) need. Runs
//! only after a session has been fully ingested (i.e. after `finalize_session`), so a plain
//! synchronous full-file read is sufficient — no need for the watcher's incremental
//! byte-offset tailing machinery here.

use super::claude_jsonl::parse_line;
use super::record::ToolUse;

pub struct TranscriptExcerpts {
    pub first_user_text: Option<String>,
    #[allow(dead_code)] // consumed by Task C2's summarization pipeline, not this task
    pub last_assistant_text: Option<String>,
}

/// Reads `raw_log_path` in full, parses every line, and extracts:
/// - `first_user_text`: the first `user`-type record's `text` (skipping records where
///   `text` is `None`, e.g. a user record with non-string `content`).
/// - `last_assistant_text`: the *most recent* `assistant`-type record with non-`None` text,
///   in file order — a later tool-only assistant turn (no text block) does not blank out an
///   earlier textful one.
///
/// Propagates I/O errors (missing/unreadable file) via `anyhow::Result` rather than
/// panicking; the caller decides how to handle that (e.g. the idle sweep writes an empty tag
/// list rather than retrying forever).
pub fn extract_excerpts(raw_log_path: &str) -> anyhow::Result<TranscriptExcerpts> {
    let contents = std::fs::read_to_string(raw_log_path)?;

    let mut first_user_text: Option<String> = None;
    let mut last_assistant_text: Option<String> = None;

    for line in contents.lines() {
        let Some(record) = parse_line(line) else {
            continue;
        };

        match record.record_type.as_str() {
            "user" if first_user_text.is_none() => {
                if let Some(text) = record.text {
                    first_user_text = Some(text);
                }
            }
            "assistant" => {
                if let Some(text) = record.text {
                    last_assistant_text = Some(text);
                }
            }
            _ => {}
        }
    }

    Ok(TranscriptExcerpts {
        first_user_text,
        last_assistant_text,
    })
}

/// Renders `raw_log_path` as a human-readable Markdown chat log: one `### You` / `### Assistant`
/// heading per turn, in file order, with the turn's text (or an italic placeholder for a
/// tool-only assistant turn) followed by a bullet per tool call the turn made. `system` and
/// `ai-title` records carry no conversational content (see `ParsedRecord::text`'s doc comment)
/// and are skipped rather than rendered as empty turns.
pub fn render_markdown(raw_log_path: &str) -> anyhow::Result<String> {
    let contents = std::fs::read_to_string(raw_log_path)?;
    let mut out = String::new();

    for line in contents.lines() {
        let Some(record) = parse_line(line) else {
            continue;
        };

        let heading = match record.record_type.as_str() {
            "user" => "### You",
            "assistant" => "### Assistant",
            _ => continue,
        };

        out.push_str(heading);
        out.push_str("\n\n");
        match &record.text {
            Some(text) => {
                out.push_str(text);
                out.push('\n');
            }
            None => out.push_str("_[no text]_\n"),
        }

        for tool_use in &record.tool_uses {
            out.push_str("- ");
            out.push_str(&describe_tool_use(tool_use));
            out.push('\n');
        }

        out.push('\n');
    }

    Ok(out)
}

fn describe_tool_use(tool_use: &ToolUse) -> String {
    match tool_use {
        ToolUse::Write { file_path, .. } => format!("Wrote `{file_path}`"),
        ToolUse::Edit { file_path, .. } => format!("Edited `{file_path}`"),
        ToolUse::MultiEdit { file_path, edits } => {
            format!("Multi-edited `{file_path}` ({} edits)", edits.len())
        }
        ToolUse::NotebookEdit { file_path, .. } => format!("Notebook-edited `{file_path}`"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors `watcher::tail::tests::TempFile` — cleans up its file on drop so a failing
    /// assertion can't leak a stray temp file. Not shared across modules since it's a few
    /// lines and each caller wants a distinct file-name prefix.
    struct TempFile(std::path::PathBuf);

    impl TempFile {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "relay-transcript-test-{}-{name}.jsonl",
                std::process::id()
            ));
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }

        fn write(&self, contents: &str) {
            std::fs::write(&self.0, contents).unwrap();
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    const SESSION_BASIC_FIXTURE: &str =
        include_str!("../../tests/fixtures/session_basic.jsonl");

    #[test]
    fn extracts_first_user_text_and_last_textful_assistant_text_from_fixture() {
        let file = TempFile::new("basic");
        file.write(SESSION_BASIC_FIXTURE);

        let excerpts = extract_excerpts(&file.path().to_string_lossy()).unwrap();

        assert_eq!(
            excerpts.first_user_text.as_deref(),
            Some("Add a hello world main function and fix the greeting in foo().")
        );
        // Fixture's only textful assistant record is the first one (uuid-3); the three
        // later assistant records (uuid-4, uuid-5, uuid-7) are all tool-only turns with no
        // text block, so they must not blank out the earlier textful answer.
        assert_eq!(
            excerpts.last_assistant_text.as_deref(),
            Some("I'll create the main function.")
        );
    }

    #[test]
    fn unreadable_file_returns_err_not_panic() {
        let result = extract_excerpts("/nonexistent/path/does-not-exist.jsonl");
        assert!(result.is_err());
    }

    #[test]
    fn render_markdown_renders_one_heading_per_turn_with_tool_call_bullets() {
        let file = TempFile::new("render");
        file.write(SESSION_BASIC_FIXTURE);

        let markdown = render_markdown(&file.path().to_string_lossy()).unwrap();

        // user turn: heading + its text, no bullets.
        assert!(markdown.contains(
            "### You\n\nAdd a hello world main function and fix the greeting in foo().\n"
        ));
        // first assistant turn: text plus its Write tool call.
        assert!(markdown.contains(
            "### Assistant\n\nI'll create the main function.\n- Wrote `src/main.rs`\n"
        ));
        // remaining assistant turns are tool-only: no text block, so the placeholder plus
        // their respective tool call bullet.
        assert!(markdown.contains("_[no text]_\n- Edited `src/main.rs`\n"));
        assert!(markdown.contains("_[no text]_\n- Multi-edited `src/lib.rs` (2 edits)\n"));
        assert!(markdown.contains("_[no text]_\n- Notebook-edited `notebook.ipynb`\n"));
        // the system and ai-title records carry no conversational content and must not
        // produce their own heading.
        assert!(!markdown.contains("### System"));
        assert_eq!(markdown.matches("### ").count(), 5, "expected exactly 5 rendered turns");
    }

    #[test]
    fn render_markdown_unreadable_file_returns_err_not_panic() {
        let result = render_markdown("/nonexistent/path/does-not-exist.jsonl");
        assert!(result.is_err());
    }

    #[test]
    fn trailing_tool_only_assistant_turn_does_not_blank_out_earlier_textful_answer() {
        let file = TempFile::new("trailing-tool-only");
        file.write(
            r#"{"type":"user","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp","message":{"role":"user","content":"do the thing"}}
{"type":"assistant","sessionId":"s","timestamp":"2026-01-01T00:00:01Z","cwd":"/tmp","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"Sure, doing it now."}]}}
{"type":"assistant","sessionId":"s","timestamp":"2026-01-01T00:00:02Z","cwd":"/tmp","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"a.rs","content":"x"}}]}}
"#,
        );

        let excerpts = extract_excerpts(&file.path().to_string_lossy()).unwrap();
        assert_eq!(excerpts.first_user_text.as_deref(), Some("do the thing"));
        assert_eq!(
            excerpts.last_assistant_text.as_deref(),
            Some("Sure, doing it now.")
        );
    }

    #[test]
    fn empty_file_yields_no_excerpts_without_panicking() {
        let file = TempFile::new("empty");
        file.write("");

        let excerpts = extract_excerpts(&file.path().to_string_lossy()).unwrap();
        assert!(excerpts.first_user_text.is_none());
        assert!(excerpts.last_assistant_text.is_none());
    }
}
