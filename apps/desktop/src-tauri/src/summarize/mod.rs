//! AI summary pipeline (Task C2): one-sentence summaries of ended sessions via the Anthropic
//! Messages API, using Claude Haiku. This module owns API-key resolution, the in-flight
//! dedup set that keeps the 20s idle sweep from double-spawning a summarization task for the
//! same session, and the actual API call. Prompt construction lives in `prompts` (its pure
//! parts are unit-tested there); sweep wiring — deciding *which* sessions to summarize each
//! tick, and the DB-lock discipline around the network call — lives in `lib.rs`, alongside
//! the tag-classification step it runs next to.

pub mod prompts;

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// The Anthropic API key resolved once at startup (see `resolve_api_key`), or `None` if
/// summarization is disabled for this app run. Tauri-managed state rather than a `OnceLock`
/// because — per PLAN.md's forward note — a future Phase 4 settings UI will want to replace
/// it at runtime without an app restart; that phase can swap this for interior mutability
/// (e.g. `Mutex<Option<String>>`) without touching how the rest of this module reads it.
/// Never format `{:?}`/log this type's contents — see `resolve_api_key`'s doc comment.
pub struct ApiKeyState(pub Option<String>);

/// Session ids currently being summarized. The idle sweep ticks every `SWEEP_INTERVAL_SECS`;
/// without this, a slow/hanging API call could still be in flight for a session when the next
/// tick fires, and `sessions_needing_summary` would return that same session again (its
/// `summary` column is still `NULL` until the first call finishes), spawning a second
/// concurrent task for it. Every task that inserts its id here on spawn must remove it on
/// every exit path — see `InFlightGuard`.
pub struct InFlight(pub Mutex<HashSet<String>>);

/// A single shared `reqwest::Client` (connection pooling, one TLS setup) reused across every
/// summarization task, rather than a fresh client per spawned task.
pub struct HttpClient(pub reqwest::Client);

/// RAII guard: removes `session_id` from the shared in-flight set when dropped. Constructed
/// right after the id is inserted (see `lib.rs`'s sweep step), held for the lifetime of the
/// spawned summarization task's async block. Rust runs `Drop` on every exit path out of that
/// scope — normal completion, an early `return` on any error branch, or a panic unwind — so
/// this is the removal guarantee the brief asks for without hand-auditing each `return`.
pub struct InFlightGuard {
    app_handle: AppHandle,
    session_id: String,
}

impl InFlightGuard {
    pub fn new(app_handle: AppHandle, session_id: String) -> Self {
        Self {
            app_handle,
            session_id,
        }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let in_flight = self.app_handle.state::<InFlight>();
        let lock_result = in_flight.0.lock();
        match lock_result {
            Ok(mut set) => {
                set.remove(&self.session_id);
            }
            Err(e) => {
                // A poisoned mutex here would mean some other task panicked while holding
                // the lock; log and move on rather than panicking again ourselves (this runs
                // during unwind/drop in some cases, where panicking again would abort).
                log::warn!(
                    "summarize: in-flight set mutex poisoned while removing session {}: {e}",
                    self.session_id
                );
            }
        }
    }
}

/// Resolves the Anthropic API key at startup, in this exact order:
/// 1. `ANTHROPIC_API_KEY` env var (an empty string counts as unset).
/// 2. `<app_data_dir>/config.json`'s `"api_key"` field, if the file exists and parses as
///    JSON — any other shape (missing file, invalid JSON, missing/empty field) is treated as
///    "no key" rather than an error, so a malformed `config.json` can never fail app startup.
/// 3. Otherwise `None` — summarization is disabled for this app run; the caller is
///    responsible for logging that once (`log_summarization_disabled_once`), not this
///    function, so a lookup used by a future test doesn't have a side-effecting log baked in.
///
/// Never logs the resolved value — not on success, not in an error path. Only ever returns
/// or discards it.
pub fn resolve_api_key(app: &AppHandle) -> Option<String> {
    if let Ok(v) = std::env::var("ANTHROPIC_API_KEY") {
        if !v.is_empty() {
            return Some(v);
        }
    }

    let app_data_dir = app.path().app_data_dir().ok()?;
    let config_path = app_data_dir.join("config.json");
    let contents = std::fs::read_to_string(config_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let key = value.get("api_key")?.as_str()?;

    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

/// Logs, once per app run (regardless of how many times or with how many different reasons
/// this is called), that AI summarization is disabled. The idle sweep would otherwise call
/// this every `SWEEP_INTERVAL_SECS` forever with no key configured — this keeps it
/// discoverable in logs without becoming log spam.
pub fn log_summarization_disabled_once(reason: &str) {
    static LOGGED: OnceLock<()> = OnceLock::new();
    LOGGED.get_or_init(|| {
        log::info!("AI summarization disabled: {reason}");
    });
}

/// Calls the Anthropic Messages API with `prompt`, returning the trimmed summary text on a
/// `200` response. Any other outcome — non-200 status, network error, or a response that
/// doesn't match the expected `{"content": [{"type": "...", "text": "..."}]}` shape — is
/// returned as an `Err`; the caller logs a warning (never including `api_key`) and leaves
/// `summary` `NULL` in the DB so the next sweep tick retries.
///
/// Not unit-tested directly (would require a live key or a mocking setup this codebase
/// doesn't have, per the task brief) — reviewed by hand for the header/body shape and the
/// response-parsing/error paths instead.
pub async fn call_anthropic_api(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    prompt: String,
) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 60,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        // Deliberately not including the response body in the error — on some error shapes
        // Anthropic echoes back parts of the request, and this must never risk leaking the
        // key (it wouldn't appear in the body, but keeping the error surface minimal here is
        // simpler than auditing that assumption forever).
        anyhow::bail!("Anthropic API request failed with status {status}");
    }

    let value: serde_json::Value = response.json().await?;
    let text = value
        .get("content")
        .and_then(|content| content.get(0))
        .and_then(|block| block.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow::anyhow!("unexpected Anthropic API response shape: {value}"))?;

    Ok(text.trim().to_string())
}
