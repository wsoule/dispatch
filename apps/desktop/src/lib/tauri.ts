import { invoke } from '@tauri-apps/api/core';

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

export function listProjects(): Promise<ProjectSummary[]> {
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
  return invoke('has_dispatch', { root });
}

/** Ensures a `dispatchd` sidecar is running for `root` and resolves to its port — reuses an
 * already-healthy daemon if one exists, otherwise spawns one (`bun packages/server/src/bin.ts
 * --root <root>`, dev-only wiring) and waits up to 5s for it to come up. See
 * `sidecar::ensure_dispatchd` on the backend. Rejects if `bun` isn't on `PATH` or the daemon
 * never becomes healthy in time. */
export function ensureDispatchd(root: string): Promise<number> {
  return invoke('ensure_dispatchd', { root });
}
