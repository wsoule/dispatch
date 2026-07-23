import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import type {
  BoardColumn,
  BoardData,
  Card,
  DashboardStats,
  FileDiff,
  GitInsights,
  ProjectSummary,
  ReportData,
  Session,
  SessionDetail,
} from './types';

// True when running inside the Tauri webview (the packaged/dev desktop app),
// false when the same React bundle is served by plain Vite in a browser. Used
// for the browser-dev fallback below: opening the Vite URL with
// `?root=<abs path>&port=<dispatchd port>` lets the whole dispatch UI run and be
// inspected in an ordinary browser (devtools, automation) against an already
// running daemon — Tauri IPC (`invoke`) is simply unavailable there.
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function browserParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function listProjects(): Promise<ProjectSummary[]> {
  // Relay's project enumeration is backed by Tauri IPC; in the browser dev
  // harness there's no backend, so degrade to an empty list rather than
  // throwing (the switcher dropdown simply shows only the active project).
  if (!isTauri()) return Promise.resolve([]);
  return invoke('list_projects');
}

export function listSessions(): Promise<Session[]> {
  return invoke('list_sessions');
}

export function getSessionDetail(
  sessionId: string
): Promise<SessionDetail | null> {
  return invoke('get_session_detail', { sessionId });
}

export function openInEditor(path: string): Promise<void> {
  return invoke('open_in_editor', { path });
}

export function getProjectActivity(projectPath: string): Promise<number[]> {
  return invoke('project_activity', { projectPath });
}

export function getProjectGitInsights(
  projectPath: string
): Promise<GitInsights> {
  return invoke('project_git_insights', { projectPath });
}

export function getDashboardStats(): Promise<DashboardStats> {
  return invoke('dashboard_stats');
}

export function generateReport(rangeDays: number): Promise<ReportData> {
  return invoke('generate_report', { rangeDays });
}

/** Writes the report as Markdown to the user's Downloads folder and resolves to the
 * absolute path it was saved at, for a "Reveal in Finder" follow-up action. */
export function exportReport(rangeDays: number): Promise<string> {
  return invoke('export_report', { rangeDays });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke('reveal_in_finder', { path });
}

export function openUrl(url: string): Promise<void> {
  return invoke('open_url', { url });
}

/** Writes the session's transcript as Markdown to the user's Downloads folder and resolves
 * to the absolute path it was saved at, for a "Reveal in Finder" follow-up action. */
export function exportTranscript(sessionId: string): Promise<string> {
  return invoke('export_transcript', { sessionId });
}

export function getFileDiffForSessionFile(
  sessionId: string,
  filePath: string
): Promise<FileDiff | null> {
  return invoke('get_file_diff_for_session_file', { sessionId, filePath });
}

export function getBoard(projectId: string): Promise<BoardData> {
  return invoke('get_board', { projectId });
}

export function createCard(
  boardId: string,
  columnId: string,
  title: string,
  description?: string
): Promise<Card> {
  return invoke('create_card', {
    boardId,
    columnId,
    title,
    description: description ?? null,
  });
}

export function moveCard(
  cardId: string,
  columnId: string,
  position: number
): Promise<void> {
  return invoke('move_card', { cardId, columnId, position });
}

export function updateCard(
  cardId: string,
  title: string,
  description?: string
): Promise<void> {
  return invoke('update_card', {
    cardId,
    title,
    description: description ?? null,
  });
}

export function deleteCard(cardId: string): Promise<void> {
  return invoke('delete_card', { cardId });
}

export function linkSessionToCard(
  cardId: string,
  sessionId: string
): Promise<void> {
  return invoke('link_session_to_card', { cardId, sessionId });
}

export function createColumn(
  boardId: string,
  name: string
): Promise<BoardColumn> {
  return invoke('create_column', { boardId, name });
}

export function renameColumn(columnId: string, name: string): Promise<void> {
  return invoke('rename_column', { columnId, name });
}

/** Attaches the card's title/description to a live `claude` terminal session for its
 * project (or opens a new one) — see `terminal::attach_or_launch` on the backend for the
 * full behavior. Resolves to a short outcome string (or a "skipped: ..." reason if the card
 * wasn't eligible), never rejects for an ineligible card — only for an actual failure to
 * reach/drive Terminal.app. */
export function launchOrAttachSession(cardId: string): Promise<string> {
  return invoke('launch_or_attach_session', { cardId });
}

/** True if `root` (a project's absolute path) has a `.dispatch/` directory — gates whether
 * `ProjectDetail` offers a Tasks tab at all. Pure filesystem check on the backend, no daemon
 * involved. */
export function hasDispatch(root: string): Promise<boolean> {
  // Browser-dev fallback: if a `port` param is present the caller has already
  // pointed us at a running daemon, so the project is dispatch-enabled by
  // definition.
  if (!isTauri()) return Promise.resolve(browserParam('port') !== null);
  return invoke('has_dispatch', { root });
}

/** Ensures a `dispatchd` sidecar is running for `root` and resolves to its port — reuses an
 * already-healthy daemon if one exists, otherwise spawns one (`bun packages/server/src/bin.ts
 * --root <root>`, dev-only wiring) and waits up to 5s for it to come up. See
 * `sidecar::ensure_dispatchd` on the backend. Rejects if `bun` isn't on `PATH` or the daemon
 * never becomes healthy in time. */
export function ensureDispatchd(root: string): Promise<number> {
  // Browser-dev fallback: the daemon is already running (started outside the
  // app); take its port straight from the URL param instead of spawning one.
  if (!isTauri()) {
    const port = browserParam('port');
    return port !== null
      ? Promise.resolve(Number(port))
      : Promise.reject(new Error('no ?port= param for browser-dev mode'));
  }
  return invoke('ensure_dispatchd', { root });
}

/** The single project this window is scoped to — the app's one active project root, resolved
 * on the backend (see `commands::current_project_root`'s doc comment for the `tauri dev` vs
 * packaged-app resolution). Replaces the old `listProjects` + per-path `hasDispatch` fan-out
 * that used to decide which of Relay's *many* discovered projects was "active" — this app is a
 * single-project workspace now, not a switcher.
 *
 * Resolves to `null` — not a rejection — on a genuine first run (empty registry, no launch
 * arg, no dev checkout above the binary): that's an expected state the frontend handles by
 * offering "+ Add project", not an error to surface as a fatal screen. */
export function currentProjectRoot(): Promise<string | null> {
  // Browser-dev fallback: the active project root comes from the URL param so the full UI can
  // run against a live daemon in a plain browser. A missing `?root=` resolves to `null` (same
  // "no project yet" contract as the packaged app), matching this function's return type
  // rather than rejecting.
  if (!isTauri()) {
    return Promise.resolve(browserParam('root'));
  }
  return invoke('current_project_root');
}

// --- Project registry + onboarding (Task 8) ---

/** A project the user has added/opened, as stored in `~/.dispatch/projects.json`. The Rust
 * side returns `addedAt`/`lastOpenedAt` too, but the switcher only needs these two fields. */
export interface RegisteredProject {
  path: string;
  name: string;
}

/** Every project in the registry — the persistent half of the switcher's project list.
 * Browser-dev fallback: no backend, so an empty list (the switcher just shows the active
 * project), matching `listProjects`'s own degrade-to-empty behavior. */
export function listRegisteredProjects(): Promise<RegisteredProject[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke('list_registered_projects');
}

/** Registers `path` (must be an existing directory) and resolves to the normalized absolute
 * path stored for it — the caller then switches the window to that path. Rejects in
 * browser-dev, where there's no registry to write to. */
export function addProject(path: string): Promise<string> {
  if (!isTauri()) {
    return Promise.reject(
      new Error('adding projects requires the desktop app')
    );
  }
  return invoke('add_project', { path });
}

/** Stamps `lastOpenedAt` for `path` in the registry (adding it if absent). Fire-and-forget on
 * every project switch; a no-op in browser-dev. */
export function touchProjectOpened(path: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke('touch_project_opened', { path });
}

/** Opens a native folder picker (via the `tauri-plugin-dialog` JS API) and resolves to the
 * chosen absolute path, or `null` if the user cancelled. Uses the plugin's JS `open` directly
 * rather than a bespoke Rust command — it's the idiomatic Tauri-2 surface and needs only the
 * `dialog:default` capability. Returns `null` in browser-dev, where no native dialog exists. */
export function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  return openDialog({ directory: true, multiple: false }).then((result) =>
    typeof result === 'string' ? result : null
  );
}

/** A GitHub repository from `gh repo list`, for the "From GitHub" clone flow. */
export interface GithubRepo {
  nameWithOwner: string;
  name: string;
  description: string;
}

/** Lists the authenticated user's GitHub repos via `gh repo list` (backend runs `gh auth
 * status` first). Rejects with a clear message if `gh` is missing/unauthenticated, or in
 * browser-dev. */
export function listGithubRepos(): Promise<GithubRepo[]> {
  if (!isTauri()) {
    return Promise.reject(
      new Error('listing GitHub repos requires the desktop app')
    );
  }
  return invoke('list_github_repos');
}

/** Clones `nameWithOwner` into `parentDir`/<repo-name> via `gh repo clone` and resolves to the
 * cloned checkout's absolute path. Rejects if the target already exists, on clone failure, or
 * in browser-dev. */
export function cloneGithubRepo(
  nameWithOwner: string,
  parentDir: string
): Promise<string> {
  if (!isTauri()) {
    return Promise.reject(
      new Error('cloning repositories requires the desktop app')
    );
  }
  return invoke('clone_github_repo', { nameWithOwner, parentDir });
}
