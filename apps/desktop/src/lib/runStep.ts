import type { NormalizedEntry, RunMeta } from '@dispatch/client';

// A live run's latest step, in words ("Editing src/foo.ts", "Running tests"), read from the
// `run.log` entries the event socket already delivers for every run, and seeded from the
// run record's `lastStep` ({ text, at }) for a run already live when the window opened.
// Only the label is kept, never the entry, so a run writing big files costs a short string
// per run.

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

/** A path as the run sees it: relative to its worktree (the segment after the run id),
 * else the last three segments. */
export function shortPath(path: string, runId: string): string {
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

/** What a shell command is doing: a known kind of work, the agent's own description, or
 * the program it runs. */
export function shellStep(command: string, description?: string): string {
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

function toolStep(entry: NormalizedEntry, runId: string): string | null {
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

/** The step one log entry announces, or null when it says nothing new about what the run
 * is doing (prose, usage ticks, a sub-agent's own tool calls). */
export function runStepFromEntry(
  entry: NormalizedEntry,
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

function isEntry(value: unknown): value is NormalizedEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string'
  );
}

/** The step a run record says its run last took, from the daemon's `lastStep`: core's
 * `{ text, at }`, else a bare label or the log entry that announced it. Null when a daemon
 * sends none (older ones) or it says nothing. */
export function runStepFromRecord(
  run: RunMeta & { lastStep?: unknown }
): string | null {
  const last = run.lastStep;
  if (isEntry(last)) return runStepFromEntry(last, run.id);
  const label = text(typeof last === 'string' ? last : record(last).text);
  return label === null ? null : clip(label);
}

// Coarse running sentences the live step replaces or extends; the rest (Starting, Waiting
// on approval, Stopping) say more than any step would.
const REPLACED = new Set(['Working']);
const EXTENDED = new Set(['Fixing findings', 'Reviewing', 'Verifying']);

/** A running Flight Plan node's sentence with the live step folded in. */
export function withLiveStep(sentence: string, step: string | null): string {
  if (step === null) return sentence;
  if (REPLACED.has(sentence)) return step;
  if (EXTENDED.has(sentence)) return `${sentence} · ${step}`;
  return sentence;
}

interface Scheduler {
  now: () => number;
  schedule: (run: () => void, ms: number) => void;
}

const REAL_SCHEDULER: Scheduler = {
  now: () => Date.now(),
  schedule: (run, ms) => {
    setTimeout(run, ms);
  },
};

// Runs whose step is kept; the oldest is dropped past this.
const MAX_RUNS = 200;

/**
 * The latest step per run, published to subscribers at most once per `intervalMs` however
 * chatty the runs are (the default is 4 times a second). Steps that arrive between
 * publishes collapse to the newest per run.
 */
export class RunStepStore {
  private readonly steps = new Map<string, string>();
  private readonly pending = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly scheduler: Scheduler;
  private readonly intervalMs: number;
  private scheduled = false;
  private lastPublish = Number.NEGATIVE_INFINITY;

  constructor(scheduler: Scheduler = REAL_SCHEDULER, intervalMs = 250) {
    this.scheduler = scheduler;
    this.intervalMs = intervalMs;
  }

  record(runId: string, entry: NormalizedEntry): void {
    const step = runStepFromEntry(entry, runId);
    if (step === null) return;
    this.pending.set(runId, step);
    this.schedulePublish();
  }

  /** A step read off the run's record, for a run this window has heard no step of yet:
   * a logged step is newer, so it always wins. */
  seed(runId: string, step: string): void {
    if (this.steps.has(runId) || this.pending.has(runId)) return;
    this.pending.set(runId, step);
    this.schedulePublish();
  }

  get(runId: string): string | null {
    return this.steps.get(runId) ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private schedulePublish(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const wait = Math.max(
      0,
      this.lastPublish + this.intervalMs - this.scheduler.now()
    );
    this.scheduler.schedule(() => this.publish(), wait);
  }

  private publish(): void {
    this.scheduled = false;
    this.lastPublish = this.scheduler.now();
    let changed = false;
    for (const [runId, step] of this.pending) {
      if (this.steps.get(runId) === step) continue;
      // Re-inserted so the map's order is least recently stepped first.
      this.steps.delete(runId);
      this.steps.set(runId, step);
      changed = true;
    }
    this.pending.clear();
    for (const runId of this.steps.keys()) {
      if (this.steps.size <= MAX_RUNS) break;
      this.steps.delete(runId);
    }
    if (changed) for (const listener of this.listeners) listener();
  }
}

/** The app's one store, fed by useDispatchProject's `run.log` handler and run list. */
export const runSteps = new RunStepStore();
