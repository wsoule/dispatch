// cspell:ignore FEFF -- the byte-order mark's code point, in char escapes below
//! Saves a file from dispatchd's workspace to the user's Downloads folder, for the file
//! preview's Download link in the desktop app (`downloadWorkspaceFile` in `src/lib/tauri.ts`).
//!
//! wry cancels an `<a download>` when the app sets no download handler, so the page's
//! save-a-blob path saves nothing in this app. Instead the page hands this command the raw
//! route's address (`client.workspaceFileUrl`, which carries no credential), and the bytes go
//! from the daemon to disk on this side, chunk by chunk, never through the webview's memory.
//! The credential is the request-tier agent token from the verified daemon's own discovery
//! file (`sidecar::agent_token_for_port`), read here and sent only to that daemon, straight
//! (never through a proxy) and never after a redirect. No token crosses this IPC call and none
//! is ever put in a URL. That is not a token boundary: the page already holds the daemon's
//! tokens through `ensure_dispatchd`. What this command keeps out of the webview is the bytes.
//!
//! The file lands in Downloads under a name that never replaces an existing file, never hides
//! itself (a leading dot becomes `_`), and never carries a bidirectional override that would
//! disguise its extension. The bytes stream into a `.download` sibling first and take the
//! real name only once complete, so an interrupted run never leaves a truncated file that
//! looks finished.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::{loopback, sidecar};

/// The daemon route that serves a workspace file's bytes (`GET /api/files/raw`).
const RAW_ROUTE: &str = "/api/files/raw";

/// How many numbered copies ("name (1).ext" …) to try before giving up on a free name.
const MAX_COPY_NUMBER: u32 = 999;

/// How long the daemon may go silent mid-download (no headers, or no next chunk) before the
/// download is given up. Per read, not in total: a large file may take as long as it needs.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// What a raw-route address the page sent names, once checked.
#[derive(Debug, PartialEq, Eq)]
struct RawFileRequest {
    /// The checked address itself: loopback, the raw route, a `path` query.
    url: reqwest::Url,
    /// The daemon's port, used to find its discovery file.
    port: u16,
    /// The name to save under, from the workspace path's last segment.
    file_name: String,
}

/// Checks that `raw` is the raw route of a daemon on this computer
/// (`http://127.0.0.1:<port>/api/files/raw?path=…[&runId=…]`) and reads out the port and the
/// name to save under. Anything else is refused, so the agent token this command attaches can
/// only ever go to a loopback daemon's raw route.
fn parse_raw_file_url(raw: &str) -> Result<RawFileRequest, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("Not a file address: {e}"))?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.path() != RAW_ROUTE {
        return Err("Only a file from this computer's Dispatch daemon can be saved.".to_string());
    }
    let port = url
        .port()
        .ok_or_else(|| "The file address names no daemon port.".to_string())?;
    let path = url
        .query_pairs()
        .find(|(key, _)| key == "path")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The file address names no file.".to_string())?;
    Ok(RawFileRequest {
        file_name: download_name(&path),
        url,
        port,
    })
}

/// Whether `c` may not appear in a saved file's name: a control character, the `:` a file
/// system would split on, or a bidirectional or format control (U+061C, U+200E/U+200F,
/// U+202A–U+202E, U+2066–U+2069, U+FEFF), which can make "résumé \u{202E}gpj.exe" read as
/// "résumé exe.jpg" in Finder and on the page.
fn unsafe_in_name(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            ':' | '\u{061C}'
                | '\u{200E}'
                | '\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// The name a workspace file is saved under: its path's last segment, with the characters
/// `unsafe_in_name` refuses replaced by `_`, and "download" when nothing usable is left (an
/// empty name, `.` or `..`). Leading dots become `_` too, as a browser does, so a download
/// is never a hidden file and never a startup file such as `.bash_profile` or `.npmrc`.
fn download_name(path: &str) -> String {
    let last = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last
        .chars()
        .map(|c| if unsafe_in_name(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "download".to_string();
    }
    let visible = trimmed.trim_start_matches('.');
    let dots = trimmed.len() - visible.len();
    format!("{}{visible}", "_".repeat(dots))
}

/// The folder a download is saved into: the platform's Downloads folder (`downloads`), or
/// `<home>/Downloads` when the platform names none or names the home folder itself (Linux
/// without `XDG_DOWNLOAD_DIR` in user-dirs.dirs, or with it set to `$HOME`, which is how
/// xdg-user-dirs turns a folder off). Never the home folder, where a workspace file could
/// become a live shell or tool startup file.
fn download_dir_from(downloads: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    match (downloads, home) {
        (Some(dir), Some(home)) if dir.components().eq(home.components()) => {
            Some(home.join("Downloads"))
        }
        (Some(dir), _) => Some(dir),
        (None, Some(home)) => Some(home.join("Downloads")),
        (None, None) => None,
    }
}

/// The folder the app saves a file into for the user (a workspace download here, an exported
/// report or transcript in `commands`): `download_dir_from` applied to this computer's
/// Downloads and home folders, so it is never the home folder itself.
pub(crate) fn download_dir() -> Option<PathBuf> {
    download_dir_from(dirs::download_dir(), dirs::home_dir())
}

/// The `n`th candidate name for `name`: the name itself first, then "stem (1).ext",
/// "stem (2).ext" …, the way a browser names a second copy. A name whose only dot leads it
/// (".env") counts as all stem.
fn numbered_name(name: &str, n: u32) -> String {
    if n == 0 {
        return name.to_string();
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({n}).{ext}"),
        _ => format!("{name} ({n})"),
    }
}

/// Creates the first free candidate for `name` in `dir` and returns it open for writing. The
/// file is created with `create_new`, so an existing file is never overwritten, even one that
/// appears between the check and the write.
fn create_unique(dir: &Path, name: &str) -> Result<(PathBuf, File), String> {
    for n in 0..=MAX_COPY_NUMBER {
        let path = dir.join(numbered_name(name, n));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create {}: {e}", path.display())),
        }
    }
    Err(format!(
        "{} already holds {MAX_COPY_NUMBER} copies of {name}.",
        dir.display()
    ))
}

/// A download being written: its reserved final name (an empty placeholder, so nothing else
/// takes the name meanwhile) and the `.download` sibling the bytes stream into.
struct PendingFile {
    target: PathBuf,
    part: PathBuf,
    file: File,
}

impl PendingFile {
    /// Reserves the first free name for `name` in `dir` and opens a free "<that name>.download"
    /// beside it, both with `create_new`. A run cut off part way (the app quits or crashes)
    /// leaves that obviously unfinished `.download` file and an empty placeholder, never a
    /// truncated file under the name a complete one would have.
    fn create(dir: &Path, name: &str) -> Result<Self, String> {
        let (target, placeholder) = create_unique(dir, name)?;
        drop(placeholder);
        let reserved = target
            .file_name()
            .map_or_else(|| name.to_string(), |n| n.to_string_lossy().into_owned());
        match create_unique(dir, &format!("{reserved}.download")) {
            Ok((part, file)) => Ok(Self { target, part, file }),
            Err(error) => {
                let _ = std::fs::remove_file(&target);
                Err(error)
            }
        }
    }

    /// Gives the finished bytes the real name. The rename replaces only the empty placeholder
    /// this download reserved, never anyone else's file.
    fn finish(self) -> Result<PathBuf, String> {
        let Self { target, part, file } = self;
        drop(file);
        if let Err(e) = std::fs::rename(&part, &target) {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&target);
            return Err(format!("Could not finish {}: {e}", target.display()));
        }
        Ok(target)
    }

    /// Removes the partial file and the placeholder after a failed download.
    fn abandon(self) {
        let Self { target, part, file } = self;
        drop(file);
        let _ = std::fs::remove_file(&part);
        let _ = std::fs::remove_file(&target);
    }
}

/// The page's words for a failed request or body read: a stall past `READ_TIMEOUT` says so in
/// plain terms (reqwest reports it as a body decoding error), anything else is `what: error`.
fn transfer_error(what: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!(
            "The daemon sent nothing for {} seconds, so the download stopped.",
            READ_TIMEOUT.as_secs()
        )
    } else {
        format!("{what}: {error}")
    }
}

/// Writes the response body to `file` as it arrives. Each chunk is a few kilobytes, so the
/// plain blocking write is brief; the file is never held in memory whole.
async fn copy_body(response: &mut reqwest::Response, file: &mut File) -> Result<(), String> {
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| transfer_error("The download stopped", &e))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("Could not write the file: {e}"))?;
    }
    file.flush()
        .map_err(|e| format!("Could not write the file: {e}"))
}

/// Saves the workspace file `url` names (the raw route's address, as `workspaceFileUrl` builds
/// it) into the user's Downloads folder (`download_dir_from`) under a name that never replaces
/// an existing file, and returns the saved file's absolute path for the page's "Saved to …"
/// line. A download that fails part way, or stalls for `READ_TIMEOUT`, removes its partial
/// file.
#[tauri::command]
pub async fn download_workspace_file(url: String) -> Result<String, String> {
    let request = parse_raw_file_url(&url)?;
    // Straight to the loopback daemon (`loopback::builder`: no system proxy, which would
    // otherwise see the agent token, and no redirects, which the token must not follow), with
    // a per-read timeout so a stalled daemon frees the page's link.
    let client = loopback::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let token = sidecar::agent_token_for_port(&client, request.port).await?;
    let mut response = client
        .get(request.url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| transfer_error("The daemon did not send the file", &e))?;
    if !response.status().is_success() {
        return Err(format!(
            "The daemon did not send the file (HTTP {}).",
            response.status()
        ));
    }

    let dir = download_dir()
        .ok_or_else(|| "Could not find a folder to save the file into.".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let mut pending = PendingFile::create(&dir, &request.file_name)?;
    if let Err(error) = copy_body(&mut response, &mut pending.file).await {
        pending.abandon();
        return Err(error);
    }
    let path = pending.finish()?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_raw_file_url_reads_the_port_and_the_saved_name() {
        let request =
            parse_raw_file_url("http://127.0.0.1:4771/api/files/raw?path=logs/dump.log&runId=r1")
                .expect("a loopback raw route parses");
        assert_eq!(request.port, 4771);
        assert_eq!(request.file_name, "dump.log");
        assert_eq!(request.url.query(), Some("path=logs/dump.log&runId=r1"));
    }

    #[test]
    fn parse_raw_file_url_refuses_anything_but_a_loopback_raw_route() {
        for refused in [
            "https://127.0.0.1:4771/api/files/raw?path=a",
            "http://example.com:4771/api/files/raw?path=a",
            "http://localhost:4771/api/files/raw?path=a",
            "http://127.0.0.1:4771/api/files/read?path=a",
            "http://127.0.0.1:4771/api/files/raw/../../api/team/tokens?path=a",
            "http://127.0.0.1/api/files/raw?path=a",
            "http://127.0.0.1:4771/api/files/raw",
            "http://127.0.0.1:4771/api/files/raw?path=",
            "not a url",
        ] {
            assert!(
                parse_raw_file_url(refused).is_err(),
                "{refused} should be refused"
            );
        }
    }

    #[test]
    fn download_name_keeps_only_a_safe_last_segment() {
        assert_eq!(download_name("src/app/main.rs"), "main.rs");
        assert_eq!(download_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(download_name("weird:name\u{7}.bin"), "weird_name_.bin");
        assert_eq!(download_name("dir/"), "download");
        assert_eq!(download_name(".."), "download");
        assert_eq!(download_name("   "), "download");
    }

    #[test]
    fn download_name_never_saves_a_hidden_or_startup_file() {
        assert_eq!(download_name(".env"), "_env");
        assert_eq!(download_name("home/.bash_profile"), "_bash_profile");
        assert_eq!(download_name("..npmrc"), "__npmrc");
        assert_eq!(download_name("a.b.c"), "a.b.c");
    }

    #[test]
    fn download_name_drops_bidi_and_format_controls() {
        assert_eq!(download_name("a\u{202E}gpj.exe"), "a_gpj.exe");
        assert_eq!(
            download_name("sub/résumé \u{202E}gpj.exe"),
            "résumé _gpj.exe"
        );
        for c in [
            '\u{061C}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202D}', '\u{2066}', '\u{2069}',
            '\u{FEFF}',
        ] {
            assert_eq!(download_name(&format!("x{c}y.txt")), "x_y.txt");
        }
    }

    #[test]
    fn numbered_name_numbers_the_stem_like_a_browser() {
        assert_eq!(numbered_name("report.pdf", 0), "report.pdf");
        assert_eq!(numbered_name("report.pdf", 1), "report (1).pdf");
        assert_eq!(numbered_name("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(numbered_name("Makefile", 3), "Makefile (3)");
        assert_eq!(numbered_name(&download_name(".env"), 1), "_env (1)");
        assert_eq!(
            numbered_name("dump.log.download", 1),
            "dump.log (1).download"
        );
    }

    #[test]
    fn download_dir_is_never_the_home_folder() {
        let home = PathBuf::from("/home/u");
        let downloads = PathBuf::from("/home/u/Downloads");
        assert_eq!(
            download_dir_from(Some(PathBuf::from("/data/dl")), Some(home.clone())),
            Some(PathBuf::from("/data/dl"))
        );
        // No XDG_DOWNLOAD_DIR in user-dirs.dirs: dirs names no Downloads folder.
        assert_eq!(
            download_dir_from(None, Some(home.clone())),
            Some(downloads.clone())
        );
        // XDG_DOWNLOAD_DIR="$HOME/", how xdg-user-dirs turns a folder off.
        assert_eq!(
            download_dir_from(Some(PathBuf::from("/home/u/")), Some(home.clone())),
            Some(downloads)
        );
        assert_eq!(download_dir_from(None, None), None);
        for (dl, h) in [
            (None, Some(home.clone())),
            (Some(home.clone()), Some(home.clone())),
        ] {
            assert_ne!(download_dir_from(dl, h), Some(home.clone()));
        }
    }

    #[test]
    fn download_dir_on_this_computer_is_not_the_home_folder() {
        // What exports and downloads really use: whatever this machine's Downloads setting
        // is, the answer is never the home folder.
        if let Some(home) = dirs::home_dir() {
            let dir = download_dir().expect("a home folder always yields a folder");
            assert!(!dir.components().eq(home.components()), "{dir:?}");
        }
    }

    #[test]
    fn create_unique_never_replaces_an_existing_file() {
        let dir =
            std::env::temp_dir().join(format!("dispatch-downloads-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("dump.log"), "first").unwrap();

        let (second, _) = create_unique(&dir, "dump.log").unwrap();
        assert_eq!(second, dir.join("dump (1).log"));
        let (third, _) = create_unique(&dir, "dump.log").unwrap();
        assert_eq!(third, dir.join("dump (2).log"));
        assert_eq!(
            std::fs::read_to_string(dir.join("dump.log")).unwrap(),
            "first"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_pending_file_takes_its_name_only_when_finished() {
        let dir =
            std::env::temp_dir().join(format!("dispatch-downloads-pending-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("dump.log"), "someone else's").unwrap();

        // Finished: the bytes move from the .download sibling onto the reserved name.
        let mut pending = PendingFile::create(&dir, "dump.log").unwrap();
        assert_eq!(pending.target, dir.join("dump (1).log"));
        assert_eq!(pending.part, dir.join("dump (1).log.download"));
        // Until then the real name holds only an empty placeholder.
        assert_eq!(std::fs::read(dir.join("dump (1).log")).unwrap(), b"");
        pending.file.write_all(b"all of it").unwrap();
        let saved = pending.finish().unwrap();
        assert_eq!(saved, dir.join("dump (1).log"));
        assert_eq!(std::fs::read_to_string(&saved).unwrap(), "all of it");
        assert!(!dir.join("dump (1).log.download").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("dump.log")).unwrap(),
            "someone else's"
        );

        // Abandoned: neither the partial file nor the placeholder stays.
        let mut failed = PendingFile::create(&dir, "dump.log").unwrap();
        assert_eq!(failed.target, dir.join("dump (2).log"));
        failed.file.write_all(b"half").unwrap();
        failed.abandon();
        assert!(!dir.join("dump (2).log").exists());
        assert!(!dir.join("dump (2).log.download").exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
