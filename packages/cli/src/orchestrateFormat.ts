import type {
  DiffFile,
  EpicProgress,
  NormalizedEntry,
  PlanProposal,
  RunMeta,
  RunState,
} from './apiClient.js';
import { formatTable } from './output.js';

// Renders one streamed NormalizedEntry as a single compact line for
// `--watch`'s live log, or `null` to skip it entirely — keeping chat-noise
// low is an explicit design goal for this phase (a scriptable tool first,
// not a transcript viewer). `thinking` entries (an agent's internal
// reasoning, not its actual output) are skipped unless `verbose` is set;
// every other kind always renders. A `tool` entry's glyph reflects its
// current `status` (defaults to the in-flight glyph — every executor today,
// including the real ClaudeExecutor, only ever emits `status: 'running'` for
// tool entries; see claude.ts's own TODO(M7)) rather than a separate line
// per status transition.
export function formatEntry(
  entry: NormalizedEntry,
  opts: { verbose?: boolean } = {}
): string | null {
  switch (entry.kind) {
    case 'assistant':
      return entry.text !== undefined ? `[assistant] ${entry.text}` : null;
    case 'tool': {
      const glyph =
        entry.status === 'done' ? '✓' : entry.status === 'error' ? '✗' : '…';
      return `[tool ${glyph}] ${entry.toolName ?? 'unknown'}`;
    }
    case 'thinking':
      if (opts.verbose !== true) return null;
      return entry.text !== undefined ? `[thinking] ${entry.text}` : null;
    case 'system':
      return entry.text !== undefined ? `[system] ${entry.text}` : null;
    case 'usage':
      return entry.text !== undefined ? `[usage] ${entry.text}` : null;
  }
}

// Renders an `approval.requested` WS event prominently — the plan
// explicitly asks `--watch` to make this impossible to miss and to hand the
// user the exact command to copy, rather than making them reconstruct the
// run/request ids themselves.
export function formatApprovalRequest(
  runId: string,
  requestId: string,
  toolName: string
): string {
  return [
    '',
    '=== approval requested ===',
    `tool:    ${toolName}`,
    `approve: dispatch approve ${runId} ${requestId}`,
    `deny:    dispatch approve ${runId} ${requestId} --deny`,
    '===========================',
    '',
  ].join('\n');
}

// `dispatch runs`'s table: run id, task, state, branch, cost — a `--json`
// table row is emitted per RunMeta so a script can grep/sort/pipe on the
// exact fields the plan calls out, formatted with `output.ts`'s shared
// column-aligning `formatTable` (same helper `dispatch task list` uses).
export function formatRunsTable(runs: RunMeta[]): string {
  if (runs.length === 0) return '(none)';
  const header = ['RUN', 'TASK', 'STATE', 'BRANCH', 'COST'];
  const rows = runs.map((r) => [
    r.id,
    r.taskId,
    r.state,
    r.branch,
    `$${(r.costUsd ?? 0).toFixed(2)}`,
  ]);
  return formatTable([header, ...rows]);
}

// `dispatch diff --files`'s per-file status list.
export function formatDiffFiles(files: DiffFile[]): string {
  if (files.length === 0) return '(no changes)';
  return formatTable(files.map((f) => [f.status, f.path]));
}

// `dispatch plan`'s proposal rendering: a numbered task table plus a
// dependency-arrow line per task that has one, so a proposal with several
// interdependent tasks is legible before the user decides to confirm it.
// Index-based (matching PlannedTask.blockedByIndices — real ids don't exist
// until confirm) rather than id-based, since a proposal has no ids yet.
export function formatProposal(proposal: PlanProposal): string {
  const lines: string[] = [];
  if (proposal.epic !== undefined) {
    lines.push(`Epic: ${proposal.epic.title}`);
  }
  proposal.tasks.forEach((task, i) => {
    lines.push(`  ${i}. ${task.title} [${task.priority}]`);
    if (task.blockedByIndices.length > 0) {
      lines.push(`     ← blocked by ${task.blockedByIndices.join(', ')}`);
    }
  });
  return lines.join('\n');
}

// `dispatch epic status`'s progress rendering: children grouped by status,
// plus any currently-live runs against them.
export function formatEpicProgress(progress: EpicProgress): string {
  const lines: string[] = [
    `epic ${progress.epicId}: ${progress.active ? 'active' : 'inactive'}` +
      (progress.concurrency !== undefined
        ? ` (concurrency ${progress.concurrency})`
        : ''),
  ];
  lines.push(
    formatTable([
      ['ID', 'STATUS', 'TITLE'],
      ...progress.children.map((c) => [c.id, c.status, c.title]),
    ])
  );
  if (progress.liveRuns.length > 0) {
    lines.push('live runs:');
    lines.push(formatRunsTable(progress.liveRuns));
  }
  return lines.join('\n');
}

// The exit code `dispatch run --watch` uses once a run reaches ANY terminal
// state — 0 for a clean finish, 1 for a failure, 130 for a cancellation
// (128 + SIGINT's signal number 2, the conventional shell code for "killed
// by Ctrl+C", since a cancelled run is exactly that from the CLI's point of
// view). Returns `null` for a non-terminal state — the watch loop keeps
// running.
export function exitCodeForRunState(state: RunState): number | null {
  switch (state) {
    case 'finished':
      return 0;
    case 'failed':
      return 1;
    case 'cancelled':
      return 130;
    default:
      return null;
  }
}
