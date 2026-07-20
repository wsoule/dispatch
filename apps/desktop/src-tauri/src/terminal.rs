//! Attaches a board card's prompt to a live `claude` CLI session running in Terminal.app for
//! that card's project, or opens a new Terminal window for one — see
//! `commands::launch_or_attach_session`. macOS-only: the underlying mechanism is Terminal.app
//! + System Events AppleScript automation, which has no equivalent on other platforms.

/// Runs `attach_session.applescript` (see that file's doc comment for the full behavior):
/// finds an existing Terminal tab already running `claude` in `project_path` and pastes
/// `prompt` into it, or opens a new Terminal window there (resuming `resume_session_id` if
/// given) that starts `claude` with `prompt` already seeded. Returns a short outcome string
/// for logging — `"attached_existing_tab"`, `"resumed_in_new_window"`, or
/// `"started_new_window"`.
///
/// The prompt is delivered two ways depending on the path (both handled by the script):
///   * New/resumed window — passed as a positional CLI argument to a fresh `claude`, so the
///     interactive session opens with the full prompt (title + description) already
///     submitted. It's shell-quoted here (`shell_ansi_c_quote`) with newlines escaped so it
///     stays on one physical line — `do script` would otherwise run a multi-line prompt's
///     first newline as a premature Return.
///   * Already-running tab — a process that's already up can't take a new argument, so the
///     prompt travels via the system clipboard and is pasted with Cmd+V (bracketed paste,
///     not per-character keystrokes, so Claude Code's interactive input doesn't submit early
///     at the first newline). The caller's previous clipboard contents are restored on the
///     way out, best-effort (a restore failure is logged, never turned into an error for an
///     otherwise successful attach/launch).
///
/// Requires the app to have macOS Accessibility (System Events keystrokes) and Automation
/// (controlling Terminal.app) permission — on first use macOS will prompt for these; if
/// denied, this returns an `Err` describing the `osascript` failure rather than silently
/// doing nothing.
#[cfg(target_os = "macos")]
pub fn attach_or_launch(
    project_path: &str,
    resume_session_id: Option<&str>,
    prompt: &str,
) -> anyhow::Result<String> {
    let previous_clipboard = read_clipboard();
    set_clipboard(prompt)?;

    let prompt_arg = shell_ansi_c_quote(prompt);
    let result = run_applescript(project_path, resume_session_id.unwrap_or(""), &prompt_arg);

    if let Some(previous) = previous_clipboard {
        if let Err(e) = set_clipboard(&previous) {
            log::warn!("failed to restore clipboard after pasting session prompt: {e:#}");
        }
    }

    result
}

/// Renders `prompt` as a single bash/zsh ANSI-C-quoted shell token (`$'...'`) suitable for
/// appending to a `claude` invocation on one physical line. Newlines become the two literal
/// characters `\n` (never a real newline, which Terminal's `do script` would execute as a
/// Return), and `\`, `'`, `\r`, `\t` are escaped the same way. Returns an empty string for an
/// empty prompt so the script launches a bare `claude` with no argument.
#[cfg(target_os = "macos")]
fn shell_ansi_c_quote(prompt: &str) -> String {
    if prompt.is_empty() {
        return String::new();
    }
    let mut out = String::from("$'");
    for c in prompt.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

#[cfg(not(target_os = "macos"))]
pub fn attach_or_launch(
    _project_path: &str,
    _resume_session_id: Option<&str>,
    _prompt: &str,
) -> anyhow::Result<String> {
    anyhow::bail!("attaching/launching a Claude Code terminal session is only supported on macOS")
}

#[cfg(target_os = "macos")]
const ATTACH_SESSION_SCRIPT: &str = include_str!("../resources/attach_session.applescript");

#[cfg(target_os = "macos")]
fn run_applescript(project_path: &str, resume_id: &str, prompt_arg: &str) -> anyhow::Result<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("osascript")
        .arg("-")
        .arg(project_path)
        .arg(resume_id)
        .arg(prompt_arg)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // Dropped (closing the pipe) at the end of this statement, which is what tells
    // osascript it's seen the whole script and can start running it.
    child
        .stdin
        .take()
        .expect("stdin was requested via Stdio::piped()")
        .write_all(ATTACH_SESSION_SCRIPT.as_bytes())?;

    let output = child.wait_with_output()?;
    if !output.status.success() {
        anyhow::bail!(
            "osascript failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn read_clipboard() -> Option<String> {
    let output = std::process::Command::new("pbpaste").output().ok()?;
    if output.status.success() {
        String::from_utf8(output.stdout).ok()
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn set_clipboard(text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn()?;
    child
        .stdin
        .take()
        .expect("stdin was requested via Stdio::piped()")
        .write_all(text.as_bytes())?;
    child.wait()?;
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::shell_ansi_c_quote;

    #[test]
    fn empty_prompt_yields_no_argument() {
        assert_eq!(shell_ansi_c_quote(""), "");
    }

    #[test]
    fn single_line_prompt_is_wrapped_in_ansi_c_quotes() {
        assert_eq!(shell_ansi_c_quote("fix the login bug"), "$'fix the login bug'");
    }

    #[test]
    fn newlines_are_escaped_so_the_command_stays_on_one_line() {
        // The title/description join from launch_or_attach_session uses a blank line between.
        let quoted = shell_ansi_c_quote("Add SSO\n\nSupport SAML and OIDC");
        assert_eq!(quoted, "$'Add SSO\\n\\nSupport SAML and OIDC'");
        assert!(!quoted.contains('\n'), "must not contain a literal newline");
    }

    #[test]
    fn embedded_quotes_and_backslashes_are_escaped() {
        assert_eq!(
            shell_ansi_c_quote("it's a \\ test"),
            "$'it\\'s a \\\\ test'"
        );
    }
}
