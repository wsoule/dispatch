//! Shared currency types every per-agent format parser (`claude_jsonl`, `codex_jsonl`,
//! `gemini_log`, `cursor_jsonl`) produces, so `session_builder::ingest_record` can stay
//! agent-agnostic — it only ever sees a `ParsedRecord`, never a raw log line.

/// Whether a parser's token numbers are this record's own increment or the session's
/// running total so far. Agents differ, and the distinction decides how `upsert_session`
/// folds them in: summing a running total once per record inflates a session's counters
/// roughly quadratically in its turn count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UsageKind {
    /// This record's own tokens, to be added to the session total (Claude Code, Gemini).
    #[default]
    Delta,
    /// The session's cumulative total as of this record (Codex), to be taken as-is.
    Cumulative,
}

#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub kind: UsageKind,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone)]
pub enum ToolUse {
    Write {
        file_path: String,
        content: String,
    },
    Edit {
        file_path: String,
        old_string: String,
        new_string: String,
    },
    MultiEdit {
        file_path: String,
        edits: Vec<(String, String)>,
    },
    NotebookEdit {
        file_path: String,
        old_string: Option<String>,
        new_string: String,
    },
}

#[derive(Debug, Clone)]
pub struct ParsedRecord {
    pub record_type: String,
    /// Which agent CLI produced this record — `"claude"` | `"codex"` | `"gemini"` | `"cursor"`.
    /// Set once by the format-specific parser that built this record; `ingest_record` just
    /// forwards it to `upsert_session` rather than assuming Claude.
    pub agent: &'static str,
    pub cwd: Option<String>,
    #[allow(dead_code)] // not yet surfaced in the UI; parsed for future stack/lang detection
    pub git_branch: Option<String>,
    pub session_id: Option<String>,
    pub timestamp: Option<i64>, // unix seconds
    pub model: Option<String>,
    pub usage: Option<Usage>,
    pub tool_uses: Vec<ToolUse>,
    /// Prompt/response text content, if any. For `user` records: the plain-string
    /// `message.content`, when present in that shape (an array `content` — e.g. a
    /// multi-part/attachment message — is left as `None`, out of scope; see this module's
    /// doc comment). For `assistant` records: every `content[]` item with `"type": "text"`
    /// concatenated with `"\n"` between blocks (`"thinking"`/`"tool_use"` blocks skipped),
    /// or `None` if there were no text blocks (e.g. a tool-only turn). For `system` records:
    /// always `None` — system records never carry prompt/response text.
    pub text: Option<String>,
    /// Only set on Claude Code's `"ai-title"` record: its own auto-generated title for this
    /// session (the `aiTitle` field) — the same text shown as "Session name" in `claude`
    /// CLI's `/status` and the `--resume` picker. `None` for every other record type/agent.
    pub ai_title: Option<String>,
}
