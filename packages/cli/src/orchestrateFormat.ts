import type {
  DiffFile,
  EpicProgress,
  EpicProgressChild,
  EpicSession,
  EpicSpend,
  Message,
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
    case 'agent':
      return formatAgentEntry(entry);
  }
}

// One line per sub-agent lifecycle edge: the spawn and the finish. Progress
// ticks are skipped — they arrive with every tool call the sub-agent makes,
// and a watch line per tick would drown the run's own output.
function formatAgentEntry(entry: NormalizedEntry): string | null {
  const agent = entry.agent;
  if (agent === undefined) return null;
  const name = agent.label ?? agent.id;
  const type = agent.type !== undefined ? ` (${agent.type})` : '';
  switch (agent.phase) {
    case 'started':
      return `[agent ↳] ${name}${type}`;
    case 'finished': {
      const glyph = agent.status === 'done' ? '✓' : '✗';
      const summary = agent.summary !== undefined ? ` — ${agent.summary}` : '';
      return `[agent ${glyph}] ${name}${summary}`;
    }
    default:
      return null;
  }
}

// Who a `kind: 'message'` entry is from, for the `[message …]` prefix.
// `toUser` marks a message this run sent to a human.
function messageSender(entry: NormalizedEntry): string {
  if (entry.toUser === true) return 'to you';
  if (entry.from === 'user') return 'from user';
  return `from ${entry.fromLabel ?? 'another agent'}`;
}

// The run tool call a gate asks about, as `dispatch approve` addresses it.
export interface ToolApproval {
  runId: string;
  requestId: string;
  tool: string;
}

// Reads a run's tool-approval gate off a message; null for anything else,
// including an overseer conversation's approval, which has no run.
export function toolApprovalOf(message: Message): ToolApproval | null {
  const data = message.data;
  if (typeof data !== 'object' || data === null) return null;
  const gate = data as Record<string, unknown>;
  if (
    gate.type !== 'tool-approval' ||
    typeof gate.runId !== 'string' ||
    typeof gate.requestId !== 'string' ||
    typeof gate.tool !== 'string'
  ) {
    return null;
  }
  return { runId: gate.runId, requestId: gate.requestId, tool: gate.tool };
}

// Renders a tool-approval gate prominently, with the exact commands to copy
// rather than making the user reconstruct the run/request ids.
export function formatApprovalRequest(approval: ToolApproval): string {
  const { runId, requestId, tool } = approval;
  return [
    '',
    '=== approval requested ===',
    `tool:    ${tool}`,
    `approve: dispatch approve ${runId} ${requestId}`,
    `deny:    dispatch approve ${runId} ${requestId} --deny`,
    'token:   needs the daemon app token (--token or DISPATCH_APP_TOKEN)',
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

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Why a session is paused, in the words `dispatch epic status` prints after
// `paused —`. A `fill-failed` pause carries the failing dispatch's message.
function formatPausedReason(session: EpicSession): string {
  switch (session.pausedReason) {
    case 'budget':
      return 'spend ceiling reached';
    case 'runs':
      return 'run ceiling reached';
    case 'fill-failed':
      return (
        'auto-dispatch failed' +
        (session.pausedDetail !== undefined ? `: ${session.pausedDetail}` : '')
      );
    case 'human':
      return 'by you';
    default:
      return 'paused';
  }
}

// The spend line: `spend $41.20 settled + ~$30.00 in flight of $60.00 · 7/20
// runs`. The `of` / `/N` halves only appear when that ceiling is set.
function formatSpendLine(spend: EpicSpend): string {
  const ceiling =
    spend.maxSpendUsd !== null ? ` of ${usd(spend.maxSpendUsd)}` : '';
  const runs =
    spend.maxRuns !== null
      ? `${String(spend.runsStarted)}/${String(spend.maxRuns)}`
      : String(spend.runsStarted);
  return (
    `spend ${usd(spend.settledUsd)} settled + ~${usd(spend.estimatedLiveUsd)} in flight` +
    `${ceiling} · ${runs} runs`
  );
}

// `dispatch epic status`'s progress rendering: the session state and spend,
// one row per child with its wave and phase, plus any currently-live runs.
export function formatEpicProgress(progress: EpicProgress): string {
  const session = progress.session;
  // A never-dispatched epic has no session; `active` still says what --watch
  // would see.
  const state =
    session !== null ? session.state : progress.active ? 'active' : 'inactive';
  const concurrency = session?.concurrency ?? progress.concurrency;
  const lines: string[] = [
    `epic ${progress.epicId}: ${state}` +
      (concurrency !== undefined
        ? ` (concurrency ${String(concurrency)})`
        : ''),
  ];
  if (session?.state === 'paused') {
    lines.push(`paused — ${formatPausedReason(session)}`);
  }
  lines.push(formatSpendLine(progress.spend));
  lines.push(formatChildrenTable(progress.children));
  if (progress.liveRuns.length > 0) {
    lines.push('live runs:');
    lines.push(formatRunsTable(progress.liveRuns));
  }
  return lines.join('\n');
}

// The children table; a REASON column appears only when some child has one
// (a blocked dependency, a failed run's error) so the common case stays narrow.
function formatChildrenTable(children: EpicProgressChild[]): string {
  const withReason = children.some((c) => c.reason !== undefined);
  const header = ['ID', 'WAVE', 'PHASE', 'STATUS', 'TITLE'];
  if (withReason) header.push('REASON');
  return formatTable([
    header,
    ...children.map((c) => {
      const row = [c.id, String(c.wave), c.phase, c.status, c.title];
      if (withReason) row.push(c.reason ?? '');
      return row;
    }),
  ]);
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
