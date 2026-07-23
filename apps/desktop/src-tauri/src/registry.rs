//! Read/write side of `~/.dispatch/projects.json` — the desktop app's
//! persistent list of projects the user has opened, powering the sidebar's
//! project switcher and the "reopen the most recent project on launch" chain in
//! `commands::current_project_root`.
//!
//! This is the Rust twin of `packages/core/src/registry.ts`. Both sides
//! read and write the *same* file, so the on-disk shape must stay byte-for-byte
//! compatible: a `{ "projects": [...] }` object (not a bare array), `camelCase`
//! field names, 2-space-pretty JSON with a trailing newline, and paths
//! normalized identically (absolute, trailing slash stripped). The
//! `registry_roundtrip_json_matches_the_typescript_shape` test locks that shape
//! in place; keep both files in sync if it ever changes.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::sidecar::{daemon_home, normalize_root};

/// One registered project. Field names serialize as `camelCase` to match the
/// `RegisteredProject` interface in `registry.ts` — `addedAt` is when the
/// project was first seen, `lastOpenedAt` is bumped every time it's opened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredProject {
    pub path: String,
    pub name: String,
    pub added_at: String,
    pub last_opened_at: String,
}

/// The file envelope: a `{ "projects": [...] }` object, matching `registry.ts`'s
/// `RegistryFile`. `#[serde(default)]` on `projects` lets a `{}` (or a file
/// missing the key) parse as an empty list rather than failing.
#[derive(Debug, Default, Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    projects: Vec<RegisteredProject>,
}

/// Pure path-joining half of `registry_path`, split out so tests can pass a
/// fixed `home` instead of depending on `$DISPATCH_HOME`/the real home
/// directory — the same env-avoidance pattern `sidecar::daemon_file_path_under`
/// uses for its own parallel-safe tests.
fn registry_path_under(home: &Path) -> PathBuf {
    home.join(".dispatch").join("projects.json")
}

/// `~/.dispatch/projects.json` (or `$DISPATCH_HOME/.dispatch/projects.json`) —
/// the exact same file `registry.ts`'s `registryPath()` resolves to.
fn registry_path() -> PathBuf {
    registry_path_under(&daemon_home())
}

/// ISO-8601 timestamp with millisecond precision and a `Z` suffix — matches
/// JavaScript's `new Date().toISOString()` exactly (e.g.
/// `2026-07-22T12:34:56.789Z`), so timestamps written by the Rust and TS sides
/// are indistinguishable.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Display name for a normalized project path: its last path segment (e.g.
/// `/Users/x/Sites/dispatch` -> `dispatch`), falling back to the full path for
/// a segment-less root — mirrors `registry.ts`'s `basename(normalized)`.
fn project_name(normalized: &str) -> String {
    Path::new(normalized)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| normalized.to_string())
}

/// Reads and parses a registry file, treating a missing or corrupt file as an
/// empty list rather than erroring — a brand-new machine (no registry yet) and
/// a file damaged mid-write should both read as "no projects registered yet",
/// exactly like `registry.ts`'s `readRegistry`.
fn read_registry_at(path: &Path) -> Vec<RegisteredProject> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<RegistryFile>(&contents)
        .map(|f| f.projects)
        .unwrap_or_default()
}

/// Writes the registry as 2-space-pretty JSON with a trailing newline — the
/// same bytes `registry.ts`'s `writeRegistry` produces
/// (`JSON.stringify({ projects }, null, 2) + '\n'`). Creates the parent
/// `.dispatch/` directory if it's missing.
fn write_registry_at(path: &Path, projects: &[RegisteredProject]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = RegistryFile {
        projects: projects.to_vec(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{json}\n")).map_err(|e| e.to_string())
}

/// Adds a project to the registry, or refreshes it if already present. Dedupes
/// on the normalized path (so `/a/b` and `/a/b/` are the same project); a fresh
/// registration stamps both `addedAt` and `lastOpenedAt`, while re-registering
/// an existing one only bumps `lastOpenedAt`. Mirrors `registry.ts`'s
/// `upsertRegisteredProject`.
fn upsert_at(path: &Path, project_path: &str) -> Result<RegisteredProject, String> {
    let normalized = normalize_root(project_path)?;
    let now = now_iso();
    let mut projects = read_registry_at(path);

    if let Some(existing) = projects.iter_mut().find(|p| p.path == normalized) {
        existing.last_opened_at = now;
        let entry = existing.clone();
        write_registry_at(path, &projects)?;
        return Ok(entry);
    }

    let entry = RegisteredProject {
        path: normalized.clone(),
        name: project_name(&normalized),
        added_at: now.clone(),
        last_opened_at: now,
    };
    projects.push(entry.clone());
    write_registry_at(path, &projects)?;
    Ok(entry)
}

/// The registered project with the most recent `lastOpenedAt`, if any. ISO-8601
/// timestamps sort correctly as plain strings, so a lexicographic max is the
/// chronological max. Powers step (2) of `current_project_root`'s resolution
/// chain — "reopen the project you last had open."
fn most_recent_path_at(path: &Path) -> Option<String> {
    read_registry_at(path)
        .into_iter()
        .max_by(|a, b| a.last_opened_at.cmp(&b.last_opened_at))
        .map(|p| p.path)
}

// --- Public API (operates on the real `~/.dispatch/projects.json`) ---

/// Every registered project, newest-registration order as stored on disk.
pub fn list() -> Vec<RegisteredProject> {
    read_registry_at(&registry_path())
}

/// Registers `project_path` (or refreshes it), returning the stored entry —
/// whose `path` is the normalized absolute path callers should key off.
pub fn upsert(project_path: &str) -> Result<RegisteredProject, String> {
    upsert_at(&registry_path(), project_path)
}

/// Stamps `lastOpenedAt` for `project_path`, adding it to the registry if it
/// wasn't there yet (so opening a project discovered outside the registry still
/// records it). Same underlying upsert as `upsert`, discarding the entry.
pub fn touch_opened(project_path: &str) -> Result<(), String> {
    upsert_at(&registry_path(), project_path).map(|_| ())
}

/// Path of the project with the most recent `lastOpenedAt`, if the registry has
/// any entries — used by `current_project_root` to reopen the last project.
pub fn most_recent_path() -> Option<String> {
    most_recent_path_at(&registry_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_registry() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dispatch-registry-test-{}-{}",
            std::process::id(),
            // Nanosecond suffix so tests running in parallel never share a file.
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = registry_path_under(&dir);
        // Create the `.dispatch/` parent so tests that write the file directly (without going
        // through `write_registry_at`, which creates it itself) don't hit a missing-parent
        // error.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        path
    }

    #[test]
    fn read_registry_at_returns_empty_for_missing_or_corrupt_file() {
        assert!(read_registry_at(Path::new("/nonexistent/projects.json")).is_empty());

        let path = temp_registry();
        std::fs::write(&path, "not json at all").unwrap();
        assert!(read_registry_at(&path).is_empty());
    }

    #[test]
    fn upsert_at_writes_then_reads_back_the_same_entry() {
        let path = temp_registry();
        let entry = upsert_at(&path, "/tmp/dispatch-fixture-root").unwrap();

        assert_eq!(entry.path, "/tmp/dispatch-fixture-root");
        assert_eq!(entry.name, "dispatch-fixture-root");
        assert_eq!(entry.added_at, entry.last_opened_at);

        let read_back = read_registry_at(&path);
        assert_eq!(read_back, vec![entry]);
    }

    #[test]
    fn upsert_at_normalizes_a_trailing_slash_and_dedupes() {
        let path = temp_registry();
        let first = upsert_at(&path, "/tmp/dispatch-fixture-root/").unwrap();
        // Stored path has no trailing slash — parity with `normalize_root`/`registry.ts`.
        assert_eq!(first.path, "/tmp/dispatch-fixture-root");

        // Re-registering the same directory (no trailing slash this time) must
        // update the existing entry, not add a second one, and must preserve the
        // original `addedAt` while bumping `lastOpenedAt`.
        let second = upsert_at(&path, "/tmp/dispatch-fixture-root").unwrap();
        assert_eq!(second.added_at, first.added_at);
        assert!(second.last_opened_at >= first.last_opened_at);

        let read_back = read_registry_at(&path);
        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].path, "/tmp/dispatch-fixture-root");
    }

    #[test]
    fn upsert_at_rejects_a_relative_path() {
        let path = temp_registry();
        assert!(upsert_at(&path, "relative/path").is_err());
    }

    #[test]
    fn most_recent_path_at_returns_the_max_last_opened_entry() {
        let path = temp_registry();
        std::fs::write(
            &path,
            r#"{
  "projects": [
    { "path": "/a", "name": "a", "addedAt": "2026-01-01T00:00:00.000Z", "lastOpenedAt": "2026-01-01T00:00:00.000Z" },
    { "path": "/b", "name": "b", "addedAt": "2026-01-01T00:00:00.000Z", "lastOpenedAt": "2026-07-01T00:00:00.000Z" },
    { "path": "/c", "name": "c", "addedAt": "2026-01-01T00:00:00.000Z", "lastOpenedAt": "2026-03-01T00:00:00.000Z" }
  ]
}
"#,
        )
        .unwrap();
        assert_eq!(most_recent_path_at(&path), Some("/b".to_string()));
    }

    #[test]
    fn most_recent_path_at_is_none_for_an_empty_registry() {
        assert!(most_recent_path_at(Path::new("/nonexistent/projects.json")).is_none());
    }

    /// The cross-language byte-compat guard: a registry written by this Rust
    /// code must be byte-identical to what `registry.ts`'s `writeRegistry`
    /// produces — `{ "projects": [...] }`, `camelCase` keys, 2-space indent,
    /// trailing newline. If serde's output ever drifts from
    /// `JSON.stringify({ projects }, null, 2) + '\n'`, this fails loudly.
    #[test]
    fn registry_roundtrip_json_matches_the_typescript_shape() {
        let file = RegistryFile {
            projects: vec![RegisteredProject {
                path: "/Users/x/Sites/dispatch".to_string(),
                name: "dispatch".to_string(),
                added_at: "2026-07-22T12:34:56.789Z".to_string(),
                last_opened_at: "2026-07-22T12:34:56.789Z".to_string(),
            }],
        };
        let json = serde_json::to_string_pretty(&file).unwrap();
        let with_newline = format!("{json}\n");

        let expected = "{\n  \"projects\": [\n    {\n      \"path\": \"/Users/x/Sites/dispatch\",\n      \"name\": \"dispatch\",\n      \"addedAt\": \"2026-07-22T12:34:56.789Z\",\n      \"lastOpenedAt\": \"2026-07-22T12:34:56.789Z\"\n    }\n  ]\n}\n";
        assert_eq!(with_newline, expected);
    }

    #[test]
    fn empty_registry_serializes_like_the_typescript_side() {
        let file = RegistryFile { projects: vec![] };
        let json = serde_json::to_string_pretty(&file).unwrap();
        assert_eq!(format!("{json}\n"), "{\n  \"projects\": []\n}\n");
    }
}
