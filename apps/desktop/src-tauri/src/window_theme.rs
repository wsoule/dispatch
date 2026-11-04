//! The window's theme, kept natively so the first frames of a launch already show the
//! person's Light or Dark choice instead of the OS appearance.
//!
//! The page stores the choice in the webview's `localStorage` (`dispatch:theme`), which this
//! side cannot read before it opens the window. So the page also hands every change to
//! `remember_window_theme` (`followThemeInNativeWindow` in `src/lib/nativeTheme.ts` calls it
//! through `rememberWindowTheme` in `src/lib/tauri.ts`), which writes one word to a small file
//! in the app config dir, and `create_main_window` reads it before building the window
//! (tauri.conf.json marks the window `create: false` so setup builds it here instead).
//! `localStorage` stays the page's source of truth: this copy only removes the launch flash.

use std::path::{Path, PathBuf};

use tauri::{Manager, Theme};

/// The file under the app config dir that holds "light" or "dark"; no file means System.
const THEME_FILE: &str = "window-theme";

/// The label of the app's one window, as tauri.conf.json leaves it (the default) and the
/// capability in `capabilities/default.json` names it.
const MAIN_WINDOW: &str = "main";

fn theme_file(dir: &Path) -> PathBuf {
    dir.join(THEME_FILE)
}

/// Reads a stored word: "light" and "dark" pin the window to that appearance; anything else
/// (System, an empty file, garbage) leaves it to the OS.
fn parse_theme(word: &str) -> Option<Theme> {
    match word.trim() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

/// The theme stored under `dir`, or `None` (follow the OS) when there is none or it cannot
/// be read: a missing or broken file must never stop the window from opening.
fn read_stored_theme(dir: &Path) -> Option<Theme> {
    std::fs::read_to_string(theme_file(dir))
        .ok()
        .as_deref()
        .and_then(parse_theme)
}

/// Stores the page's theme choice under `dir`: "light" or "dark" is written, "system" removes
/// the file so the next launch follows the OS. Any other word is refused, so the file only
/// ever holds what `parse_theme` reads.
fn store_theme(dir: &Path, choice: &str) -> Result<(), String> {
    let path = theme_file(dir);
    match choice {
        "light" | "dark" => {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
            std::fs::write(&path, choice)
                .map_err(|e| format!("could not write {}: {e}", path.display()))
        }
        "system" => match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not remove {}: {e}", path.display())),
        },
        other => Err(format!("unknown theme choice {other:?}")),
    }
}

/// Remembers the page's theme choice ("light", "dark" or "system") for the next launch's
/// first frames. Called by the page whenever the shown theme changes, and once at startup.
#[tauri::command]
pub fn remember_window_theme(app: tauri::AppHandle, choice: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    store_theme(&dir, &choice)
}

/// Builds the main window from its tauri.conf.json entry with the remembered theme applied
/// before it is shown, so a Dark choice on a light OS (or the reverse) never opens on the
/// wrong appearance. With no remembered theme the window follows the OS, as before.
pub fn create_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .ok_or("tauri.conf.json has no main window")?
        .clone();
    let stored = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| read_stored_theme(&dir));
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .theme(stored)
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "dispatch-window-theme-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn parse_theme_reads_only_light_and_dark() {
        assert_eq!(parse_theme("light"), Some(Theme::Light));
        assert_eq!(parse_theme("dark\n"), Some(Theme::Dark));
        assert_eq!(parse_theme("system"), None);
        assert_eq!(parse_theme(""), None);
        assert_eq!(parse_theme("Dark"), None);
    }

    #[test]
    fn a_stored_choice_reads_back_and_system_removes_it() {
        let dir = temp_dir("roundtrip");
        assert_eq!(read_stored_theme(&dir), None);

        store_theme(&dir, "dark").unwrap();
        assert_eq!(read_stored_theme(&dir), Some(Theme::Dark));
        store_theme(&dir, "light").unwrap();
        assert_eq!(read_stored_theme(&dir), Some(Theme::Light));
        store_theme(&dir, "system").unwrap();
        assert_eq!(read_stored_theme(&dir), None);
        // System again, with no file left, is not an error.
        store_theme(&dir, "system").unwrap();

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_unknown_choice_is_refused_and_leaves_the_stored_one() {
        let dir = temp_dir("unknown");
        store_theme(&dir, "dark").unwrap();
        assert!(store_theme(&dir, "sepia").is_err());
        assert_eq!(read_stored_theme(&dir), Some(Theme::Dark));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
