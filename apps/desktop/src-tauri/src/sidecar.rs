//! Dev-only wiring for `dispatchd` — the Bun HTTP+WS daemon that serves
//! `.dispatch/` task data for one project root (see
//! `packages/server/src/daemonfile.ts` and `packages/server/src/bin.ts`).
//!
//! `ensure_dispatchd` is the frontend's single entry point: given a project
//! root, return a healthy dispatchd port, spawning one if none is already
//! running. This mirrors `dispatch ui`'s own ensure-daemon flow
//! (`packages/cli/src/commands/daemon.ts`'s `waitForHealthyDaemon`) almost
//! exactly, reimplemented here so the desktop app doesn't need Node or
//! `@dispatch/cli` on `PATH` — only `bun`.
//!
//! Phase 6 TODO: once dispatchd ships as a packaged binary
//! (`bun build --compile`), replace `dispatchd_bin_path`'s dev-only
//! resolution (a walk up from `CARGO_MANIFEST_DIR`, valid only when running
//! from this monorepo checkout) with a path into the app bundle's resources.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Mirrors `packages/server/src/daemonfile.ts`'s `DaemonFileInfo` shape
/// exactly — this is deserialized straight from the JSON file that Bun
/// writes, so field names (via `rename_all`) must match verbatim.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonFileInfo {
    port: u16,
    #[allow(dead_code)]
    pid: u32,
    #[allow(dead_code)]
    root_dir: String,
    #[allow(dead_code)]
    started_at: String,
}

/// The subset of dispatchd's `/api/health` response this cares about —
/// just enough to know the daemon is alive and answering.
#[derive(Debug, Deserialize)]
struct HealthResponse {
    ok: bool,
}

// ---------------------------------------------------------------------------
// Daemon-file discovery — mirrors daemonfile.ts's read side.
// ---------------------------------------------------------------------------

/// sha256(rootDir) hex, first 12 chars — must stay byte-for-byte identical
/// to `daemonfile.ts`'s `daemonFileKey`. Cross-checked in tests against the
/// same fixture value `packages/cli/test/daemon-cmd.test.ts` uses, so drift
/// between the TS and Rust copies of this scheme fails loudly here too.
fn daemon_file_key(root_dir: &str) -> String {
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
fn daemon_home() -> PathBuf {
    match std::env::var("DISPATCH_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
    }
}

fn daemon_file_path(root_dir: &str) -> PathBuf {
    daemon_file_path_under(&daemon_home(), root_dir)
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
fn parse_health_response(body: &str) -> Result<bool, String> {
    let parsed: HealthResponse =
        serde_json::from_str(body).map_err(|e| format!("invalid /api/health response: {e}"))?;
    Ok(parsed.ok)
}

async fn is_healthy(client: &reqwest::Client, port: u16) -> bool {
    let Ok(response) = client
        .get(format!("http://127.0.0.1:{port}/api/health"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
    else {
        return false;
    };
    let Ok(body) = response.text().await else {
        return false;
    };
    parse_health_response(&body).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// dispatchd process management
// ---------------------------------------------------------------------------

/// Dev-only resolution of dispatchd's entry point: walks up from Cargo's own
/// manifest dir (`apps/desktop/src-tauri`) to the monorepo root — three
/// levels (`src-tauri` -> `desktop` -> `apps` -> repo root), not two — then
/// down into `packages/server/src/bin.ts`. Valid only when running from this
/// checkout — see this module's doc comment for the Phase 6 packaged-binary
/// TODO.
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

/// Abstraction over spawning the dispatchd child process, so `ensure_dispatchd`'s
/// health-check/poll logic can be exercised in tests (e.g. "bun isn't
/// installed" surfacing as a clear error) without actually invoking `bun`.
/// `Send + Sync` because a `&dyn DaemonSpawner` is held across an `.await`
/// inside `ensure_dispatchd`, and Tauri's async commands require their
/// whole future to be `Send`.
pub trait DaemonSpawner: Send + Sync {
    fn spawn(&self, bin_path: &Path, root: &str) -> Result<Child, String>;
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
    fn spawn(&self, bin_path: &Path, root: &str) -> Result<Child, String> {
        let mut command = Command::new(resolve_bun());
        command
            .arg(bin_path)
            .arg("--root")
            .arg(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Phase 7: `DISPATCH_ENABLE_FAKES=1` is what makes dispatchd register
        // a FakeExecutor/FakePlanner alongside the real ones (see
        // packages/server/src/bin.ts's own doc comment) — production
        // dispatchd otherwise only ever wires up the real Claude backend.
        // Setting it only in debug builds is what keeps the Tasks tab's
        // existing hidden "dispatch with the fake executor" dev toggle
        // (apps/desktop/src/lib/devTools.ts) working exactly as before this
        // phase, while a release build's sidecar never sets it — matching
        // the plan's "production default registers claude only".
        #[cfg(debug_assertions)]
        command.env("DISPATCH_ENABLE_FAKES", "1");
        command.spawn().map_err(|e| {
            format!(
                "failed to spawn dispatchd (bun {}): {e} — is bun installed? https://bun.sh",
                bin_path.display()
            )
        })
    }
}

/// Spawns background threads that forward a child process's stdout/stderr
/// lines into Rust's `log`, prefixed so they're identifiable among Relay's
/// own log output — see `BunSpawner`'s doc comment for why this matters.
fn forward_child_output(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log::info!("dispatchd: {line}");
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("dispatchd: {line}");
            }
        });
    }
}

/// Tauri-managed state tracking every dispatchd child this app instance has
/// spawned, so they can all be killed when the app exits — a spawned
/// dispatchd otherwise has no parent-death signal of its own and would keep
/// running as an orphan after the desktop app closes. Uses `Child::kill`
/// (a hard kill, not `SIGTERM`), so a killed dispatchd's on-disk daemon file
/// can be left behind stale; that's fine — `ensure_dispatchd`'s health check
/// on the next launch already treats a stale file as "no daemon" and spawns
/// a fresh one.
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

const POLL_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Polls the daemon file + its `/api/health` for up to `timeout`, for the
/// case where a fresh dispatchd was just spawned and needs time to finish
/// booting (bind its port, write its daemon file, answer health checks).
/// Mirrors `daemon.ts`'s `waitForHealthyDaemon`.
async fn poll_for_healthy_daemon(
    client: &reqwest::Client,
    root: &str,
    timeout: Duration,
) -> Option<u16> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(info) = read_daemon_file(root) {
            if is_healthy(client, info.port).await {
                return Some(info.port);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Returns a healthy dispatchd port for `root`: the fast path reuses an
/// already-running daemon (found via its daemon file + a passing health
/// check); otherwise spawns a fresh one through `spawner` and polls until
/// it's healthy or `POLL_TIMEOUT` elapses. `children` collects every process
/// this call spawns, for the caller to track for kill-on-exit.
pub async fn ensure_dispatchd(
    spawner: &dyn DaemonSpawner,
    children: &DispatchdChildren,
    manifest_dir: &Path,
    root: &str,
) -> Result<u16, String> {
    let root = normalize_root(root)?;
    let root = root.as_str();
    let client = reqwest::Client::new();

    if let Some(info) = read_daemon_file(root) {
        if is_healthy(&client, info.port).await {
            return Ok(info.port);
        }
    }

    let bin_path = dispatchd_bin_path(manifest_dir);
    let mut child = spawner.spawn(&bin_path, root)?;
    forward_child_output(&mut child);
    children.push(child);

    poll_for_healthy_daemon(&client, root, POLL_TIMEOUT)
        .await
        .ok_or_else(|| {
            "dispatchd did not become healthy within 5s (is bun installed? https://bun.sh)"
                .to_string()
        })
}

/// True if `root` looks like a Dispatch project — i.e. it has a `.dispatch/`
/// directory. Purely a filesystem check (no daemon involved); gates whether
/// `ProjectDetail` shows a Tasks tab at all before ever calling
/// `ensure_dispatchd`.
pub fn has_dispatch(root: &str) -> bool {
    Path::new(root).join(".dispatch").is_dir()
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
fn normalize_root(root: &str) -> Result<String, String> {
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
        assert_eq!(parse_health_response(r#"{"ok":false,"version":"0.0.1"}"#), Ok(false));
    }

    #[test]
    fn parse_health_response_rejects_malformed_json() {
        assert!(parse_health_response("not json").is_err());
    }

    #[test]
    fn read_daemon_file_at_deserializes_the_camelcase_json_bun_writes() {
        let dir = std::env::temp_dir().join(format!(
            "dispatch-sidecar-test-{}",
            std::process::id()
        ));
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

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_daemon_file_at_returns_none_for_a_missing_file() {
        assert!(read_daemon_file_at(Path::new("/nonexistent/daemon.json")).is_none());
    }

    #[test]
    fn normalize_root_strips_a_trailing_slash() {
        assert_eq!(normalize_root("/tmp/dispatch-fixture-root/"), Ok("/tmp/dispatch-fixture-root".to_string()));
    }

    #[test]
    fn normalize_root_strips_multiple_trailing_slashes() {
        assert_eq!(normalize_root("/tmp/dispatch-fixture-root///"), Ok("/tmp/dispatch-fixture-root".to_string()));
    }

    #[test]
    fn normalize_root_is_a_no_op_without_a_trailing_slash() {
        assert_eq!(normalize_root("/tmp/dispatch-fixture-root"), Ok("/tmp/dispatch-fixture-root".to_string()));
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
        assert_eq!(daemon_file_key(&with_slash), daemon_file_key(&without_slash));
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

    /// A spawner that always fails, standing in for "bun isn't on PATH" — this is what
    /// makes `ensure_dispatchd`'s spawn path testable without actually invoking `bun`
    /// or a real dispatchd.
    struct FailingSpawner;

    impl DaemonSpawner for FailingSpawner {
        fn spawn(&self, _bin_path: &Path, _root: &str) -> Result<Child, String> {
            Err("bun: command not found".to_string())
        }
    }

    #[tokio::test]
    async fn ensure_dispatchd_surfaces_a_spawn_failure_without_polling() {
        // No daemon file exists for this root, so ensure_dispatchd must fall through to
        // spawning — and FailingSpawner's error should come straight back out, not get
        // swallowed into the generic "did not become healthy" timeout message.
        let root = "/tmp/dispatch-fixture-root-never-has-a-daemon-file";
        let children = DispatchdChildren::new();
        let manifest_dir = Path::new("/repo/apps/desktop/src-tauri");

        let result =
            ensure_dispatchd(&FailingSpawner, &children, manifest_dir, root).await;

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
}
