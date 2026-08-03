import type {
  DiffFile,
  EpicProgress,
  NormalizedEntry,
  PlanProposal,
  PlanRecord,
  RunMeta,
  RunState,
} from './apiClient.js';
import { formatTable } from './output.js';

// Renders one streamed NormalizedEntry as a compact `--watch` line, or `null` to skip it.
// `thinking` entries are an agent's internal reasoning, so they need `verbose`.
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
    case 'message':
      if (entry.text === undefined) return null;
      return `[message ${messageSender(entry)}] ${entry.text}`;
  }
}

// Who a `kind: 'message'` entry is from, for the `[message …]` prefix.
// `toUser` marks this run's own message_user call, addressed to the human.
function messageSender(entry: NormalizedEntry): string {
  if (entry.toUser === true) return 'to you';
  if (entry.from === 'user') return 'from user';
  return `from ${entry.fromLabel ?? 'another agent'}`;
}

// Renders an `approval.requested` WS event prominently, with the exact command to copy
// rather than making the user reconstruct the run/request ids.
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

// `dispatch runs`'s table: run id, task, state, branch, cost — column-aligned through
// `output.ts`'s shared `formatTable`, so a script can grep or sort it.
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

// `dispatch plan`'s proposal rendering: a numbered task list plus a dependency-arrow line
// per task. Index-based, matching `blockedByIndices` — a proposal has no ids until confirm.
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

// What `dispatch plan` prints when a settled plan has no proposal yet: the
// planner's last reply, any clarifying questions, and how to answer them.
export function formatPlanNeedsReply(record: PlanRecord): string {
  const lines: string[] = [];
  const reply = record.messages
    .filter((m) => m.role === 'assistant')
    .at(-1)?.text;
  if (reply !== undefined && reply.trim() !== '') lines.push(reply, '');
  if (record.questions.length > 0) {
    lines.push('The planner needs answers before it can propose tasks:');
    record.questions.forEach((question, i) => {
      lines.push(`  ${i + 1}. ${question.question}`);
      if (question.options.length > 0) {
        lines.push(`     options: ${question.options.join(' | ')}`);
      }
    });
  } else {
    lines.push('The planner did not propose any tasks yet.');
  }
  lines.push('', `dispatch plan reply ${record.id} "<your answer>"`);
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

// The exit code `dispatch run --watch` uses at a terminal state, null while
// running. Every RunState is listed so a new one can't silently hang --watch.
export function exitCodeForRunState(state: RunState): number | null {
  switch (state) {
    case 'finished':
      return 0;
    case 'failed':
    case 'interrupted-dirty':
      // `interrupted-dirty` is a failed run that left uncommitted work behind
      // — still a failure; what survived is in the run's survey, not the code.
      return 1;
    case 'cancelled':
      return 130;
    case 'provisioning':
    case 'running':
    case 'awaiting-approval':
      return null;
    default:
      return unhandledRunState(state);
  }
}

// Compile-time exhaustiveness: a RunState with no case above is a type error
// here. At runtime an unknown state from a newer daemon stays non-terminal.
function unhandledRunState(state: never): null {
  void state;
  return null;
}
