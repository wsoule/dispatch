//! Maps a Dispatch run worktree back to the project it was checked out from.
//!
//! Every Dispatch run executes its agent inside `<home>/.dispatch/worktrees/<key>/<run id>`,
//! where `<key>` is `sidecar::daemon_file_key(projectRoot)`. Transcripts written there carry
//! that worktree as their `cwd`, so without this mapping every run would surface on the
//! Dashboard as its own project named after the run id.

use crate::sidecar::daemon_file_key;
use std::path::Path;

const WORKTREES_SEGMENT: &str = "/.dispatch/worktrees/";

/// The parts of a worktree-shaped path: the worktree root (`.../<key>/<run id>`) and the
/// 12-hex project key. `None` when `path` isn't under a Dispatch worktrees directory.
struct WorktreeShape<'a> {
    root: &'a str,
    key: &'a str,
}

/// Recognises `.../.dispatch/worktrees/<12 lowercase hex>/<segment>` anywhere in `path`,
/// including when `path` is a subdirectory of that worktree.
fn worktree_shape(path: &str) -> Option<WorktreeShape<'_>> {
    let marker = path.find(WORKTREES_SEGMENT)?;
    let after_marker = marker + WORKTREES_SEGMENT.len();
    let rest = &path[after_marker..];
    let mut segments = rest.splitn(3, '/');
    let key = segments.next()?;
    let run = segments.next()?;
    let is_key = key.len() == 12
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !is_key || run.is_empty() {
        return None;
    }
    let root_end = after_marker + key.len() + 1 + run.len();
    Some(WorktreeShape {
        root: &path[..root_end],
        key,
    })
}

/// Reads the repo root from a worktree's `.git` file. Git writes a linked worktree's `.git`
/// as a plain file holding `gitdir: <repo>/.git/worktrees/<name>`; the repo root is
/// everything before `/.git/`. `None` for a real `.git` directory or any other content.
fn repo_root_from_git_file(worktree_root: &str) -> Option<String> {
    let git_path = Path::new(worktree_root).join(".git");
    if !std::fs::metadata(&git_path).ok()?.is_file() {
        return None;
    }
    let contents = std::fs::read_to_string(&git_path).ok()?;
    contents.lines().find_map(|line| {
        let gitdir = line.strip_prefix("gitdir:")?.trim();
        let marker = gitdir.find("/.git/worktrees/")?;
        Some(gitdir[..marker].to_string())
    })
}

/// Resolves a transcript `cwd` to the project it should be attributed to. Non-worktree
/// paths come back unchanged. Worktree paths resolve via the worktree's `.git` file first,
/// then by matching the path's project key against `known_roots`; when neither identifies
/// the repo the path is returned unchanged rather than guessed.
pub(crate) fn canonical_project_cwd(cwd: &str, known_roots: &[String]) -> String {
    let Some(shape) = worktree_shape(cwd) else {
        return cwd.to_string();
    };
    if let Some(root) = repo_root_from_git_file(shape.root) {
        return root;
    }
    known_roots
        .iter()
        .find(|root| daemon_file_key(root.trim_end_matches('/')) == shape.key)
        .cloned()
        .unwrap_or_else(|| cwd.to_string())
}

/// True when `path` has the Dispatch worktree shape — the cheap pre-check callers use
/// before gathering `known_roots`, which needs registry and database reads.
pub(crate) fn is_dispatch_worktree_path(path: &str) -> bool {
    worktree_shape(path).is_some()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Unique scratch directory per call; the counter keeps parallel tests apart.
    pub(crate) fn temp_dir(label: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "dispatch-worktree-test-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Lays out `<tmp>/repo` and `<tmp>/.dispatch/worktrees/<key>/r-abc` with a linked
    /// worktree `.git` file pointing back at the repo. Returns (repo root, worktree root).
    pub(crate) fn linked_worktree(label: &str) -> (String, String) {
        let tmp = temp_dir(label);
        let repo = tmp.join("repo");
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("r-abc")).unwrap();
        let repo = repo.to_string_lossy().to_string();
        let worktree = tmp
            .join(".dispatch")
            .join("worktrees")
            .join(daemon_file_key(&repo))
            .join("r-abc");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {repo}/.git/worktrees/r-abc\n"),
        )
        .unwrap();
        (repo, worktree.to_string_lossy().to_string())
    }

    #[test]
    fn worktree_with_git_file_resolves_to_the_repo_root() {
        let (repo, worktree) = linked_worktree("git-file");
        assert_eq!(canonical_project_cwd(&worktree, &[]), repo);
    }

    #[test]
    fn nested_subdirectory_of_a_worktree_resolves_to_the_repo_root() {
        let (repo, worktree) = linked_worktree("nested");
        let nested = format!("{worktree}/packages/core/src");
        assert_eq!(canonical_project_cwd(&nested, &[]), repo);
    }

    #[test]
    fn without_a_git_file_a_known_root_with_the_matching_key_wins() {
        let root = "/Users/someone/Sites/dispatch".to_string();
        let cwd = format!(
            "/Users/someone/.dispatch/worktrees/{}/r-34f186",
            daemon_file_key(&root)
        );
        let known = vec!["/Users/someone/Sites/other".to_string(), root.clone()];
        assert_eq!(canonical_project_cwd(&cwd, &known), root);
    }

    #[test]
    fn unresolvable_worktree_path_is_returned_unchanged() {
        let cwd = "/Users/someone/.dispatch/worktrees/0123456789ab/r-34f186";
        let known = vec!["/Users/someone/Sites/other".to_string()];
        assert_eq!(canonical_project_cwd(cwd, &known), cwd);
        assert!(is_dispatch_worktree_path(cwd));
    }

    #[test]
    fn ordinary_path_is_returned_unchanged() {
        let cwd = "/Users/someone/Sites/dispatch";
        assert_eq!(canonical_project_cwd(cwd, &[cwd.to_string()]), cwd);
        assert!(!is_dispatch_worktree_path(cwd));
    }

    #[test]
    fn worktrees_path_with_a_non_hex_key_is_returned_unchanged() {
        let cwd = "/Users/someone/.dispatch/worktrees/not-a-key/r-34f186";
        assert_eq!(canonical_project_cwd(cwd, &[]), cwd);
        assert!(!is_dispatch_worktree_path(cwd));
        // Uppercase hex and wrong lengths are not keys either.
        assert!(!is_dispatch_worktree_path(
            "/x/.dispatch/worktrees/0123456789AB/r-1"
        ));
        assert!(!is_dispatch_worktree_path(
            "/x/.dispatch/worktrees/0123456789abc/r-1"
        ));
        // A key with no run segment after it is the worktrees parent, not a worktree.
        assert!(!is_dispatch_worktree_path(
            "/x/.dispatch/worktrees/0123456789ab"
        ));
        assert!(!is_dispatch_worktree_path(
            "/x/.dispatch/worktrees/0123456789ab/"
        ));
    }

    #[test]
    fn a_git_directory_rather_than_file_does_not_resolve() {
        let tmp = temp_dir("git-dir");
        let worktree = tmp
            .join(".dispatch")
            .join("worktrees")
            .join("0123456789ab")
            .join("r-1");
        std::fs::create_dir_all(worktree.join(".git")).unwrap();
        let cwd = worktree.to_string_lossy().to_string();
        assert_eq!(canonical_project_cwd(&cwd, &[]), cwd);
    }
}
