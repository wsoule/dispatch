// Harness experiments: opt-in changes to what a dispatched Claude run sends
// the model, each kept off by default until an A/B comparison of cost per
// completed task (see RunMeta.usage) shows it is safe to make the default.
//
// Switched on per daemon with a comma-separated list, e.g.
// `DISPATCH_EXPERIMENTS=lean-tools,cache-1h`. The executor reports the ones it
// applied on the run's finish, so every run records which arm it ran in.

const EXPERIMENTS = [
  // Also removes Claude Code tools a dispatched run rarely needs but pays for
  // on every request: Workflow (multi-agent orchestration, ~21 KB of schema on
  // its own), plan mode, the code-review findings reporter, notebook editing,
  // and the MCP resource browsers. See LEAN_TOOL_EXCLUSIONS in
  // executors/claude.ts.
  'lean-tools',
  // Writes the CLI's prompt-cache entries with a 1-hour TTL instead of 5
  // minutes. A dispatched run can sit longer than 5 minutes on a human
  // (ask_user, request_scope, a tool approval) or a long build, after which
  // the next request re-writes the whole conversation at the cache-write rate
  // instead of reading it at the cache-read rate. 1-hour writes cost 2x the
  // input rate rather than 1.25x, so this only pays off when such gaps are
  // common; compare cacheCreationInputTokens across arms.
  'cache-1h',
] as const;

export type ExperimentName = (typeof EXPERIMENTS)[number];

function isExperiment(name: string): name is ExperimentName {
  return (EXPERIMENTS as readonly string[]).includes(name);
}

// The experiments switched on in `env`, sorted and deduplicated so the same
// setting always records the same list. Unknown names are ignored rather than
// failing a dispatch over a typo in an environment variable.
export function activeExperiments(
  env: Record<string, string | undefined> = process.env
): ExperimentName[] {
  const raw = env.DISPATCH_EXPERIMENTS ?? '';
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(isExperiment);
  return [...new Set(names)].sort();
}
