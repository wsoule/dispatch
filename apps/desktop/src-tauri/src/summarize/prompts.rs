//! Prompt construction for AI session summarization (Task C2). Combines a session's first
//! user request, its final assistant response, and the distinct list of file paths it
//! touched into a single prompt for Claude Haiku. Pure functions here (`truncate_for_prompt`,
//! `build_prompt`) do no I/O and are the testable core of this pipeline; `prompt_for_session`
//! is the thin DB/file-reading glue around them.

use crate::db::queries;
use crate::parser;

/// ~4 characters per token is a common rough heuristic for English prose. This codebase has
/// no tokenizer dependency and PLAN.md explicitly doesn't want one added just for a
/// truncation bound on a summarization prompt — so "~400 tokens" becomes "~1600 characters."
/// This is a deliberate approximation, not exact token counting.
const CHAR_BUDGET: usize = 1600;

/// Appended when truncation actually happened, so the model (and anyone reading logs) can
/// tell the excerpt was cut off rather than legitimately ending there.
const TRUNCATION_MARKER: char = '…';

/// Truncates `text` to at most `CHAR_BUDGET` *characters* (not bytes) and appends
/// `TRUNCATION_MARKER` only if truncation actually occurred. Always cuts at a `char`
/// boundary (via `chars()`), never a raw byte index — a naive byte-slice truncation can land
/// mid-codepoint on multi-byte UTF-8 input and panic; this can't.
pub fn truncate_for_prompt(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(CHAR_BUDGET).collect();

    if chars.next().is_some() {
        // There was at least one more character beyond the budget — truncation happened.
        let mut truncated = head;
        truncated.push(TRUNCATION_MARKER);
        truncated
    } else {
        // `head` already consumed the entire string (it had <= CHAR_BUDGET chars).
        head
    }
}

/// Inputs to [`build_prompt`] — already-extracted, not-yet-truncated text plus the distinct
/// file paths touched, so the pure prompt-composition logic can be tested without a DB or
/// filesystem.
pub struct PromptInputs {
    pub first_user_text: String,
    pub last_assistant_text: Option<String>,
    pub file_paths: Vec<String>,
}

/// Composes the final prompt sent to Claude Haiku. Includes, per PLAN.md §6, all three
/// required pieces: the user's request, the assistant's final response, and the list of
/// distinct file paths touched — plus an instruction constraining the model to one short,
/// change-focused sentence.
pub fn build_prompt(inputs: &PromptInputs) -> String {
    let user_text = truncate_for_prompt(&inputs.first_user_text);
    let assistant_text = inputs
        .last_assistant_text
        .as_deref()
        .map(truncate_for_prompt)
        .unwrap_or_else(|| "(no textual response captured)".to_string());

    let files_list = if inputs.file_paths.is_empty() {
        "(no files changed)".to_string()
    } else {
        inputs
            .file_paths
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        "You are summarizing a coding agent session for a developer dashboard.\n\n\
User's request:\n{user_text}\n\n\
Assistant's final response:\n{assistant_text}\n\n\
Files changed:\n{files_list}\n\n\
Write one sentence, no more than 15 words, describing what changed in this session. \
Respond with only that sentence — no preamble, no restating these instructions, no \
multiple sentences."
    )
}

/// The DB-derived inputs a prompt needs, gathered while the DB lock is held — deliberately
/// separate from the file read that follows, so a caller can drop the lock before doing that
/// I/O. See [`build_prompt_from_context`].
pub struct SessionPromptContext {
    pub raw_log_path: String,
    pub file_paths: Vec<String>,
}

/// DB-only half of prompt construction: two quick queries, no filesystem access. Callers hold
/// the DB lock for this call and this call alone — `None` means "no `raw_log_path` row for
/// this session," the same "nothing to summarize" signal `build_prompt_from_context` gives for
/// its own no-data case.
pub fn session_prompt_context(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> anyhow::Result<Option<SessionPromptContext>> {
    let Some(raw_log_path) = queries::session_raw_log_path(conn, session_id)? else {
        return Ok(None);
    };

    let file_paths = match queries::get_session_detail(conn, session_id)? {
        Some((_, files)) => {
            let mut seen = std::collections::HashSet::new();
            files
                .into_iter()
                .map(|f| f.file_path)
                .filter(|p| seen.insert(p.clone()))
                .collect()
        }
        None => Vec::new(),
    };

    Ok(Some(SessionPromptContext {
        raw_log_path,
        file_paths,
    }))
}

/// Filesystem half of prompt construction: re-reads the session's raw log (via
/// `parser::extract_excerpts`) and composes the final prompt. Takes no DB connection and does
/// no locking — callers must call this *after* dropping the DB lock used to obtain `ctx` via
/// [`session_prompt_context`], never while still holding it, since this does a full-file read
/// and parse that can be slow on a large session log (PLAN.md notes real sessions "can exceed
/// 1000 lines"). Holding the process's single shared DB connection mutex across that would
/// block every other DB access — every UI command, the next sweep tick, everything — for as
/// long as this read takes.
///
/// `Ok(None)` (no captured first-user text) means the same thing it did in the pre-split
/// `prompt_for_session`: skip the API call entirely, leave `summary` `NULL`.
pub fn build_prompt_from_context(ctx: &SessionPromptContext) -> anyhow::Result<Option<String>> {
    let excerpts = parser::extract_excerpts(&ctx.raw_log_path)?;

    let Some(first_user_text) = excerpts.first_user_text else {
        return Ok(None);
    };

    Ok(Some(build_prompt(&PromptInputs {
        first_user_text,
        last_assistant_text: excerpts.last_assistant_text,
        file_paths: ctx.file_paths.clone(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_passes_through_unchanged() {
        let text = "Add a hello world main function.";
        assert_eq!(truncate_for_prompt(text), text);
    }

    #[test]
    fn text_at_exactly_the_budget_is_unchanged() {
        let text = "a".repeat(1600);
        let result = truncate_for_prompt(&text);
        assert_eq!(result, text);
        assert_eq!(result.chars().count(), 1600);
    }

    #[test]
    fn long_text_is_truncated_to_budget_plus_marker() {
        let text = "a".repeat(2000);
        let result = truncate_for_prompt(&text);
        // 1600 kept characters + 1 truncation marker character.
        assert_eq!(result.chars().count(), 1601);
        assert!(result.ends_with('…'));
        assert!(result.starts_with(&"a".repeat(1600)));
    }

    #[test]
    fn truncation_does_not_panic_on_multibyte_utf8_and_cuts_at_a_char_boundary() {
        // Each "🦀" is a 4-byte UTF-8 scalar; naive byte-index slicing at an arbitrary
        // offset would panic. `chars()`-based truncation must not.
        let text = "🦀".repeat(2000);
        let result = truncate_for_prompt(&text); // must not panic
        assert_eq!(result.chars().count(), 1601);
        assert!(result.ends_with('…'));
    }

    #[test]
    fn empty_text_stays_empty() {
        assert_eq!(truncate_for_prompt(""), "");
    }

    #[test]
    fn build_prompt_includes_user_text_assistant_text_and_file_list() {
        let inputs = PromptInputs {
            first_user_text: "Add a login form.".to_string(),
            last_assistant_text: Some("I added the login form component.".to_string()),
            file_paths: vec!["src/Login.tsx".to_string(), "src/App.tsx".to_string()],
        };
        let prompt = build_prompt(&inputs);

        assert!(prompt.contains("Add a login form."));
        assert!(prompt.contains("I added the login form component."));
        assert!(prompt.contains("src/Login.tsx"));
        assert!(prompt.contains("src/App.tsx"));
        assert!(prompt.to_lowercase().contains("one sentence"));
        assert!(prompt.contains("15 words"));
    }

    #[test]
    fn build_prompt_handles_missing_assistant_text_and_empty_file_list_without_panicking() {
        let inputs = PromptInputs {
            first_user_text: "Do something.".to_string(),
            last_assistant_text: None,
            file_paths: vec![],
        };
        let prompt = build_prompt(&inputs); // must not panic
        assert!(prompt.contains("Do something."));
        assert!(prompt.contains("(no files changed)"));
    }

    #[test]
    fn build_prompt_truncates_long_inputs_before_composing() {
        let long_text = "b".repeat(5000);
        let inputs = PromptInputs {
            first_user_text: long_text.clone(),
            last_assistant_text: Some(long_text.clone()),
            file_paths: vec![],
        };
        let prompt = build_prompt(&inputs);
        // The full 5000-char strings must not appear verbatim in the prompt — each was
        // truncated to the ~1600-char budget before composing.
        assert!(!prompt.contains(&long_text));
        assert!(prompt.contains('…'));
    }

    #[test]
    fn session_prompt_context_returns_none_for_unknown_session_id() {
        // Mirrors `parser::session_builder::tests::in_memory_db` — a fresh in-memory DB with
        // the schema applied but no rows, so `session_raw_log_path` legitimately finds nothing.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql"))
            .unwrap();

        let result = session_prompt_context(&conn, "does-not-exist").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn build_prompt_from_context_reads_the_real_log_file_and_composes_a_prompt() {
        // Glue test for the split (context-gathering vs. file-reading) — the two halves are
        // each already covered above (build_prompt) and in parser::transcript's own tests
        // (extract_excerpts against this same fixture), so this only needs to confirm the glue
        // works end to end, not re-prove either half's correctness.
        let ctx = SessionPromptContext {
            raw_log_path: concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/session_basic.jsonl")
                .to_string(),
            file_paths: vec!["src/main.rs".to_string()],
        };

        let prompt = build_prompt_from_context(&ctx).unwrap().unwrap();
        assert!(prompt.contains("Add a hello world main function"));
        assert!(prompt.contains("src/main.rs"));
    }

    #[test]
    fn build_prompt_from_context_errors_on_unreadable_path_without_panicking() {
        let ctx = SessionPromptContext {
            raw_log_path: "/nonexistent/path/does-not-exist.jsonl".to_string(),
            file_paths: vec![],
        };
        assert!(build_prompt_from_context(&ctx).is_err());
    }
}
