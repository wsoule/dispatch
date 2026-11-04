/// Every command `src/lib.rs` registers with `generate_handler!`. Listing them here gives each
/// an `allow-<command>` permission (underscores become hyphens), and once the app has this
/// manifest Tauri refuses any app command no capability grants, so
/// `capabilities/default.json` grants each one to the main window only and nothing else can
/// call it. `src/lib/tauriCommands.test.ts` checks that the handler list, this list and the
/// capability stay in step, since a command missing here or there would only fail at runtime.
const COMMANDS: &[&str] = &[
    "git_setup_status",
    "install_git",
    "set_git_identity",
    "project_folder_state",
    "prepare_project_folder",
    "install_cli_command",
    "list_projects",
    "list_sessions",
    "get_session_detail",
    "open_in_editor",
    "dashboard_stats",
    "generate_report",
    "export_report",
    "export_transcript",
    "reveal_in_finder",
    "get_file_diff_for_session_file",
    "open_url",
    "ensure_dispatchd",
    "restart_dispatchd",
    "has_dispatch",
    "current_project_root",
    "list_registered_projects",
    "add_project",
    "touch_project_opened",
    "list_github_repos",
    "clone_github_repo",
    "download_workspace_file",
    "remember_window_theme",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri-build failed");
}
