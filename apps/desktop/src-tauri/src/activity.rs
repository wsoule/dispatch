//! Per-project git-commit sparkline data (Task D). Explicitly decorative, per PLAN.md item
//! 18: a project with no git history, a path that's no longer a valid git repo, or a machine
//! without `git` on `PATH` must all degrade to "no data" (a flat, all-zero sparkline), never a
//! visible error or crash — nothing here should ever affect a project card's core
//! functionality. That's why `project_activity` below returns `Vec<i64>` directly rather than
//! `Result<Vec<i64>, String>`: every failure path already resolves to `vec![0; WINDOW_DAYS]`
//! internally, so there's no error state left for the frontend to handle. Contrast this with
//! `commands::open_in_editor`, which correctly *does* return `Result` because a failed
//! editor-open is a real, user-actionable failure.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Number of days shown in the sparkline: today plus the 13 days before it.
const WINDOW_DAYS: i64 = 14;
const SECONDS_PER_DAY: i64 = 86_400;

/// How long a cached `project_activity` result stays valid before the next request for the
/// same `project_path` triggers a fresh `git log` shellout. Chosen from the 30-90s range the
/// brief suggests: 60s comfortably covers React Query's refetch cadence after a
/// `data-changed` event (which fires on ordinary session activity, not on new commits) so
/// repeated card re-renders in that window don't re-shell-out, while still refreshing within
/// about a minute of a real new commit landing — short enough that "I just committed and
/// switched back to the app" doesn't feel stale for long, long enough to make the cache
/// actually useful against refetch churn.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// In-memory cache of `project_activity` results, keyed by absolute project path. Managed as
/// Tauri state via `app.manage(...)` — same small-`Mutex`-guarded-state pattern already used
/// for `db::Db`, `summarize::ApiKeyState`, and `summarize::InFlight`. Resets on app restart;
/// no persistence to SQLite, per the brief (this data is cheap to regenerate).
pub struct ActivityCache(pub Mutex<HashMap<String, (Instant, Vec<i64>)>>);

impl ActivityCache {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// Buckets raw Unix commit timestamps (`git log --format=%ct`, seconds since epoch) into
/// daily commit counts over a fixed `WINDOW_DAYS`-day window ending today (inclusive of
/// today). Returns a `Vec<i64>` of length `WINDOW_DAYS`: index 0 is the oldest day in the
/// window (`WINDOW_DAYS - 1` days before `now`), the last index is the day containing `now`
/// — oldest-to-newest, matching how a sparkline reads left-to-right. A day with no commits is
/// `0`, not omitted. A timestamp that falls outside the window (older than `WINDOW_DAYS - 1`
/// days ago, or after `now`'s day — e.g. clock skew) is excluded entirely rather than
/// clamped into an edge bucket.
///
/// `now` is threaded through as a parameter (rather than this function calling
/// `chrono::Utc::now()` itself) specifically so it stays pure and unit-testable — the only
/// non-pure part of this feature (the `git log` shellout) lives in `git_log_timestamps`
/// below, which this function has no knowledge of.
///
/// Day boundaries are UTC calendar days: since the Unix epoch (timestamp 0) is itself a UTC
/// midnight, `ts - ts.rem_euclid(SECONDS_PER_DAY)` gives the start-of-day timestamp for any
/// `ts` without needing a calendar/timezone library.
fn bucket_daily_counts(timestamps: &[i64], now: i64) -> Vec<i64> {
    let mut buckets = vec![0i64; WINDOW_DAYS as usize];
    let today_start = now - now.rem_euclid(SECONDS_PER_DAY);

    for &ts in timestamps {
        let ts_day_start = ts - ts.rem_euclid(SECONDS_PER_DAY);
        let days_before_today = (today_start - ts_day_start) / SECONDS_PER_DAY;

        if days_before_today < 0 || days_before_today > WINDOW_DAYS - 1 {
            // Outside the window: either older than WINDOW_DAYS-1 days ago, or in the future
            // relative to `now` (clock skew) — excluded rather than miscounted into an edge
            // bucket.
            continue;
        }

        let index = (WINDOW_DAYS - 1 - days_before_today) as usize;
        buckets[index] += 1;
    }

    buckets
}

/// Shells out to `git log --since="{since_days}.days" --format=%ct` in `project_path`,
/// returning one raw Unix timestamp per commit line. Every failure mode — `git` not on
/// `PATH`, the process failing to spawn, a non-zero exit (not a git repo, path doesn't
/// exist, etc.), or unparseable output — resolves to an empty `Vec`, never a panic or
/// propagated error. `pub` so `commands::project_git_insights` can reuse it with a wider
/// window than the 14-day sparkline below.
pub fn git_log_timestamps(project_path: &str, since_days: i64) -> Vec<i64> {
    let output = match Command::new("git")
        .args(["log", &format!("--since={since_days}.days"), "--format=%ct"])
        .current_dir(project_path)
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            // Most commonly "git" isn't on PATH at all. Not spammy at debug level, but worth
            // being discoverable since it means the sparkline feature is silently dead for
            // every project on this machine.
            log::debug!("project_activity: failed to spawn `git` for {project_path}: {e}");
            return Vec::new();
        }
    };

    if !output.status.success() {
        // The overwhelmingly common case here is "project_path isn't a git repo" (or doesn't
        // exist), which is expected and unremarkable for plenty of projects — debug, not warn,
        // to avoid log spam on every non-git project card.
        log::debug!(
            "project_activity: `git log` exited non-zero in {project_path} (likely not a git repo)"
        );
        return Vec::new();
    }

    match String::from_utf8(output.stdout) {
        Ok(stdout) => stdout
            .lines()
            .filter_map(|line| line.trim().parse::<i64>().ok())
            .collect(),
        Err(e) => {
            // Genuinely unexpected — `%ct` output should always be ASCII digits — so this is
            // worth a louder log level than the two expected cases above.
            log::warn!(
                "project_activity: `git log` stdout for {project_path} wasn't valid UTF-8: {e}"
            );
            Vec::new()
        }
    }
}

/// Returns the 14-day daily commit-count sparkline for `project_path`, serving from
/// `cache` when a fresh-enough entry exists and shelling out to `git log` (via
/// `git_log_timestamps` + `bucket_daily_counts`) on a cache miss or expiry. Every failure
/// path bottoms out at `vec![0; WINDOW_DAYS]` — see the module doc comment for why this
/// doesn't return `Result`.
pub fn project_activity(project_path: &str, cache: &ActivityCache) -> Vec<i64> {
    if let Ok(guard) = cache.0.lock() {
        if let Some((fetched_at, cached)) = guard.get(project_path) {
            if fetched_at.elapsed() < CACHE_TTL {
                return cached.clone();
            }
        }
    }

    let timestamps = git_log_timestamps(project_path, WINDOW_DAYS);
    let now = chrono::Utc::now().timestamp();
    let result = bucket_daily_counts(&timestamps, now);

    if let Ok(mut guard) = cache.0.lock() {
        guard.insert(project_path.to_string(), (Instant::now(), result.clone()));
    }

    result
}

/// One commit as shown in the Overview tab's "Recent commits" list.
#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    /// Abbreviated hash (`git log`'s `%h`).
    pub hash: String,
    /// Subject line only (`%s`) — not the full body, to keep each row a single line.
    pub message: String,
    pub author: String,
    pub timestamp: i64,
}

/// Unit separator (`\x1f`) rather than a printable delimiter like `|` or `,` between
/// `git log --format` fields, since a commit subject can freely contain either.
const GIT_LOG_FIELD_SEP: &str = "\x1f";

/// Shells out to `git log -n{limit} --format=...` in `project_path` for the most recent
/// commits, newest first. Same "degrade to empty on any failure" contract as
/// `git_log_timestamps` — not a git repo, no `git` on `PATH`, or unparseable output all
/// resolve to an empty `Vec` rather than an error the frontend would need to handle.
pub fn git_recent_commits(project_path: &str, limit: usize) -> Vec<CommitInfo> {
    let format_arg = format!("--format=%h{GIT_LOG_FIELD_SEP}%s{GIT_LOG_FIELD_SEP}%an{GIT_LOG_FIELD_SEP}%ct");
    let output = match Command::new("git")
        .args(["log", &format!("-n{limit}"), &format_arg])
        .current_dir(project_path)
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            log::debug!("git_recent_commits: failed to spawn `git` for {project_path}: {e}");
            return Vec::new();
        }
    };

    if !output.status.success() {
        log::debug!(
            "git_recent_commits: `git log` exited non-zero in {project_path} (likely not a git repo)"
        );
        return Vec::new();
    }

    let stdout = match String::from_utf8(output.stdout) {
        Ok(stdout) => stdout,
        Err(e) => {
            log::warn!("git_recent_commits: `git log` stdout for {project_path} wasn't valid UTF-8: {e}");
            return Vec::new();
        }
    };

    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, GIT_LOG_FIELD_SEP);
            let hash = parts.next()?.to_string();
            let message = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let timestamp = parts.next()?.trim().parse::<i64>().ok()?;
            Some(CommitInfo { hash, message, author, timestamp })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed "now" for tests: some arbitrary UTC midnight-aligned timestamp, so day-boundary
    /// arithmetic is easy to reason about by hand. 2024-01-15T00:00:00Z.
    const NOW: i64 = 1_705_276_800;

    #[test]
    fn empty_timestamp_list_returns_all_zero_window() {
        let buckets = bucket_daily_counts(&[], NOW);
        assert_eq!(buckets, vec![0; 14]);
    }

    #[test]
    fn timestamps_all_on_one_day_bucket_into_a_single_index() {
        // Three commits today, a few hours apart.
        let timestamps = vec![NOW + 3600, NOW + 7200, NOW + 43_000];
        let buckets = bucket_daily_counts(&timestamps, NOW);

        let mut expected = vec![0i64; 14];
        expected[13] = 3; // last index = today
        assert_eq!(buckets, expected);
    }

    #[test]
    fn timestamps_spread_across_the_window_land_in_correct_days() {
        // today (index 13), 1 day ago (index 12), 13 days ago (index 0).
        let today = NOW + 100;
        let one_day_ago = NOW - SECONDS_PER_DAY + 100;
        let thirteen_days_ago = NOW - 13 * SECONDS_PER_DAY + 100;

        let buckets = bucket_daily_counts(&[today, one_day_ago, thirteen_days_ago], NOW);

        let mut expected = vec![0i64; 14];
        expected[13] = 1;
        expected[12] = 1;
        expected[0] = 1;
        assert_eq!(buckets, expected);
    }

    #[test]
    fn timestamp_older_than_window_is_excluded_not_miscounted_into_day_zero() {
        // 14 days ago is just *outside* the window (window is today + 13 days before it, i.e.
        // 0..=13 days ago) — must be dropped entirely, not folded into index 0.
        let fourteen_days_ago = NOW - 14 * SECONDS_PER_DAY + 100;
        let buckets = bucket_daily_counts(&[fourteen_days_ago], NOW);
        assert_eq!(buckets, vec![0; 14]);
    }

    #[test]
    fn future_timestamp_beyond_today_is_excluded() {
        let tomorrow = NOW + SECONDS_PER_DAY + 100;
        let buckets = bucket_daily_counts(&[tomorrow], NOW);
        assert_eq!(buckets, vec![0; 14]);
    }

    #[test]
    fn multiple_commits_same_day_accumulate_in_that_days_bucket() {
        let one_day_ago_a = NOW - SECONDS_PER_DAY + 100;
        let one_day_ago_b = NOW - SECONDS_PER_DAY + 200;
        let buckets = bucket_daily_counts(&[one_day_ago_a, one_day_ago_b], NOW);

        let mut expected = vec![0i64; 14];
        expected[12] = 2;
        assert_eq!(buckets, expected);
    }
}
