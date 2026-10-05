import type { ExecutorCommand } from '@dispatch-foo/core';

/**
 * Ready-made invocations for CLI agents people already have installed.
 *
 * These are starting points, not a compatibility matrix. Each entry is that
 * agent's documented one-shot form — run a prompt, work in the current
 * directory, print, exit — but agents change their flags, and a preset that
 * has drifted is meant to be corrected rather than worked around:
 *
 *     # .dispatch/config.yml
 *     executors:
 *       gemini:
 *         command:
 *           run: [gemini, '--prompt', '{prompt}']
 *
 * A config entry replaces the preset entirely, so nothing here is load-bearing
 * — it exists so that an agent already on the machine is dispatchable without
 * anyone writing config first.
 *
 * `claude` and `codex` are deliberately absent: Dispatch speaks both of those
 * protocols natively, with approvals, cost and resumable sessions, and running
 * either as a dumb CLI would be a downgrade.
 */
export const CLI_AGENT_PRESETS: Record<string, ExecutorCommand> = {
  // Google's Gemini CLI. `-p` is its non-interactive prompt flag.
  gemini: { run: ['gemini', '-p', '{prompt}'] },
  // Qwen Code, a Gemini CLI fork, so the same flag.
  qwen: { run: ['qwen', '-p', '{prompt}'] },
  // Cursor's CLI agent; `-p` prints rather than opening the TUI.
  'cursor-agent': { run: ['cursor-agent', '-p', '{prompt}'] },
  // opencode's non-interactive subcommand.
  opencode: { run: ['opencode', 'run', '{prompt}'] },
  // Charm's Crush.
  crush: { run: ['crush', 'run', '{prompt}'] },
  // Block's Goose; `-t` supplies the text of the task.
  goose: { run: ['goose', 'run', '-t', '{prompt}'] },
  // Aider. `--yes-always` matters here: without it aider stops for
  // confirmation at the first edit and the run hangs rather than failing,
  // which is the worst of both outcomes.
  aider: { run: ['aider', '--yes-always', '--message', '{prompt}'] },
};

/**
 * The presets whose binary is actually on this machine.
 *
 * Gating on `which` keeps the dispatch picker honest: an agent listed there
 * should be one that can run. Without it every install would advertise seven
 * agents and six of them would fail at dispatch with a spawn error.
 */
export function availableCliPresets(
  which: (name: string) => string | null = (name) => Bun.which(name)
): Record<string, ExecutorCommand> {
  const found: Record<string, ExecutorCommand> = {};
  for (const [name, command] of Object.entries(CLI_AGENT_PRESETS)) {
    const binary = command.run[0];
    if (binary !== undefined && which(binary) !== null) found[name] = command;
  }
  return found;
}
