export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  lang: string | null;
  stack: string | null;
  created_at: number;
  last_active: number;
  session_count: number;
  total_cost_usd: number;
  /** Every distinct agent with at least one session in this project. */
  agents: string[];
}

export interface FileChanged {
  id: number;
  session_id: string;
  file_path: string;
  change_type: 'write' | 'edit' | 'multi_edit' | 'notebook_edit';
  lines_added: number;
  lines_removed: number;
  occurred_at: number;
}

export interface Session {
  id: string;
  project_id: string;
  agent: string;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  last_activity_at: number;
  status: 'active' | 'ended';
  duration_seconds: number | null;
  summary: string | null;
  /** Claude Code's own auto-generated session title — the same text shown as "Session name"
   * in `claude`'s `/status` and the `--resume` picker. Null until Claude has generated one. */
  title: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  lines_added: number;
  lines_removed: number;
  tags: string | null;
  raw_log_path: string;
}

export interface SessionDetail {
  session: Session;
  files_changed: FileChanged[];
}

export interface DailyActivity {
  /** `YYYY-MM-DD`. */
  date: string;
  count: number;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
}

export interface GitInsights {
  /** Oldest first, one entry per day, 365 days long (today inclusive) — commit counts, not
   * session/usage activity. */
  commit_heatmap: DailyActivity[];
  /** Newest first. Empty if the project isn't a git repo (or `git` isn't on `PATH`). */
  recent_commits: CommitInfo[];
}

export interface AgentUsage {
  agent: string;
  session_count: number;
  total_cost_usd: number;
}

export interface DiffLine {
  tag: 'insert' | 'delete' | 'equal';
  content: string;
}

export interface FileDiff {
  lines: DiffLine[];
  truncated: boolean;
  /** When the most recent edit folded into this diff occurred. */
  occurred_at: number;
  /** How many separate tool-call edits (across the session) were folded into this diff. */
  edit_count: number;
}

export interface ActiveSessionSummary {
  session_id: string;
  session_title: string | null;
  session_summary: string | null;
  project_id: string;
  project_name: string;
}

export interface DashboardStats {
  total_cost_usd: number;
  total_sessions: number;
  /** Count of every project Relay knows about, independent of `top_projects`'s cap. */
  total_projects: number;
  /** Oldest first, one entry per day, 365 days long (today inclusive). */
  daily_activity: DailyActivity[];
  /** Highest-spend projects first, capped for display. */
  top_projects: ProjectSummary[];
  agent_usage: AgentUsage[];
  /** The most-recently-active session, if any is currently `status: "active"`. */
  active_session: ActiveSessionSummary | null;
}

export interface ReportTotals {
  total_cost_usd: number;
  session_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface ReportProjectRow {
  project_id: string;
  project_name: string;
  session_count: number;
  total_cost_usd: number;
}

export interface ReportTagRow {
  tag: string;
  session_count: number;
  total_cost_usd: number;
}

export interface ReportData {
  range_days: number;
  since_epoch: number;
  totals: ReportTotals;
  by_project: ReportProjectRow[];
  /** A session with multiple tags contributes to each — spend here can sum to more than
   * `totals.total_cost_usd`, see `report_by_tag` on the backend. */
  by_tag: ReportTagRow[];
  by_agent: AgentUsage[];
}

export interface Board {
  id: string;
  project_id: string;
  created_at: number;
}

export type ColumnRole = 'todo' | 'in_progress' | 'review' | 'done';

export interface BoardColumn {
  id: string;
  board_id: string;
  name: string;
  /** Only the four seeded columns carry a role; user-added columns are always null. */
  role: ColumnRole | null;
  position: number;
  created_at: number;
}

export interface Card {
  id: string;
  board_id: string;
  column_id: string;
  /** Set once a session is linked; auto-sync only ever moves cards that have this. */
  session_id: string | null;
  title: string;
  description: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface BoardData {
  board: Board;
  columns: BoardColumn[];
  cards: Card[];
}
