pub mod claude_jsonl;
pub mod codex_jsonl;
pub mod cursor_jsonl;
pub mod gemini_log;
pub mod record;
pub mod session_builder;
pub mod transcript;

pub use claude_jsonl::parse_line;
pub use codex_jsonl::parse_line as parse_codex_line;
pub use cursor_jsonl::parse_line as parse_cursor_line;
pub use gemini_log::parse_line as parse_gemini_line;
pub use record::ParsedRecord;
pub use session_builder::{ingest_record, IngestOutcome};
pub use transcript::{extract_excerpts, render_markdown};
// `TranscriptExcerpts` isn't referenced by name yet (its `last_assistant_text` field is for
// Task C2's summarization pipeline, not this task's tag classification) - re-exported here so
// that future consumer can reach it via `parser::TranscriptExcerpts` without reaching into the
// submodule directly.
#[allow(unused_imports)]
pub use transcript::TranscriptExcerpts;
