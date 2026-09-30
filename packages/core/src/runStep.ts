// A run's current step in words ("Editing src/foo.ts", "Running tests"), read
// from the log entries its agent writes. Pure and structural, so dispatchd
// (RunMeta.lastStep) and any client label an entry the same way.

/** The slice of a transcript entry a step is read from. */
export interface RunStepEntry {
  kind: string;
  toolName?: string;
  toolInput?: unknown;
  /** Set on a sub-agent's own entries, which never name the run's step. */
  parentToolUseId?: string;
  agent?: { phase: string; label?: string };
}

/** The step a live run last announced, and when (the entry's `ts`). */
export interface RunStep {
  text: string;
  at: string;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Update']);
const MAX_TEXT = 48;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

// A path as the run sees it: relative to its worktree (the segment after the
// run id), else the last three segments.
function shortPath(path: string, runId: string): string {
  const marker = `/${runId}/`;
  const at = path.indexOf(marker);
  if (at >= 0) return path.slice(at + marker.length);
  if (!path.startsWith('/')) return path;
  return path.split('/').filter(Boolean).slice(-3).join('/');
}

const TEST_RE =
  /\b(?:bun|npm|pnpm|yarn|deno|go|cargo)\s+(?:run\s+)?test\b|\b(?:jest|vitest|mocha)\b|\bplaywright\s+test\b|:test\b/;
const TYPECHECK_RE = /\b(?:tsc|tsgo)\b|\btypecheck\b/;
const LINT_RE =
  /\b(?:eslint|oxlint|stylelint|ruff|clippy|knip)\b|:lint\b|\brun\s+lint\b/;
const FORMAT_RE = /\b(?:prettier|oxfmt|rustfmt)\b|:format\b|\brun\s+format\b/;
const BUILD_RE =
  /:build\b|\brun\s+build\b|\b(?:vite|tsdown|cargo|go)\s+build\b/;
const INSTALL_RE = /\b(?:pnpm|npm|yarn|bun)\s+(?:install|add|i)\b/;
const GIT_RE = /\bgit\s+([a-z][a-z-]*)/;

// The program a shell line runs, past any `cd …` and `KEY=value` prefixes.
function program(command: string): string | null {
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const first = words[0];
    if (first === undefined || first === 'cd' || first === 'export') continue;
    return first.split('/').pop() ?? first;
  }
  return null;
}

// What a shell command is doing: a known kind of work, the agent's own
// description, or the program it runs.
function shellStep(command: string, description?: string): string {
  if (TEST_RE.test(command)) return 'Running tests';
  if (TYPECHECK_RE.test(command)) return 'Typechecking';
  if (LINT_RE.test(command)) return 'Linting';
  if (FORMAT_RE.test(command)) return 'Formatting';
  if (BUILD_RE.test(command)) return 'Building';
  if (INSTALL_RE.test(command)) return 'Installing dependencies';
  const git = GIT_RE.exec(command)?.[1];
  if (git === 'commit') return 'Committing';
  if (git !== undefined) return `Running git ${git}`;
  if (description !== undefined) return clip(description);
  const name = program(command);
  return name === null ? 'Running a command' : clip(`Running ${name}`);
}

function toolStep(entry: RunStepEntry, runId: string): string | null {
  const name = entry.toolName ?? '';
  const input = record(entry.toolInput);
  const path =
    text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  const at = path === null ? '' : ` ${shortPath(path, runId)}`;
  if (EDIT_TOOLS.has(name)) return `Editing${at}`;
  if (name === 'Write') return `Writing${at}`;
  if (name === 'Read') return `Reading${at}`;
  if (name === 'LS') return `Listing${at}`;
  if (name === 'Grep') {
    const pattern = text(input.pattern);
    return pattern === null ? 'Searching' : clip(`Searching for ${pattern}`);
  }
  if (name === 'Glob') {
    const pattern = text(input.pattern);
    return pattern === null ? 'Finding files' : clip(`Finding ${pattern}`);
  }
  if (name === 'Bash' || name === 'codex.commandExecution') {
    const raw = input.command;
    const command = Array.isArray(raw) ? raw.join(' ') : text(raw);
    if (command === null) return 'Running a command';
    return shellStep(command, text(input.description) ?? undefined);
  }
  if (name === 'codex.fileChange') {
    const first = Array.isArray(input.changes)
      ? text(record(input.changes[0]).path)
      : null;
    return first === null ? 'Editing' : `Editing ${shortPath(first, runId)}`;
  }
  if (name === 'WebFetch' || name === 'WebSearch') return 'Searching the web';
  if (name === 'TodoWrite') return 'Updating its plan';
  if (name === 'Task' || name === 'Agent') return 'Running a sub-agent';
  if (name === 'ExitPlanMode' || name === '') return null;
  // `mcp__server__tool` (Claude) and `mcp.server.tool` (Codex) read as the tool alone.
  const tool = name.split(/__|\./).pop() ?? name;
  return clip(`Using ${tool}`);
}

/**
 * The step one log entry announces, or null when it says nothing new about
 * what the run is doing (prose, usage ticks, a sub-agent's own tool calls).
 */
export function runStepFromEntry(
  entry: RunStepEntry,
  runId: string
): string | null {
  if (entry.parentToolUseId !== undefined) return null;
  switch (entry.kind) {
    case 'tool':
      return toolStep(entry, runId);
    case 'thinking':
      return 'Thinking';
    case 'agent': {
      if (entry.agent?.phase !== 'started') return null;
      const label = text(entry.agent.label);
      return label === null
        ? 'Running a sub-agent'
        : clip(`Sub-agent: ${label}`);
    }
    default:
      return null;
  }
}
