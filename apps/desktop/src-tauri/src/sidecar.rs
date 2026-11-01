//! Wiring for `dispatchd` — the Bun HTTP+WS daemon that serves
//! `.dispatch/` task data for one project root (see
//! `packages/server/src/daemonfile.ts` and `packages/server/src/bin.ts`).
//!
//! `ensure_dispatchd` is the frontend's single entry point: given a project
//! root, return a healthy dispatchd port, spawning one if none is already
//! running. This mirrors `dispatch ui`'s own ensure-daemon flow
//! (`packages/cli/src/commands/daemon.ts`'s `waitForHealthyDaemon`) almost
//! exactly, reimplemented here so the desktop app doesn't need Node or
//! `@dispatch/cli` on `PATH`.
//!
//! How dispatchd starts depends on the build (see `DaemonLaunch` and
//! `commands.rs`'s `resolve_daemon_launch`): a dev build runs the TypeScript
//! entry through `bun` straight from this checkout, while a packaged release
//! runs the standalone `bun build --compile`d binaries bundled under the
//! app's Resource dir, so a shipped app needs neither `bun` nor the checkout.

mod process;

use process::{process_state, ProcessState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Mirrors `packages/server/src/daemonfile.ts`'s `DaemonFileInfo` shape
/// exactly — this is deserialized straight from the JSON file that Bun
/// writes, so field names (via `rename_all`) must match verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonFileInfo {
    port: u16,
    pid: u32,
    root_dir: String,
    started_at: String,
    /// Request-tier credential, written to the 0600 daemon file. `Option` on
    /// purpose: a daemon file left behind by a build predating token auth still
    /// parses (and is then treated as "no token"), instead of failing to
    /// deserialize and silently routing every attach into a fresh spawn.
    #[serde(default)]
    agent_token: Option<String>,
    /// Set by a daemon the CLI started in the background. Read loosely, so a
    /// shape this build does not know never fails the whole file.
    #[serde(default)]
    background: Option<serde_json::Value>,
}

/// Whether the daemon file marks its daemon as a background CLI daemon.
fn is_background(value: &Option<serde_json::Value>) -> bool {
    matches!(value, Some(serde_json::Value::Bool(true)))
}

/// What the frontend needs to talk to a dispatchd: its port plus whichever
/// credentials this app actually holds. `app_token` is present only when this
/// app spawned the daemon and read the token off its stdout — it is never read
/// from disk, because a token at rest is one `cat` away for any agent running
/// as the same user, which is the hole this whole scheme exists to close.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonConnection {
    pub port: u16,
    pub app_token: Option<String>,
    pub agent_token: Option<String>,
    /// True when an attached daemon's file says the CLI started it in the
    /// background, so the UI can say who holds it.
    pub background: bool,
}

/// Health verifies readiness, root and the daemon generation. These fields
/// already exist in the server response; no new wire identity is needed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    root_dir: Option<String>,
    pid: Option<u32>,
    started_at: Option<String>,
    identity: Option<String>,
}

// ---------------------------------------------------------------------------
// Daemon-file discovery — mirrors daemonfile.ts's read side.
// ---------------------------------------------------------------------------

/// sha256(rootDir) hex, first 12 chars — must stay byte-for-byte identical
/// to `daemonfile.ts`'s `daemonFileKey`. Cross-checked in tests against the
/// same fixture value `packages/cli/test/daemon-cmd.test.ts` uses, so drift
/// between the TS and Rust copies of this scheme fails loudly here too.
pub(crate) fn daemon_file_key(root_dir: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root_dir.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..12].to_string()
}

/// Pure path-joining half of `daemon_file_path`, split out so tests can pass
/// a fixed `home` instead of depending on `$DISPATCH_HOME`/the real home
/// directory (env vars are process-global, which makes them awkward to
/// exercise safely under Rust's default parallel test execution).
fn daemon_file_path_under(home: &Path, root_dir: &str) -> PathBuf {
    home.join(".dispatch")
        .join("daemons")
        .join(format!("{}.json", daemon_file_key(root_dir)))
}

/// `DISPATCH_HOME` lets tests (and anything else) redirect daemon files away
/// from the real home directory — same override `daemonfile.ts` honors, so
/// setting it affects both the Bun daemon and this Rust client looking for
/// it. An empty string is treated the same as unset (falls back to the real
/// home directory) — kept in sync with four other copies of this exact
/// scheme: `packages/server/src/daemonfile.ts`'s `daemonHome()`,
/// `packages/cli/src/commands/daemon.ts`'s `daemonHome()`,
/// `packages/mcp/src/daemon.ts`'s `daemonHome()`, and `packages/server/src/
/// orchestrator/paths.ts`'s `dispatchHome()` (that last one keys run/
/// worktree state instead of daemon files, but reads the identical env var
/// with the identical fallback rule); update all five together if this
/// scheme ever changes.
pub(crate) fn daemon_home() -> PathBuf {
    match std::env::var("DISPATCH_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
    }
}

fn daemon_file_path(root_dir: &str) -> PathBuf {
    daemon_file_path_under(&daemon_home(), root_dir)
}

/// Path of the per-root log file dispatchd's stdout/stderr is tee'd to on
/// every spawn — `<daemon_home>/.dispatch/logs/<daemon-file-key>.log`, keyed
/// the same way as the daemon file itself so the two are easy to correlate.
/// Truncated on each spawn (see `forward_child_output`), so it always
/// reflects only the most recently spawned daemon for this root, not a
/// growing history across restarts.
fn daemon_log_path(root_dir: &str) -> PathBuf {
    daemon_home()
        .join(".dispatch")
        .join("logs")
        .join(format!("{}.log", daemon_file_key(root_dir)))
}

/// Pure parse half of `read_daemon_file`, taking an explicit path so tests
/// can point it at a fixture file instead of the real `$DISPATCH_HOME`.
fn read_daemon_file_at(path: &Path) -> Option<DaemonFileInfo> {
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn read_daemon_file(root_dir: &str) -> Option<DaemonFileInfo> {
    read_daemon_file_at(&daemon_file_path(root_dir))
}

/// Parses dispatchd's `/api/health` response body — just its `ok` flag.
/// Split out from the actual HTTP call so it's unit-testable without a
/// network.
#[cfg(test)]
fn parse_health_response(body: &str) -> Result<bool, String> {
    let parsed: HealthResponse =
        serde_json::from_str(body).map_err(|e| format!("invalid /api/health response: {e}"))?;
    Ok(parsed.ok)
}

/// Compatibility for wait loops: unknown never authorizes replacement.
fn pid_alive(pid: u32) -> bool {
    process_state(pid) != ProcessState::Dead
}

/// A health answer must describe exactly the generation that discovery named.
fn health_matches(root: &str, info: &DaemonFileInfo, health: &HealthResponse) -> bool {
    health.ok
        && info.root_dir == root
        && health.root_dir.as_deref() == Some(root)
        && health.pid == Some(info.pid)
        && health.started_at.as_deref() == Some(info.started_at.as_str())
        && health
            .identity
            .as_deref()
            .map_or(true, |identity| identity == "ok")
}

#[derive(Debug)]
enum DiscoveryState {
    Missing,
    Changed,
    Obsolete(DaemonFileInfo),
    Ready(DaemonFileInfo),
    Stalled(DaemonFileInfo),
    Down(DaemonFileInfo),
    Mismatch,
}

/// Never probe a proven obsolete snapshot. Re-read after classification and
/// after HTTP so neither a replacement file nor its credentials are inferred
/// from an old endpoint. Obsolescence belongs to a complete snapshot, not a PID.
async fn inspect_discovery(
    client: &reqwest::Client,
    root: &str,
    obsolete: &[DaemonFileInfo],
) -> DiscoveryState {
    inspect_with(
        || read_daemon_file(root),
        process_state,
        obsolete,
        |info| async move { probe_identity(client, root, &info).await },
    )
    .await
}

/// Injectable observation boundary for replacement-race and unknown-state tests.
async fn inspect_with<R, L, P, F>(
    mut read: R,
    liveness: L,
    obsolete: &[DaemonFileInfo],
    probe: P,
) -> DiscoveryState
where
    R: FnMut() -> Option<DaemonFileInfo>,
    L: FnOnce(u32) -> ProcessState,
    P: FnOnce(DaemonFileInfo) -> F,
    F: std::future::Future<Output = IdentityProbe>,
{
    let Some(info) = read() else {
        return DiscoveryState::Missing;
    };
    let state = liveness(info.pid);
    if read().as_ref() != Some(&info) {
        return DiscoveryState::Changed;
    }
    if state == ProcessState::Dead || obsolete.contains(&info) {
        return DiscoveryState::Obsolete(info);
    }
    let result = probe(info.clone()).await;
    if read().as_ref() != Some(&info) {
        return DiscoveryState::Changed;
    }
    match result {
        IdentityProbe::Ready => DiscoveryState::Ready(info),
        IdentityProbe::Stalled => DiscoveryState::Stalled(info),
        IdentityProbe::Down => DiscoveryState::Down(info),
        IdentityProbe::Mismatch => DiscoveryState::Mismatch,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum IdentityProbe {
    Ready,
    Stalled,
    Down,
    Mismatch,
}

/// Only an explicit local connection refusal proves the endpoint is absent.
/// Resets and other transport failures do not authorize spawning over live work.
fn connection_refused(mut error: &(dyn std::error::Error + 'static)) -> bool {
    loop {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            return true;
        }
        match error.source() {
            Some(source) => error = source,
            None => return false,
        }
    }
}

/// One full health request verifies root and generation; the safety timeout
/// remains two seconds for a live or unclassifiable process.
async fn probe_identity(
    client: &reqwest::Client,
    root: &str,
    info: &DaemonFileInfo,
) -> IdentityProbe {
    let response = match client
        .get(format!("http://127.0.0.1:{}/api/health", info.port))
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) if error.is_timeout() => return IdentityProbe::Stalled,
        Err(error) if connection_refused(&error) => return IdentityProbe::Down,
        Err(_) => return IdentityProbe::Stalled,
    };
    if !response.status().is_success() {
        return IdentityProbe::Mismatch;
    }
    match response.text().await {
        Ok(body) => match parse_health(&body) {
            Some(health) if health_matches(root, info, &health) => IdentityProbe::Ready,
            _ => IdentityProbe::Mismatch,
        },
        Err(error) if error.is_timeout() => IdentityProbe::Stalled,
        Err(_) => IdentityProbe::Mismatch,
    }
}

/// How long to keep polling a live-but-stalled daemon before giving up with
/// an error rather than spawning a second one.
const STALLED_DAEMON_WAIT: Duration = Duration::from_secs(30);

/// Parses readiness and the root/PID/start identity from one health response.
fn parse_health(body: &str) -> Option<HealthResponse> {
    serde_json::from_str(body).ok()
}

// ---------------------------------------------------------------------------
// dispatchd process management
// ---------------------------------------------------------------------------

/// Dev-only resolution of dispatchd's entry point: walks up from Cargo's own
/// manifest dir (`apps/desktop/src-tauri`) to the monorepo root — three
/// levels (`src-tauri` -> `desktop` -> `apps` -> repo root), not two — then
/// down into `packages/server/src/bin.ts`. Valid only when running from this
/// checkout — a packaged release never takes this path; it uses
/// `DaemonLaunch::Bundled` (see `commands.rs`'s `resolve_daemon_launch`).
#[cfg_attr(not(any(debug_assertions, test)), allow(dead_code))]
fn dispatchd_bin_path(manifest_dir: &Path) -> PathBuf {
    manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("server")
        .join("src")
        .join("bin.ts")
}

/// How to start dispatchd. A dev build runs the TypeScript entry through `bun`
/// straight from the monorepo checkout (hot, no build step); a packaged release
/// runs the standalone `bun build --compile`d binary directly and points it at
/// the equally-standalone bundled MCP binary (via `DISPATCH_MCP_BIN`), so a
/// shipped app needs neither `bun` on `PATH` nor the checkout on disk.
#[derive(Clone)]
pub enum DaemonLaunch {
    /// `bun <bin.ts> --root <root>` — the dev/`dispatch serve` path.
    BunScript(PathBuf),
    /// Run the compiled dispatchd binary directly, telling it where the
    /// compiled MCP binary lives so its executor spawns that instead of `bun`.
    // Only the release path in `commands.rs` (`cfg(not(debug_assertions))`) constructs this.
    #[cfg_attr(debug_assertions, allow(dead_code))]
    Bundled { dispatchd: PathBuf, mcp: PathBuf },
}

/// The dev launch, resolved from `CARGO_MANIFEST_DIR` (see `dispatchd_bin_path`).
/// Dead in a release build (which always uses `Bundled`), live in dev + tests.
#[cfg_attr(not(any(debug_assertions, test)), allow(dead_code))]
pub fn dev_launch(manifest_dir: &Path) -> DaemonLaunch {
    DaemonLaunch::BunScript(dispatchd_bin_path(manifest_dir))
}

/// Abstraction over spawning the dispatchd child process, so `ensure_dispatchd`'s
/// health-check/poll logic can be exercised in tests (e.g. "bun isn't
/// installed" surfacing as a clear error) without actually invoking `bun`.
/// `Send + Sync` because a `&dyn DaemonSpawner` is held across an `.await`
/// inside `ensure_dispatchd`, and Tauri's async commands require their
/// whole future to be `Send`.
pub trait DaemonSpawner: Send + Sync {
    /// `port` asks dispatchd to bind that port instead of an ephemeral one.
    fn spawn(&self, launch: &DaemonLaunch, root: &str, port: Option<u16>) -> Result<Child, String>;
}

/// dispatchd's arguments after the entry point: the root, `--init` for a root
/// with no tracker yet, and `--port` when a takeover keeps the old port.
fn daemon_args(root: &str, init: bool, port: Option<u16>) -> Vec<String> {
    let mut args = vec!["--root".to_string(), root.to_string()];
    if init {
        args.push("--init".to_string());
    }
    if let Some(port) = port {
        args.push("--port".to_string());
        args.push(port.to_string());
    }
    args
}

/// PATH for the spawned dispatchd child: the app's own PATH plus the standard
/// tool-install directories a Finder/Spotlight launch omits. The daemon shells
/// out to `gh` (PR capability/reviews/merge-queue) and `git`; with the
/// Finder-minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) a Homebrew-installed
/// `gh` is invisible, so a packaged app loses PR features that work fine from
/// a terminal launch. Appending (not prepending) keeps an explicitly
/// configured PATH's own ordering authoritative.
pub(crate) fn enriched_child_path() -> std::ffi::OsString {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").ok();
    std::ffi::OsString::from(enrich_path(&current, home.as_deref()))
}

/// Pure core of `enriched_child_path`, split out so tests can drive it with
/// explicit inputs instead of mutating process-global env vars (the same
/// parallel-safety convention as the registry/needs_init tests).
fn enrich_path(current: &str, home: Option<&str>) -> String {
    let mut parts: Vec<String> = current
        .split(':')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    let mut extras: Vec<String> = vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Some(home) = home {
        extras.push(format!("{home}/.bun/bin"));
        extras.push(format!("{home}/.local/bin"));
    }
    for extra in extras {
        if !parts.iter().any(|p| p == &extra) {
            parts.push(extra);
        }
    }
    parts.join(":")
}

/// Resolves the `bun` executable to an absolute path. A macOS app launched from
/// Finder/Spotlight inherits a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// that omits `~/.bun/bin`, so a bare `bun` fails to resolve in a packaged
/// release build — even though the same `bun` is right there for a terminal
/// launch. Probe the standard install locations first and fall back to bare
/// `bun` (found on `PATH`) for a terminal launch or a Linux host.
fn resolve_bun() -> std::ffi::OsString {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(Path::new(&home).join(".bun/bin/bun"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/bun"));
    candidates.push(PathBuf::from("/usr/local/bin/bun"));
    for candidate in candidates {
        if candidate.exists() {
            return candidate.into_os_string();
        }
    }
    std::ffi::OsString::from("bun")
}

/// Real spawner: `bun <bin_path> --root <root>`. Stdio is piped rather than
/// inherited/null so `forward_child_output` can surface dispatchd's own log
/// lines through Rust's `log` — the desktop app has no separate terminal
/// where `dispatch serve`'s output would otherwise be visible.
pub struct BunSpawner;

impl DaemonSpawner for BunSpawner {
    fn spawn(&self, launch: &DaemonLaunch, root: &str, port: Option<u16>) -> Result<Child, String> {
        // A project added through the desktop's onboarding flow (a fresh folder,
        // or a just-cloned GitHub repo) may have no `.dispatch/tasks` tracker
        // yet. Passing `--init` tells dispatchd (via bin.ts's `--init` handling,
        // added in Task 7) to run `TaskStore.init` before serving, so the very
        // first daemon spawn for such a root creates the tracker instead of
        // erroring out. Harmless for an already-initialized root — bin.ts only
        // initializes when `.dispatch/tasks` is missing.
        let args = daemon_args(root, needs_init(root), port);
        let mut command = match launch {
            // Dev: `bun <bin.ts> --root <root>`, with the fake executor toggle.
            DaemonLaunch::BunScript(bin_path) => {
                let mut c = Command::new(resolve_bun());
                c.arg(bin_path).args(&args);
                // Phase 7: `DISPATCH_ENABLE_FAKES=1` makes dispatchd register a
                // FakeExecutor/FakePlanner alongside the real ones (see
                // packages/server/src/bin.ts) — set only in debug builds so the
                // Tasks tab's hidden "dispatch with the fake executor" dev
                // toggle works, while a release never registers fakes.
                #[cfg(debug_assertions)]
                c.env("DISPATCH_ENABLE_FAKES", "1");
                c
            }
            // Release: run the compiled dispatchd directly, and tell it where
            // the compiled MCP binary is so its executor runs that rather than
            // shelling out to `bun` (see buildDispatchMcpServerConfig).
            DaemonLaunch::Bundled { dispatchd, mcp } => {
                let mut c = Command::new(dispatchd);
                c.args(&args).env("DISPATCH_MCP_BIN", mcp);
                c
            }
        };
        command
            .env("PATH", enriched_child_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.spawn().map_err(|e| match launch {
            // Only the BunScript path actually depends on `bun` resolving — the
            // Bundled path runs the compiled binary directly, so pointing a user
            // at bun.sh for a bundled-binary spawn failure would be misleading.
            DaemonLaunch::BunScript(_) => {
                format!("failed to spawn dispatchd: {e} — is bun installed? https://bun.sh")
            }
            DaemonLaunch::Bundled { dispatchd, .. } => {
                format!(
                    "failed to spawn bundled dispatchd ({}): {e}",
                    dispatchd.display()
                )
            }
        })
    }
}

/// Describes which launch path was used, for embedding in error messages so a
/// user (or us, reading a bug report) can immediately tell whether a packaged
/// release took the bundled-binary path or a dev build shelled out to `bun` —
/// the two have entirely different failure modes. Only the `BunScript` case
/// mentions `bun`/bun.sh, since a bundled release binary never touches `bun`.
fn describe_launch(launch: &DaemonLaunch) -> String {
    match launch {
        DaemonLaunch::BunScript(bin_path) => format!(
            "launch: bun {} — is bun installed? https://bun.sh",
            bin_path.display()
        ),
        DaemonLaunch::Bundled { dispatchd, .. } => {
            format!("launch: bundled {}", dispatchd.display())
        }
    }
}

/// Cap on how many of the child's most recent stdout/stderr lines are kept in
/// memory (see `OutputTail`) for quoting in a health-wait timeout error —
/// enough to show a crash-on-boot's actual error without unbounded memory
/// growth over a long-lived daemon that never times out.
const OUTPUT_TAIL_LINES: usize = 30;

/// Shared ring buffer of a spawned dispatchd's recent stdout/stderr lines.
/// `forward_child_output` appends to it as lines arrive; `ensure_dispatchd`
/// reads it if the health-wait poll times out, so the returned error can
/// include what the daemon actually said instead of just the generic
/// timeout message (previously the failure this whole file's Bug A report
/// was about: the real error was only ever visible in the app's own log).
type OutputTail = Arc<Mutex<VecDeque<String>>>;

/// Appends `line` to the ring buffer (evicting the oldest entry once it's at
/// `OUTPUT_TAIL_LINES` capacity) and, if the per-root log file opened
/// successfully, to that file too. Shared by the stdout and stderr
/// forwarding threads in `forward_child_output`.
fn record_output_line(tail: &OutputTail, log_file: &Option<Arc<Mutex<std::fs::File>>>, line: &str) {
    {
        let mut buf = tail.lock().unwrap();
        if buf.len() >= OUTPUT_TAIL_LINES {
            buf.pop_front();
        }
        buf.push_back(line.to_string());
    }
    if let Some(file) = log_file {
        let mut f = file.lock().unwrap();
        // Best-effort: a failed write to the log file shouldn't take down
        // output forwarding, and there's nowhere better to report it from a
        // background thread than swallowing it here.
        let _ = writeln!(f, "{line}");
    }
}

/// The exact prefix `packages/server/src/bin.ts` prints the app token behind,
/// once, on its own line. Treated as the machine-readable contract between the
/// daemon and this app.
const APP_TOKEN_PREFIX: &str = "DISPATCH_APP_TOKEN=";

/// Matches `^DISPATCH_APP_TOKEN=(.+)$` and returns the token. A trailing `\r`
/// is stripped so a CRLF-terminated line still yields a clean value, and an
/// empty value is rejected so a bare prefix never registers as a credential.
fn parse_app_token_line(line: &str) -> Option<&str> {
    let token = line.strip_prefix(APP_TOKEN_PREFIX)?.trim_end_matches('\r');
    (!token.is_empty()).then_some(token)
}

/// In-memory holder for the app token captured off a spawned daemon's stdout.
type AppTokenSlot = Arc<Mutex<Option<String>>>;

/// Handles one line of child output. The app-token line is captured into
/// `app_token` and swallowed — it must not reach `log`, the ring buffer that
/// gets quoted into timeout errors, or the on-disk daemon log, all three of
/// which would put a decide-tier credential at rest somewhere an agent already
/// reads. Every other line is forwarded and recorded unchanged.
fn handle_output_line(
    line: &str,
    from_stderr: bool,
    app_token: &AppTokenSlot,
    tail: &OutputTail,
    log_file: &Option<Arc<Mutex<std::fs::File>>>,
) {
    if let Some(token) = parse_app_token_line(line) {
        *app_token.lock().unwrap() = Some(token.to_string());
        log::info!("dispatchd: captured the app token from stdout (value withheld)");
        return;
    }
    if from_stderr {
        log::warn!("dispatchd: {line}");
    } else {
        log::info!("dispatchd: {line}");
    }
    record_output_line(tail, log_file, line);
}

/// Spawns background threads that forward a child process's stdout/stderr
/// lines into Rust's `log` (prefixed so they're identifiable among the app's
/// own log output — see `BunSpawner`'s doc comment for why this matters),
/// while also recording each line into `tail` (for a timeout error to quote)
/// and tee-ing it to `log_path` so a user can inspect the daemon's own output
/// after the fact, without needing to reproduce a failure live. `log_path` is
/// truncated up front so each new spawn starts a fresh log rather than
/// accumulating output across restarts. The one line that does *not* take that
/// route is the app token — see `handle_output_line`.
fn forward_child_output(
    child: &mut Child,
    tail: OutputTail,
    log_path: PathBuf,
    app_token: AppTokenSlot,
) {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .ok()
        .map(|f| Arc::new(Mutex::new(f)));

    if let Some(stdout) = child.stdout.take() {
        let tail = Arc::clone(&tail);
        let log_file = log_file.clone();
        let app_token = Arc::clone(&app_token);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                handle_output_line(&line, false, &app_token, &tail, &log_file);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&tail);
        let log_file = log_file.clone();
        let app_token = Arc::clone(&app_token);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                handle_output_line(&line, true, &app_token, &tail, &log_file);
            }
        });
    }
}

/// Tauri-managed state tracking every dispatchd child this app instance has
/// spawned, so they can all be killed when the app exits — a spawned
/// dispatchd otherwise has no parent-death signal of its own and would keep
/// running as an orphan after the desktop app closes. Uses `Child::kill`
/// (a hard kill, not `SIGTERM`), so a killed dispatchd's on-disk daemon file
/// can be left behind stale. The next ensure classifies the process before
/// probing HTTP and skips that exact dead discovery generation. Parent-side
/// unlinking is unsafe: another daemon can replace the file during cleanup.
pub struct DispatchdChildren(pub Mutex<Vec<Child>>);

impl DispatchdChildren {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }

    /// Reaps (via `try_wait`, which both polls exit status and collects the
    /// exit code) any children that have already exited on their own, then
    /// drops them from the vector. A dispatchd that self-exits — e.g. it
    /// crashed, or `ensure_dispatchd` replaced it with a fresh spawn after
    /// its daemon file went unhealthy — otherwise sits in this vector,
    /// unreaped, for the rest of the app's session: an OS-level zombie
    /// process until `kill_all` finally runs at exit.
    fn prune_exited(children: &mut Vec<Child>) {
        children.retain_mut(|child| match child.try_wait() {
            // Exited; try_wait() already reaped it, so just drop it here.
            Ok(Some(_status)) => false,
            // Still running: keep tracking it.
            Ok(None) => true,
            // Couldn't determine status; err on the side of still tracking it
            // rather than leaking a possibly-live child out of the vector.
            Err(_) => true,
        });
    }

    /// Tracks a freshly spawned dispatchd child, first pruning any children
    /// that have already exited so the vector doesn't grow unbounded across
    /// a long desktop-app session that ends up spawning several dispatchd
    /// sidecars (one per project root touched, plus any replaced after going
    /// unhealthy).
    pub fn push(&self, child: Child) {
        let mut children = self.0.lock().unwrap();
        Self::prune_exited(&mut children);
        children.push(child);
    }

    /// Kills and reaps every tracked child. Best-effort: a child that
    /// already exited on its own just fails `kill`/`wait` here, which is
    /// fine to ignore — the goal ("nothing left running") already holds.
    /// Prunes first purely so already-exited children are reaped through the
    /// same `try_wait` path as `push` rather than the `kill`+`wait` fallback,
    /// which is harmless either way but keeps the two code paths consistent.
    pub fn kill_all(&self) {
        let mut children = self.0.lock().unwrap();
        Self::prune_exited(&mut children);
        for child in children.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        children.clear();
    }
}

impl Default for DispatchdChildren {
    fn default() -> Self {
        Self::new()
    }
}

/// App tokens captured from daemons *this app instance spawned*, keyed by
/// project root and stamped with the complete discovery snapshot that produced them. Memory only, for
/// the app's lifetime — nothing here is ever written anywhere.
///
/// It exists because `ensure_dispatchd` is called repeatedly for the same root
/// (project switches, retries, remounts) and every call after the first takes
/// the attach fast path, which has no stdout to read. Without this, the app
/// would silently drop to request tier moments after spawning the daemon that
/// handed it the token.
pub struct SpawnedAppTokens(Mutex<HashMap<String, (DaemonFileInfo, String)>>);

impl SpawnedAppTokens {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    fn remember(&self, root: &str, info: &DaemonFileInfo, token: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(root.to_string(), (info.clone(), token.to_string()));
    }

    /// The remembered token for `root`, but only for the identical discovery
    /// generation. PID reuse, a changed port, timestamp or request credential
    /// invalidates the app authority retained from the old child.
    fn get(&self, root: &str, info: &DaemonFileInfo) -> Option<String> {
        let map = self.0.lock().unwrap();
        let (remembered_info, token) = map.get(root)?;
        (remembered_info == info).then(|| token.clone())
    }
}

impl Default for SpawnedAppTokens {
    fn default() -> Self {
        Self::new()
    }
}

// 15s, not 5s: a just-installed notarized release binary can pay Gatekeeper
// or AV-scan latency on its very first launch (macOS re-verifying the
// signature/notarization before it's allowed to execute at all), which can
// blow well past a 5s budget even though the binary itself boots in well
// under a second once that one-time check clears. POLL_INTERVAL stays as-is
// since it only controls how often we recheck, not the overall budget.
const POLL_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Pure formatting half of the health-wait timeout error, split out from
/// `ensure_dispatchd` so it's unit-testable without actually spawning a
/// child process. `launch_desc` names which launch path was used (see
/// `describe_launch` — it also carries the bun.sh hint when relevant),
/// `lines` is the ring-buffer tail of the child's recent stdout/stderr
/// (`OutputTail`, already unlocked and cloned by the caller), and `log_path`
/// is where the full per-root log was tee'd to, for self-diagnosis after the
/// fact. This is the fix for Bug A: previously the only error the caller saw
/// was the generic "did not become healthy" message, with the daemon's own
/// explanation of what went wrong swallowed into the app's log.
fn format_timeout_error(
    timeout: Duration,
    launch_desc: &str,
    lines: &[String],
    log_path: &Path,
) -> String {
    let tail = if lines.is_empty() {
        "(no output)".to_string()
    } else {
        lines.join("\n")
    };
    format!(
        "dispatchd did not become healthy within {}s ({}). Full log: {}. Recent daemon output:\n{tail}",
        timeout.as_secs(),
        launch_desc,
        log_path.display(),
    )
}

/// Polls the daemon file + its `/api/health` for up to `timeout`, for the
/// case where a fresh dispatchd was just spawned and needs time to finish
/// booting (bind its port, write its daemon file, answer health checks).
/// Mirrors `daemon.ts`'s `waitForHealthyDaemon`.
#[cfg(test)]
async fn poll_for_healthy_daemon(
    client: &reqwest::Client,
    root: &str,
    timeout: Duration,
) -> Option<u16> {
    let deadline = Instant::now() + timeout;
    loop {
        if let DiscoveryState::Ready(info) = inspect_discovery(client, root, &[]).await {
            return Some(info.port);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// How long to wait, after a freshly spawned daemon reports healthy, for its
/// `DISPATCH_APP_TOKEN=` line to arrive on stdout. The daemon writes its daemon
/// file (which is what health polling finds) *before* printing the token, so
/// the two can land out of order by a few milliseconds; this is the slack for
/// that, not a real expectation of delay.
const APP_TOKEN_WAIT: Duration = Duration::from_secs(3);

/// Polls the in-memory slot `forward_child_output` fills until the app token
/// shows up or `timeout` elapses. `None` means the daemon never printed one.
async fn wait_for_app_token(slot: &AppTokenSlot, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(token) = slot.lock().unwrap().clone() {
            return Some(token);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Returns a healthy dispatchd connection for `root`: the fast path reuses an
/// already-running daemon (found via its daemon file + a passing health
/// check); otherwise spawns a fresh one through `spawner` and polls until
/// it's healthy or `POLL_TIMEOUT` elapses. `children` collects every process
/// this call spawns, for the caller to track for kill-on-exit.
///
/// The returned `app_token` is present only on a spawn (or a re-attach to a
/// daemon this app spawned earlier — see `SpawnedAppTokens`). Attaching to a
/// daemon someone else started yields request tier only; there is deliberately
/// no disk fallback for the app token.
///
/// `force_spawn` skips the reuse fast path, for the user-initiated restart that
/// upgrades an attached (request-tier) session to a spawned (decide-tier) one:
/// see `stop_verified_daemon` for when it refuses, and it keeps the old port when
/// it can so other clients reconnect.
pub async fn ensure_dispatchd(
    spawner: &dyn DaemonSpawner,
    children: &DispatchdChildren,
    app_tokens: &SpawnedAppTokens,
    launch: DaemonLaunch,
    root: &str,
    force_spawn: bool,
) -> Result<DaemonConnection, String> {
    let root = normalize_root(root)?;
    let root = root.as_str();
    let client = reqwest::Client::new();

    // Onboarding still needs a fresh --init daemon. Validate any existing
    // generation first, then use the same guarded shutdown as explicit restart.
    let attach = |info: DaemonFileInfo| DaemonConnection {
        port: info.port,
        app_token: app_tokens.get(root, &info),
        agent_token: info.agent_token,
        background: is_background(&info.background),
    };
    let mut obsolete = Vec::new();
    let mut port_choice = None;
    let deadline = Instant::now() + STALLED_DAEMON_WAIT;
    let mut stalled: Option<DaemonFileInfo> = None;
    loop {
        match inspect_discovery(&client, root, &obsolete).await {
            DiscoveryState::Changed => {
                if Instant::now() >= deadline { return Err("Daemon discovery kept changing; retry once it settles.".into()); }
                continue;
            }
            DiscoveryState::Mismatch => return Err("Daemon discovery does not match the endpoint's root or generation; it was left alone.".into()),
            DiscoveryState::Stalled(info) => {
                stalled = Some(info.clone());
                if Instant::now() >= deadline {
                    return Err(format!("dispatchd for this project (pid {}, port {}) is running but has not answered a health check in {}s — it is probably overloaded. Wait and retry; a second daemon would force-fail its runs.", info.pid, info.port, STALLED_DAEMON_WAIT.as_secs()));
                }
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            DiscoveryState::Ready(info) => {
                if !force_spawn && !needs_init(root) && !is_background(&info.background) {
                    return Ok(attach(info));
                }
                match stop_verified_daemon(&client, children, root, &info, force_spawn || needs_init(root)).await {
                    Ok(Some(port)) => { port_choice = Some(port); obsolete.push(info); continue; }
                    Ok(None) => continue,
                    Err(error) if !force_spawn && !needs_init(root) => {
                        // The same verified generation may still be busy/parked.
                        // Never attach a replacement based on its predecessor's probe.
                        if read_daemon_file(root).as_ref() == Some(&info) { return Ok(attach(info)); }
                        log::debug!("discovery changed during background takeover: {error}");
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            DiscoveryState::Obsolete(info) => {
                if !obsolete.contains(&info) { obsolete.push(info.clone()); }
                if read_daemon_file(root).as_ref() != Some(&info) { continue; }
            }
            DiscoveryState::Down(info) => {
                // Refused connections retain the old recovery behavior. A
                // timeout is Stalled, including when process state is unknown.
                if read_daemon_file(root).as_ref() != Some(&info) { continue; }
            }
            DiscoveryState::Missing => {
                if read_daemon_file(root).is_some() { continue; }
            }
        }
        if let Some(prior) = &stalled {
            if process_state(prior.pid) != ProcessState::Dead {
                if Instant::now() >= deadline {
                    return Err(
                        "The stalled daemon did not recover before its grace period elapsed."
                            .into(),
                    );
                }
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        }
        break;
    }

    loop {
        let log_path = daemon_log_path(root);
        let tail: OutputTail = Arc::new(Mutex::new(VecDeque::with_capacity(OUTPUT_TAIL_LINES)));
        let app_token_slot: AppTokenSlot = Arc::new(Mutex::new(None));
        let mut child = spawner.spawn(&launch, root, port_choice)?;
        let spawned_pid = child.id();
        forward_child_output(
            &mut child,
            Arc::clone(&tail),
            log_path.clone(),
            Arc::clone(&app_token_slot),
        );
        let outcome =
            wait_for_generation(&client, root, &mut child, &mut obsolete, POLL_TIMEOUT).await;
        let child_running = matches!(child.try_wait(), Ok(None));
        children.push(child);
        let mut info = match outcome {
            GenerationOutcome::Ready(info) => info,
            GenerationOutcome::Exited if port_choice.is_some() => {
                port_choice = None;
                continue;
            }
            GenerationOutcome::Exited | GenerationOutcome::TimedOut => {
                let lines = tail.lock().unwrap().iter().cloned().collect::<Vec<_>>();
                return Err(format_timeout_error(
                    POLL_TIMEOUT,
                    &describe_launch(&launch),
                    &lines,
                    &log_path,
                ));
            }
        };
        let mut app_token = if child_running && info.pid == spawned_pid {
            wait_for_app_token(&app_token_slot, APP_TOKEN_WAIT).await
        } else {
            None
        };
        // Token arrival is asynchronous: revalidate the complete snapshot after
        // that await before returning any credentials or caching app authority.
        let credential_deadline = Instant::now() + POLL_TIMEOUT;
        while read_daemon_file(root).as_ref() != Some(&info) {
            app_token = None;
            match inspect_discovery(&client, root, &obsolete).await {
                DiscoveryState::Ready(winner) => {
                    info = winner;
                    app_token = app_tokens.get(root, &info);
                }
                DiscoveryState::Mismatch => {
                    return Err(
                        "Replacement discovery does not match its endpoint; it was left alone."
                            .into(),
                    )
                }
                _ => {
                    if Instant::now() >= credential_deadline {
                        return Err(
                            "No stable daemon generation appeared while acquiring credentials."
                                .into(),
                        );
                    }
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
            }
        }
        if let Some(token) = &app_token {
            app_tokens.remember(root, &info, token);
        }
        return Ok(DaemonConnection {
            port: info.port,
            app_token,
            agent_token: info.agent_token,
            background: is_background(&info.background),
        });
    }
}

#[derive(Debug)]
enum GenerationOutcome {
    Ready(DaemonFileInfo),
    Exited,
    TimedOut,
}

/// Poll fresh snapshots, skipping only generations proven dead or stopped in
/// this ensure operation. A competing verified winner is valid request-tier reuse.
async fn wait_for_generation(
    client: &reqwest::Client,
    root: &str,
    child: &mut Child,
    obsolete: &mut Vec<DaemonFileInfo>,
    timeout: Duration,
) -> GenerationOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        match inspect_discovery(client, root, obsolete).await {
            DiscoveryState::Ready(info) => return GenerationOutcome::Ready(info),
            DiscoveryState::Obsolete(info) if !obsolete.contains(&info) => {
                obsolete.push(info);
            }
            _ => {}
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            return GenerationOutcome::Exited;
        }
        if Instant::now() >= deadline {
            return GenerationOutcome::TimedOut;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// How a freshly spawned dispatchd's boot ended.
#[derive(Debug, PartialEq, Eq)]
#[cfg(test)]
enum SpawnOutcome {
    Healthy(u16),
    /// The child exited before any daemon answered for this root.
    Exited,
    TimedOut,
}

/// `poll_for_healthy_daemon`, but also watching the child so a boot that dies
/// (a taken port) is seen at once. `ignore_pid` skips a daemon file still
/// naming the daemon a takeover just stopped.
#[cfg(test)]
async fn wait_for_spawned_daemon(
    client: &reqwest::Client,
    root: &str,
    child: &mut Child,
    ignore_pid: Option<u32>,
    timeout: Duration,
) -> SpawnOutcome {
    let mut obsolete = read_daemon_file(root)
        .filter(|i| Some(i.pid) == ignore_pid)
        .into_iter()
        .collect();
    match wait_for_generation(client, root, child, &mut obsolete, timeout).await {
        GenerationOutcome::Ready(info) => SpawnOutcome::Healthy(info.port),
        GenerationOutcome::Exited => SpawnOutcome::Exited,
        GenerationOutcome::TimedOut => SpawnOutcome::TimedOut,
    }
}

/// How long a stopped daemon gets to shut down before a takeover gives up.
const STOP_WAIT: Duration = Duration::from_secs(15);

/// `GET /api/live-work`: `busy` is what stopping the daemon would cut short;
/// `parked` runs (waiting on a human) resume after a restart, so only an
/// unasked takeover holds back for them.
#[derive(Debug, Deserialize, PartialEq)]
struct LiveWork {
    busy: Vec<String>,
    #[serde(default)]
    parked: u32,
}

fn parse_live_work(body: &str) -> Result<LiveWork, String> {
    serde_json::from_str::<LiveWork>(body)
        .map_err(|e| format!("invalid /api/live-work response: {e}"))
}

/// Why a takeover is refused while the daemon has work in flight, or `None`.
/// Parked runs block only an unasked takeover, since the user never confirmed.
fn live_work_refusal(live: &LiveWork, allow_parked: bool) -> Option<String> {
    if !live.busy.is_empty() {
        return Some(format!(
            "Dispatch for this project is busy with {}. Restarting it from this app would stop that, so try again once it finishes.",
            live.busy.join(", ")
        ));
    }
    (!allow_parked && live.parked > 0).then(|| {
        format!(
            "{} run(s) are waiting on you; restart from this app to resume them.",
            live.parked
        )
    })
}

/// Asks the daemon what it is running, with the agent token its file carries.
async fn fetch_live_work(
    client: &reqwest::Client,
    info: &DaemonFileInfo,
) -> Result<LiveWork, String> {
    let mut request = client
        .get(format!("http://127.0.0.1:{}/api/live-work", info.port))
        .timeout(Duration::from_secs(5));
    if let Some(token) = &info.agent_token {
        request = request.bearer_auth(token);
    }
    let unreachable = |detail: String| {
        format!(
            "Couldn't ask Dispatch for this project (pid {}) what it is running ({detail}), so it was left alone.",
            info.pid
        )
    };
    let response = request
        .send()
        .await
        .map_err(|e| unreachable(e.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "Dispatch for this project (pid {pid}) is too old to say what it is running, so this app won't stop it. Once nothing is in flight, stop it yourself (kill {pid}) and try again.",
            pid = info.pid
        ));
    }
    if !status.is_success() {
        return Err(unreachable(format!("HTTP {status}")));
    }
    let body = response
        .text()
        .await
        .map_err(|e| unreachable(e.to_string()))?;
    parse_live_work(&body).map_err(unreachable)
}

/// Polls until `pid` is gone or `timeout` elapses; true once it is gone.
async fn wait_for_exit(children: &DispatchdChildren, pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        DispatchdChildren::prune_exited(&mut children.0.lock().unwrap());
        if !pid_alive(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Stops the daemon `info` names so this app can spawn its own in its place,
/// refusing while it has anything in flight (the check `team start` makes
/// before its own restart). `Ok(Some(port))` is the port it freed; `Ok(None)`
/// means nothing live was serving this root. Not `--replace`: that only lets a
/// second daemon start beside the first, whose runs would keep going unseen.
/// The authenticated daemon shutdown repeats busy/parked checks atomically on
/// its own event loop, avoiding PID-reuse kills and work starting after our GET.
async fn stop_verified_daemon(
    client: &reqwest::Client,
    children: &DispatchdChildren,
    root: &str,
    info: &DaemonFileInfo,
    allow_parked: bool,
) -> Result<Option<u16>, String> {
    if let Some(refusal) = live_work_refusal(&fetch_live_work(client, info).await?, allow_parked) {
        return Err(refusal);
    }
    if read_daemon_file(root).as_ref() != Some(info) {
        return Ok(None);
    }
    let token = info
        .agent_token
        .as_ref()
        .ok_or("Daemon has no request credential; it was left alone.")?;
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/api/daemon/shutdown",
            info.port
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({"parked": allow_parked}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Daemon shutdown failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Daemon refused shutdown: HTTP {}",
            response.status()
        ));
    }
    if !wait_for_exit(children, info.pid, STOP_WAIT).await {
        return Err("Daemon did not exit after agreeing to stop; it was left alone.".into());
    }
    // Graceful shutdown removes discovery itself. Hard exits remain recoverable
    // through the caller's obsolete snapshot; do not unlink a replacement file.
    Ok(Some(info.port))
}

/// True once the daemon file no longer names `old_pid`.
#[cfg(test)]
fn daemon_file_released(info: Option<&DaemonFileInfo>, old_pid: u32) -> bool {
    info.map(|i| i.pid) != Some(old_pid)
}

/// True if `root` looks like a Dispatch project — i.e. it has a `.dispatch/`
/// directory. Purely a filesystem check (no daemon involved); gates whether
/// `ProjectDetail` shows a Tasks tab at all before ever calling
/// `ensure_dispatchd`.
pub fn has_dispatch(root: &str) -> bool {
    Path::new(root).join(".dispatch").is_dir()
}

/// True when `root` has no usable Dispatch state yet — the signal
/// `BunSpawner::spawn` uses to decide whether to pass dispatchd `--init`, and
/// (more consequentially) the signal `ensure_dispatchd` uses to decide whether
/// it may reuse an already-running daemon.
///
/// Both backends count as initialized, which is the whole point. Testing only
/// for `.dispatch/tasks` made this permanently true for every database-backed
/// project — they have no tasks directory and never will — so the reuse fast
/// path was skipped on every single launch, and the code below it killed the
/// perfectly healthy daemon and respawned it. For a project whose runs live in
/// that daemon, that force-fails whatever was in flight, every time the app
/// starts.
///
/// `dispatch.db` presence is the database-side signal rather than the
/// `storage.json` marker, and deliberately so: the marker without a database
/// beside it is exactly the freshly-cloned state that DOES still need
/// `--init`, so that the daemon creates the database and its boot-time import
/// can repopulate it. Keying on the marker would skip init there and serve an
/// empty board. Mirrors bin.ts's `--init` handling on the daemon side.
fn needs_init(root: &str) -> bool {
    let dispatch = Path::new(root).join(".dispatch");
    // File backend: the markdown tracker is present.
    if dispatch.join("tasks").is_dir() {
        return false;
    }
    // Database backend: the daemon's database already exists.
    if dispatch.join("dispatch.db").is_file() {
        return false;
    }
    true
}

/// Normalizes `root` before it's hashed into a daemon-file key or handed to
/// the spawner. `packages/server/src/bin.ts` resolves `--root` with Node's
/// `path.resolve` before this same rootDir is hashed on the TS side
/// (`daemonfile.ts`'s `daemonFileKey`) — that resolution both requires an
/// absolute path and strips trailing slashes. Without the same normalization
/// here, a caller passing `/project/` and one passing `/project` hash to two
/// different daemon files and each ends up polling (and potentially
/// spawning) its own dispatchd for what is really one project root — e.g.
/// `9006acb0ea0b` vs `7236b3b9dccb` for the same directory. Bare `/` is left
/// as `/` rather than becoming empty.
pub(crate) fn normalize_root(root: &str) -> Result<String, String> {
    if !Path::new(root).is_absolute() {
        return Err(format!(
            "dispatchd root must be an absolute path, got: {root:?}"
        ));
    }
    let trimmed = root.trim_end_matches('/');
    Ok(if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn enrich_path_appends_missing_tool_dirs_without_reordering() {
        let result = enrich_path("/usr/bin:/bin", Some("/Users/x"));
        assert_eq!(
            result,
            "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.bun/bin:/Users/x/.local/bin"
        );
    }

    #[test]
    fn enrich_path_never_duplicates_an_already_present_dir() {
        let result = enrich_path("/opt/homebrew/bin:/usr/bin", None);
        assert_eq!(result, "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
    }

    #[test]
    fn enrich_path_tolerates_an_empty_path() {
        let result = enrich_path("", None);
        assert_eq!(result, "/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn daemon_file_key_matches_the_documented_hash_scheme() {
        // Same fixture packages/cli/test/daemon-cmd.test.ts cross-checks against —
        // equivalent to `printf '%s' /tmp/dispatch-fixture-root | shasum -a 256`,
        // first 12 hex chars.
        assert_eq!(
            daemon_file_key("/tmp/dispatch-fixture-root"),
            "3970f3cf1c5c"
        );
    }

    #[test]
    fn daemon_file_path_under_places_the_file_under_home_dispatch_daemons() {
        let home = Path::new("/fake/home");
        let path = daemon_file_path_under(home, "/tmp/dispatch-fixture-root");
        assert_eq!(
            path,
            Path::new("/fake/home/.dispatch/daemons/3970f3cf1c5c.json")
        );
    }

    #[test]
    fn dispatchd_bin_path_walks_up_three_levels_into_packages_server() {
        let manifest_dir = Path::new("/repo/apps/desktop/src-tauri");
        let result = dispatchd_bin_path(manifest_dir);
        assert_eq!(
            result,
            Path::new("/repo/apps/desktop/src-tauri/../../../packages/server/src/bin.ts")
        );
    }

    /// Same walk, but against the *real* `CARGO_MANIFEST_DIR` for this crate
    /// (`apps/desktop/src-tauri` in this actual checkout) — unlike the fictional-path test
    /// above, this can `canonicalize()` the result, so it catches an off-by-one in the
    /// `..` count against the real repo layout (exactly the bug this test was added to
    /// catch: an earlier version of `dispatchd_bin_path` used two `..` instead of three,
    /// landing one directory short of the repo root).
    #[test]
    fn dispatchd_bin_path_resolves_to_a_real_file_in_this_checkout() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let result = dispatchd_bin_path(manifest_dir);
        let resolved = result
            .canonicalize()
            .expect("packages/server/src/bin.ts should exist in this checkout");
        assert!(resolved.ends_with("packages/server/src/bin.ts"));
    }

    #[test]
    fn parse_health_response_reads_the_ok_flag() {
        assert_eq!(
            parse_health_response(r#"{"ok":true,"version":"0.0.1","rootDir":"/x"}"#),
            Ok(true)
        );
        assert_eq!(
            parse_health_response(r#"{"ok":false,"version":"0.0.1"}"#),
            Ok(false)
        );
    }

    #[test]
    fn parse_health_response_rejects_malformed_json() {
        assert!(parse_health_response("not json").is_err());
    }

    #[test]
    fn parse_health_reads_both_ok_and_root_dir_from_one_body() {
        let health = parse_health(r#"{"ok":true,"version":"0.0.1","rootDir":"/x"}"#)
            .expect("valid health body should parse");
        assert!(health.ok);
        assert_eq!(health.root_dir, Some("/x".to_string()));
    }

    #[test]
    fn parse_health_root_dir_is_none_when_the_field_is_absent() {
        let health = parse_health(r#"{"ok":true}"#).expect("valid health body should parse");
        assert_eq!(health.root_dir, None);
    }

    #[test]
    fn parse_health_is_none_for_malformed_json() {
        assert!(parse_health("not json").is_none());
    }

    #[test]
    fn read_daemon_file_at_deserializes_the_camelcase_json_bun_writes() {
        let dir =
            std::env::temp_dir().join(format!("dispatch-sidecar-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.json");
        fs::write(
            &path,
            r#"{"port":4771,"pid":123,"rootDir":"/tmp/x","startedAt":"2026-07-20T00:00:00.000Z"}"#,
        )
        .unwrap();

        let info = read_daemon_file_at(&path).expect("should parse");
        assert_eq!(info.port, 4771);
        assert_eq!(info.pid, 123);
        assert_eq!(info.root_dir, "/tmp/x");
        assert_eq!(info.agent_token, None);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_daemon_file_at_reads_the_agent_token_when_present() {
        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-agent-token-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.json");
        fs::write(
            &path,
            r#"{"port":4771,"pid":123,"rootDir":"/tmp/x","startedAt":"2026-07-20T00:00:00.000Z","agentToken":"a1b2c3"}"#,
        )
        .unwrap();

        let info = read_daemon_file_at(&path).expect("should parse");
        assert_eq!(info.agent_token.as_deref(), Some("a1b2c3"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_daemon_file_at_returns_none_for_a_missing_file() {
        assert!(read_daemon_file_at(Path::new("/nonexistent/daemon.json")).is_none());
    }

    #[test]
    fn normalize_root_strips_a_trailing_slash() {
        assert_eq!(
            normalize_root("/tmp/dispatch-fixture-root/"),
            Ok("/tmp/dispatch-fixture-root".to_string())
        );
    }

    #[test]
    fn normalize_root_strips_multiple_trailing_slashes() {
        assert_eq!(
            normalize_root("/tmp/dispatch-fixture-root///"),
            Ok("/tmp/dispatch-fixture-root".to_string())
        );
    }

    #[test]
    fn normalize_root_is_a_no_op_without_a_trailing_slash() {
        assert_eq!(
            normalize_root("/tmp/dispatch-fixture-root"),
            Ok("/tmp/dispatch-fixture-root".to_string())
        );
    }

    #[test]
    fn normalize_root_keeps_bare_root_slash_intact() {
        assert_eq!(normalize_root("/"), Ok("/".to_string()));
        assert_eq!(normalize_root("///"), Ok("/".to_string()));
    }

    #[test]
    fn normalize_root_rejects_a_relative_path() {
        assert!(normalize_root("relative/path").is_err());
        assert!(normalize_root("./foo").is_err());
    }

    #[test]
    fn normalize_root_makes_a_trailing_slash_root_hash_identically_to_without_one() {
        // This is the exact regression the reviewer demonstrated: a trailing-slash root
        // used to hash to a different daemon file (e.g. 9006acb0ea0b vs 7236b3b9dccb for
        // the same directory), so it polled the wrong daemon file forever.
        let with_slash = normalize_root("/tmp/dispatch-fixture-root/").unwrap();
        let without_slash = normalize_root("/tmp/dispatch-fixture-root").unwrap();
        assert_eq!(
            daemon_file_key(&with_slash),
            daemon_file_key(&without_slash)
        );
    }

    #[test]
    fn has_dispatch_true_only_when_dot_dispatch_dir_exists() {
        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-has-dispatch-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        assert!(!has_dispatch(dir.to_str().unwrap()));

        fs::create_dir_all(dir.join(".dispatch")).unwrap();
        assert!(has_dispatch(dir.to_str().unwrap()));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn needs_init_true_until_dot_dispatch_tasks_dir_exists() {
        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-needs-init-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        // No `.dispatch/` at all → needs init.
        assert!(needs_init(root));

        // `.dispatch/` present but no `tasks` subdir → still needs init.
        fs::create_dir_all(dir.join(".dispatch")).unwrap();
        assert!(needs_init(root));

        // `.dispatch/tasks/` present → already initialized.
        fs::create_dir_all(dir.join(".dispatch").join("tasks")).unwrap();
        assert!(!needs_init(root));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn needs_init_false_for_a_database_backed_project() {
        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-needs-init-db-{}",
            std::process::id()
        ));
        let dispatch = dir.join(".dispatch");
        fs::create_dir_all(&dispatch).unwrap();
        let root = dir.to_str().unwrap();

        // A database-backed project has no `.dispatch/tasks` and never will.
        // Reporting it as needing init skipped daemon reuse on every launch,
        // which killed the running daemon and force-failed its live runs.
        assert!(needs_init(root));
        fs::write(dispatch.join("dispatch.db"), b"").unwrap();
        assert!(!needs_init(root));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn needs_init_true_for_a_clone_with_a_marker_but_no_database() {
        // The clone trap: `storage.json` may arrive without the database it
        // names. That project DOES need `--init`, so the daemon creates the
        // database and its boot import can repopulate it.
        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-needs-init-clone-{}",
            std::process::id()
        ));
        let dispatch = dir.join(".dispatch");
        fs::create_dir_all(&dispatch).unwrap();
        let root = dir.to_str().unwrap();

        fs::write(dispatch.join("storage.json"), br#"{"backend":"sqlite"}"#).unwrap();
        assert!(needs_init(root));

        fs::remove_dir_all(&dir).unwrap();
    }

    /// A spawner that always fails, standing in for "bun isn't on PATH" — this is what
    /// makes `ensure_dispatchd`'s spawn path testable without actually invoking `bun`
    /// or a real dispatchd.
    struct FailingSpawner;

    impl DaemonSpawner for FailingSpawner {
        fn spawn(
            &self,
            _launch: &DaemonLaunch,
            _root: &str,
            _port: Option<u16>,
        ) -> Result<Child, String> {
            Err("bun: command not found".to_string())
        }
    }

    #[test]
    fn is_background_reads_only_a_true_flag() {
        assert!(is_background(&Some(serde_json::Value::Bool(true))));
        assert!(!is_background(&Some(serde_json::Value::Bool(false))));
        assert!(!is_background(&None));
        assert!(!is_background(&Some(serde_json::json!({ "by": "cli" }))));
    }

    #[test]
    fn read_daemon_file_at_tolerates_any_background_shape() {
        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-background-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.json");
        fs::write(
            &path,
            r#"{"port":4771,"pid":123,"rootDir":"/tmp/x","startedAt":"2026-07-20T00:00:00.000Z","background":true}"#,
        )
        .unwrap();
        assert!(is_background(
            &read_daemon_file_at(&path).unwrap().background
        ));
        fs::write(
            &path,
            r#"{"port":4771,"pid":123,"rootDir":"/tmp/x","startedAt":"2026-07-20T00:00:00.000Z","background":{"by":"cli"}}"#,
        )
        .unwrap();
        let info = read_daemon_file_at(&path).expect("an unknown shape still parses");
        assert!(!is_background(&info.background));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn daemon_args_adds_init_and_port_only_when_asked() {
        assert_eq!(daemon_args("/p", false, None), vec!["--root", "/p"]);
        assert_eq!(
            daemon_args("/p", true, Some(4771)),
            vec!["--root", "/p", "--init", "--port", "4771"]
        );
    }

    #[test]
    fn parse_live_work_reads_the_list_and_rejects_garbage() {
        assert_eq!(
            parse_live_work(r#"{"busy":["1 live run","2 terminals"],"parked":1,"waiting":3}"#),
            Ok(LiveWork {
                busy: vec!["1 live run".to_string(), "2 terminals".to_string()],
                parked: 1,
            })
        );
        assert_eq!(parse_live_work(r#"{"busy":[]}"#).map(|w| w.parked), Ok(0));
        assert!(parse_live_work("not json").is_err());
    }

    #[test]
    fn live_work_refusal_names_what_would_stop() {
        let idle = LiveWork {
            busy: vec![],
            parked: 0,
        };
        assert_eq!(live_work_refusal(&idle, false), None);
        let busy = LiveWork {
            busy: vec!["1 live run".to_string(), "1 browser".to_string()],
            parked: 0,
        };
        assert_eq!(
            live_work_refusal(&busy, true),
            Some("Dispatch for this project is busy with 1 live run, 1 browser. Restarting it from this app would stop that, so try again once it finishes.".to_string())
        );
    }

    #[test]
    fn live_work_refusal_holds_parked_runs_only_for_an_unasked_takeover() {
        let parked = LiveWork {
            busy: vec![],
            parked: 2,
        };
        assert_eq!(live_work_refusal(&parked, true), None);
        assert!(live_work_refusal(&parked, false).is_some());
    }

    /// A process that is not this test's child, so it never lingers as a
    fn file_info(port: u16, pid: u32, root: &str) -> DaemonFileInfo {
        DaemonFileInfo {
            port,
            pid,
            root_dir: root.into(),
            started_at: String::new(),
            agent_token: Some("agent".into()),
            background: None,
        }
    }

    #[test]
    fn daemon_file_released_once_it_is_gone_or_names_another_pid() {
        assert!(daemon_file_released(None, 7));
        assert!(daemon_file_released(Some(&file_info(1, 8, "/r")), 7));
        assert!(!daemon_file_released(Some(&file_info(1, 7, "/r")), 7));
    }

    #[tokio::test]
    async fn wait_for_spawned_daemon_sees_a_boot_that_died() {
        let mut child = Command::new("true").spawn().unwrap();
        let outcome = wait_for_spawned_daemon(
            &reqwest::Client::new(),
            "/tmp/dispatch-fixture-root-that-never-boots",
            &mut child,
            None,
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(outcome, SpawnOutcome::Exited);
    }

    #[tokio::test]
    async fn ensure_dispatchd_surfaces_a_spawn_failure_without_polling() {
        // No daemon file exists for this root, so ensure_dispatchd must fall through to
        // spawning — and FailingSpawner's error should come straight back out, not get
        // swallowed into the generic "did not become healthy" timeout message.
        let root = "/tmp/dispatch-fixture-root-never-has-a-daemon-file";
        let children = DispatchdChildren::new();
        let manifest_dir = Path::new("/repo/apps/desktop/src-tauri");

        let result = ensure_dispatchd(
            &FailingSpawner,
            &children,
            &SpawnedAppTokens::new(),
            dev_launch(manifest_dir),
            root,
            false,
        )
        .await;

        assert_eq!(result, Err("bun: command not found".to_string()));
        assert!(children.0.lock().unwrap().is_empty());
    }

    #[test]
    fn push_prunes_already_exited_children_before_appending() {
        let children = DispatchdChildren::new();

        // A child that exits (almost) immediately.
        let short_lived = Command::new("true").spawn().expect("spawn `true`");
        children.push(short_lived);

        // Give it a moment to actually finish exiting so try_wait can observe it —
        // spawn() returning doesn't guarantee the process has exited yet.
        std::thread::sleep(Duration::from_millis(100));

        let second = Command::new("true").spawn().expect("spawn `true`");
        children.push(second);

        // The first child should have been pruned when the second was pushed, so
        // exactly one entry remains tracked (the second — whether or not it has
        // exited yet itself).
        assert_eq!(children.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn format_timeout_error_shows_no_output_placeholder_when_the_tail_is_empty() {
        let msg = format_timeout_error(
            Duration::from_secs(15),
            "launch: bundled /opt/Dispatch.app/dispatchd",
            &[],
            Path::new("/home/user/.dispatch/logs/abc123.log"),
        );
        assert!(msg.contains("did not become healthy within 15s"));
        assert!(msg.contains("launch: bundled /opt/Dispatch.app/dispatchd"));
        assert!(msg.contains("/home/user/.dispatch/logs/abc123.log"));
        assert!(msg.contains("(no output)"));
    }

    #[test]
    fn format_timeout_error_joins_the_captured_tail_lines_with_newlines() {
        let lines = vec![
            "Listening on port 4771".to_string(),
            "error: something exploded".to_string(),
        ];
        let msg = format_timeout_error(
            Duration::from_secs(15),
            "launch: bundled /opt/Dispatch.app/dispatchd",
            &lines,
            Path::new("/home/user/.dispatch/logs/abc123.log"),
        );
        assert!(msg.contains("Listening on port 4771\nerror: something exploded"));
        assert!(!msg.contains("(no output)"));
    }

    #[test]
    fn describe_launch_only_mentions_bun_for_the_bun_script_path() {
        let bun_desc = describe_launch(&DaemonLaunch::BunScript(PathBuf::from("/repo/bin.ts")));
        assert!(bun_desc.contains("bun"));
        assert!(bun_desc.contains("bun.sh"));
        assert!(bun_desc.contains("/repo/bin.ts"));

        let bundled_desc = describe_launch(&DaemonLaunch::Bundled {
            dispatchd: PathBuf::from("/opt/Dispatch.app/dispatchd"),
            mcp: PathBuf::from("/opt/Dispatch.app/dispatch-mcp"),
        });
        // "bundled" itself contains the substring "bun", so assert on the
        // actual bun-specific hint text rather than the bare substring.
        assert!(!bundled_desc.contains("bun.sh"));
        assert!(!bundled_desc.contains("is bun installed"));
        assert!(bundled_desc.contains("/opt/Dispatch.app/dispatchd"));
    }

    #[test]
    fn forward_child_output_captures_stdout_and_stderr_into_the_tail_and_log_file() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo from-stdout; echo from-stderr 1>&2")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");

        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-forward-output-{}",
            std::process::id()
        ));
        let log_path = dir.join("daemon.log");
        let tail: OutputTail = Arc::new(Mutex::new(VecDeque::new()));

        forward_child_output(
            &mut child,
            Arc::clone(&tail),
            log_path.clone(),
            Arc::new(Mutex::new(None)),
        );
        child.wait().expect("child exits");
        // The forwarding threads read asynchronously off the now-exited child's
        // pipes; give them a moment to finish draining before asserting.
        std::thread::sleep(Duration::from_millis(200));

        let captured = tail.lock().unwrap();
        assert!(captured.iter().any(|l| l == "from-stdout"));
        assert!(captured.iter().any(|l| l == "from-stderr"));
        drop(captured);

        let logged = fs::read_to_string(&log_path).expect("log file was written");
        assert!(logged.contains("from-stdout"));
        assert!(logged.contains("from-stderr"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parse_app_token_line_matches_only_the_exact_prefixed_line() {
        assert_eq!(
            parse_app_token_line("DISPATCH_APP_TOKEN=abc123"),
            Some("abc123")
        );
        // CRLF-terminated stdout still yields a clean value.
        assert_eq!(
            parse_app_token_line("DISPATCH_APP_TOKEN=abc123\r"),
            Some("abc123")
        );
        // A bare prefix is not a credential.
        assert_eq!(parse_app_token_line("DISPATCH_APP_TOKEN="), None);
        assert_eq!(
            parse_app_token_line("dispatchd listening on http://127.0.0.1:45999"),
            None
        );
        // The prefix only counts at the start of a line, so prose mentioning it
        // (like the daemon's own follow-up hint) is forwarded normally.
        assert_eq!(
            parse_app_token_line("dispatchd: set DISPATCH_APP_TOKEN=... to decide"),
            None
        );
    }

    /// The property this whole change exists to protect: the app token must not
    /// reach the ring buffer (quoted verbatim into timeout errors) or the
    /// on-disk daemon log, which lives in the same directory an agent reads to
    /// find the daemon's port.
    #[test]
    fn forward_child_output_captures_the_app_token_without_leaking_it_anywhere() {
        let secret = "1fd6795f95a7f0381838dd5284185bc8ded5018784733bfc20871d92b42dc4df";
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "echo 'dispatchd listening on http://127.0.0.1:45999'; \
                 echo 'DISPATCH_APP_TOKEN={secret}'; \
                 echo 'dispatchd: that token authorizes approval decisions'"
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");

        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-token-strip-{}",
            std::process::id()
        ));
        let log_path = dir.join("daemon.log");
        let tail: OutputTail = Arc::new(Mutex::new(VecDeque::new()));
        let slot: AppTokenSlot = Arc::new(Mutex::new(None));

        forward_child_output(
            &mut child,
            Arc::clone(&tail),
            log_path.clone(),
            Arc::clone(&slot),
        );
        child.wait().expect("child exits");
        std::thread::sleep(Duration::from_millis(200));

        assert_eq!(slot.lock().unwrap().as_deref(), Some(secret));

        let captured: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
        assert!(captured.iter().any(|l| l.contains("listening on")));
        assert!(captured
            .iter()
            .any(|l| l.contains("authorizes approval decisions")));
        assert!(!captured.iter().any(|l| l.contains(secret)));
        assert!(!captured.iter().any(|l| l.contains(APP_TOKEN_PREFIX)));

        let logged = fs::read_to_string(&log_path).expect("log file was written");
        assert!(logged.contains("listening on"));
        assert!(!logged.contains(secret));
        assert!(!logged.contains(APP_TOKEN_PREFIX));

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Same guarantee for stderr: nothing prints the token there today, but a
    /// stream that skipped the filter would be a silent way back to disk.
    #[test]
    fn handle_output_line_strips_the_token_from_stderr_too() {
        let secret = "deadbeefdeadbeef";
        let tail: OutputTail = Arc::new(Mutex::new(VecDeque::new()));
        let slot: AppTokenSlot = Arc::new(Mutex::new(None));

        handle_output_line(
            &format!("DISPATCH_APP_TOKEN={secret}"),
            true,
            &slot,
            &tail,
            &None,
        );

        assert_eq!(slot.lock().unwrap().as_deref(), Some(secret));
        assert!(tail.lock().unwrap().is_empty());
    }

    #[test]
    fn spawned_app_tokens_only_returns_a_token_for_the_pid_that_produced_it() {
        let tokens = SpawnedAppTokens::new();
        tokens.remember("/tmp/proj", &file_info(1, 4242, "/tmp/proj"), "app-token");

        assert_eq!(
            tokens
                .get("/tmp/proj", &file_info(1, 4242, "/tmp/proj"))
                .as_deref(),
            Some("app-token")
        );
        // A different pid on the same root means our daemon died and something
        // else serves it now — the remembered token is not just stale, it is wrong.
        assert_eq!(
            tokens.get("/tmp/proj", &file_info(1, 9999, "/tmp/proj")),
            None
        );
        assert_eq!(
            tokens.get("/tmp/other", &file_info(1, 4242, "/tmp/other")),
            None
        );
    }

    #[tokio::test]
    async fn wait_for_app_token_returns_none_when_the_daemon_never_prints_one() {
        let slot: AppTokenSlot = Arc::new(Mutex::new(None));
        assert_eq!(
            wait_for_app_token(&slot, Duration::from_millis(10)).await,
            None
        );
    }

    #[tokio::test]
    async fn wait_for_app_token_picks_up_a_token_that_arrives_late() {
        let slot: AppTokenSlot = Arc::new(Mutex::new(None));
        let writer = Arc::clone(&slot);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            *writer.lock().unwrap() = Some("late-token".to_string());
        });
        assert_eq!(
            wait_for_app_token(&slot, Duration::from_secs(2))
                .await
                .as_deref(),
            Some("late-token")
        );
    }

    #[test]
    fn forward_child_output_evicts_the_oldest_line_once_over_capacity() {
        let tail: OutputTail = Arc::new(Mutex::new(VecDeque::new()));
        let log_file: Option<Arc<Mutex<std::fs::File>>> = None;
        for i in 0..(OUTPUT_TAIL_LINES + 5) {
            record_output_line(&tail, &log_file, &format!("line-{i}"));
        }
        let buf = tail.lock().unwrap();
        assert_eq!(buf.len(), OUTPUT_TAIL_LINES);
        // The first 5 lines (0..5) should have been evicted; the buffer should
        // start at line-5 and run through line-(N+4).
        assert_eq!(buf.front().unwrap(), "line-5");
        assert_eq!(
            buf.back().unwrap(),
            &format!("line-{}", OUTPUT_TAIL_LINES + 4)
        );
    }

    #[test]
    fn kill_all_clears_a_mix_of_exited_and_still_running_children() {
        let children = DispatchdChildren::new();

        let short_lived = Command::new("true").spawn().expect("spawn `true`");
        children.push(short_lived);
        std::thread::sleep(Duration::from_millis(100));

        // A long-running child kill_all has to actually terminate.
        let long_lived = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn `sleep`");
        children.push(long_lived);

        children.kill_all();
        assert!(children.0.lock().unwrap().is_empty());
    }

    // -----------------------------------------------------------------------
    // Live end-to-end against a real dispatchd.
    //
    // `#[ignore]` because it needs `bun` and the monorepo checkout, and because
    // it sets `DISPATCH_HOME`, which is process-global and would corrupt the
    // parallel tests above. Run it on its own:
    //
    //   cargo test --lib -- --ignored --test-threads=1 live_daemon
    // -----------------------------------------------------------------------

    /// Every file under `dir`, recursively.
    fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_files(&path, out);
            } else {
                out.push(path);
            }
        }
    }

    fn init_git_project(proj: &Path) {
        fs::create_dir_all(proj).unwrap();
        fs::write(proj.join("README.md"), "# live daemon fixture\n").unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
            vec!["add", "-A"],
            vec!["commit", "-qm", "init"],
        ] {
            let status = Command::new("git")
                .arg("-C")
                .arg(proj)
                .args(&args)
                .status()
                .expect("git runs");
            assert!(status.success(), "git {args:?} failed");
        }
    }

    async fn post_json(
        client: &reqwest::Client,
        url: &str,
        token: &str,
        body: serde_json::Value,
    ) -> (u16, String) {
        let response = client
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .expect("request sends");
        let status = response.status().as_u16();
        (status, response.text().await.unwrap_or_default())
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_daemon_spawn_gets_decide_tier_and_leaks_nothing_to_disk() {
        let scratch = std::env::temp_dir().join(format!(
            "dispatch-live-daemon-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let dispatch_home = scratch.join("home");
        let proj = scratch.join("proj");
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(&dispatch_home).unwrap();
        init_git_project(&proj);

        std::env::set_var("DISPATCH_HOME", &dispatch_home);

        let root = proj.to_string_lossy().to_string();
        let children = DispatchdChildren::new();
        let app_tokens = SpawnedAppTokens::new();
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));

        let spawned = ensure_dispatchd(
            &BunSpawner,
            &children,
            &app_tokens,
            dev_launch(manifest_dir),
            &root,
            false,
        )
        .await
        .expect("dispatchd comes up");

        let app_token = spawned
            .app_token
            .clone()
            .expect("a spawned daemon hands over its app token");
        let agent_token = spawned
            .agent_token
            .clone()
            .expect("the daemon file carries an agent token");
        assert_eq!(app_token.len(), 64);
        assert!(app_token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(app_token, agent_token);

        // --- the property: the app token is nowhere at rest ---
        let log_path = daemon_log_path(&root);
        let logged = fs::read_to_string(&log_path).expect("daemon log written");
        assert!(
            logged.contains("listening on"),
            "log should still be useful"
        );
        assert!(
            !logged.contains(&app_token),
            "app token reached the daemon log"
        );
        assert!(!logged.contains(APP_TOKEN_PREFIX));

        let mut files = Vec::new();
        walk_files(&dispatch_home, &mut files);
        assert!(!files.is_empty(), "DISPATCH_HOME should not be empty");
        let leaked: Vec<&PathBuf> = files
            .iter()
            .filter(|p| {
                fs::read_to_string(p)
                    .map(|c| c.contains(&app_token))
                    .unwrap_or(false)
            })
            .collect();
        eprintln!(
            "[live] port={} appToken=<64 hex, withheld> agentToken={}…\n\
             [live] scanned {} files under {} — {} contain the app token\n\
             [live] daemon log ({}):\n{}",
            spawned.port,
            &agent_token[..8],
            files.len(),
            dispatch_home.display(),
            leaked.len(),
            log_path.display(),
            logged.trim_end(),
        );
        assert!(leaked.is_empty(), "app token found at rest in {leaked:?}");

        // --- a decide-tier action, with each credential ---
        let http = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{}", spawned.port);

        // A pending agent registration: approving it is a decide-tier action.
        let register_agent = |name: &'static str| {
            let http = http.clone();
            let base = base.clone();
            let agent_token = agent_token.clone();
            async move {
                let (_, body) = post_json(
                    &http,
                    &format!("{base}/api/agents/register"),
                    &agent_token,
                    serde_json::json!({ "name": name, "client": "live-test" }),
                )
                .await;
                let address = serde_json::from_str::<serde_json::Value>(&body).unwrap()["address"]
                    .as_str()
                    .expect("agent registered")
                    .to_string();
                // An address is `agent:<handle>/<name>`; both separators need escaping in a path.
                address.replace(':', "%3A").replace('/', "%2F")
            }
        };

        // The credential an attached app would hold: 403, on the exact code the
        // UI keys its "Restart daemon to enable approvals" affordance on.
        let denied = register_agent("live-denied").await;
        let (status, body) = post_json(
            &http,
            &format!("{base}/api/agents/{denied}/approve"),
            &agent_token,
            serde_json::json!({}),
        )
        .await;
        eprintln!("[live] decide with the agent token  -> {status} {body}");
        assert_eq!(
            status, 403,
            "agent token must not reach decide tier: {body}"
        );
        assert!(body.contains("auth_insufficient_tier"), "body was {body}");

        // The credential a spawning app holds: the decision lands.
        let allowed = register_agent("live-allowed").await;
        let (status, body) = post_json(
            &http,
            &format!("{base}/api/agents/{allowed}/approve"),
            &app_token,
            serde_json::json!({}),
        )
        .await;
        eprintln!("[live] decide with the app token    -> {status} {body}");
        assert_eq!(status, 200, "app token should decide: {body}");
        assert!(body.contains("\"status\":\"approved\""), "body was {body}");

        // --- re-attaching ---
        // Same app instance, second call: the fast path finds the daemon we
        // spawned and must not silently drop to request tier.
        let reattached = ensure_dispatchd(
            &BunSpawner,
            &children,
            &app_tokens,
            dev_launch(manifest_dir),
            &root,
            false,
        )
        .await
        .expect("reattach");
        assert_eq!(reattached.app_token.as_deref(), Some(app_token.as_str()));

        // A different app instance (or a restart of this one) attaching to a
        // daemon it did not spawn: request tier only, and no disk fallback.
        let attached = ensure_dispatchd(
            &BunSpawner,
            &children,
            &SpawnedAppTokens::new(),
            dev_launch(manifest_dir),
            &root,
            false,
        )
        .await
        .expect("attach");
        eprintln!(
            "[live] reattach (same app instance) canDecide={}\n\
             [live] attach   (fresh app instance) canDecide={} hasAgentToken={}",
            reattached.app_token.is_some(),
            attached.app_token.is_some(),
            attached.agent_token.is_some(),
        );
        assert_eq!(attached.port, spawned.port);
        assert_eq!(attached.app_token, None);
        assert_eq!(attached.agent_token.as_deref(), Some(agent_token.as_str()));

        children.kill_all();
        let _ = fs::remove_dir_all(&scratch);
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_takeover_keeps_the_port_and_gets_the_app_token() {
        let scratch =
            std::env::temp_dir().join(format!("dispatch-live-takeover-{}", std::process::id()));
        let dispatch_home = scratch.join("home");
        let proj = scratch.join("proj");
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(&dispatch_home).unwrap();
        init_git_project(&proj);
        std::env::set_var("DISPATCH_HOME", &dispatch_home);
        let root = proj.to_string_lossy().to_string();
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));

        // The daemon `dispatch serve` would start: not ours, token unread, and
        // not this test's child either, so it never lingers as a zombie.
        let launch = format!(
            "'{}' '{}' {} >/dev/null 2>&1 &",
            resolve_bun().to_string_lossy(),
            dispatchd_bin_path(manifest_dir).display(),
            daemon_args(&root, true, None).join(" ")
        );
        let started = Command::new("sh")
            .arg("-c")
            .arg(&launch)
            .env("DISPATCH_HOME", &dispatch_home)
            .status()
            .expect("sh runs");
        assert!(started.success());
        let client = reqwest::Client::new();
        let old_port = poll_for_healthy_daemon(&client, &root, Duration::from_secs(30))
            .await
            .expect("the external daemon comes up");
        let old = read_daemon_file(&root).unwrap();
        let children = DispatchdChildren::new();
        let app_tokens = SpawnedAppTokens::new();

        let attached = ensure_dispatchd(
            &BunSpawner,
            &children,
            &app_tokens,
            dev_launch(manifest_dir),
            &root,
            false,
        )
        .await
        .expect("attach");
        assert_eq!(attached.app_token, None);

        let taken = ensure_dispatchd(
            &BunSpawner,
            &children,
            &app_tokens,
            dev_launch(manifest_dir),
            &root,
            true,
        )
        .await
        .expect("takeover");
        eprintln!(
            "[live] takeover: old port {old_port} -> new port {}, app token {}",
            taken.port,
            taken.app_token.is_some()
        );
        assert_eq!(taken.port, old_port);
        assert!(taken.app_token.is_some());
        assert!(!pid_alive(old.pid));
        assert_ne!(read_daemon_file(&root).map(|i| i.pid), Some(old.pid));

        // The window's follow-up attach keeps the token.
        let reattached = ensure_dispatchd(
            &BunSpawner,
            &children,
            &app_tokens,
            dev_launch(manifest_dir),
            &root,
            false,
        )
        .await
        .expect("reattach");
        assert_eq!(reattached.app_token, taken.app_token);

        children.kill_all();
        let _ = fs::remove_dir_all(&scratch);
    }
}

#[cfg(test)]
#[path = "sidecar/lifecycle_tests.rs"]
mod lifecycle_tests;
