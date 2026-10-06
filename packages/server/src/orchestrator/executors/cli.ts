import type { ExecutorCommand } from '@dispatch-foo/core';
import { childEnv } from '@dispatch-foo/core';

import { FLOOR_COMMAND_ACTIONS } from '../../floor.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorProfile,
  ExecutorRun,
  ExecutorStartOptions,
} from '../types.js';

/**
 * Runs any coding agent that is just a command-line program.
 *
 * Dispatch speaks two agents' protocols natively; every other agent worth
 * dispatching is a CLI that takes a prompt, works in the current directory and
 * prints as it goes. That is enough to run one inside a worktree and review
 * the diff afterwards, which is the part that matters — the orchestrator never
 * branches on which executor produced a run.
 *
 * What this gives up, and says so through its profile rather than pretending
 * otherwise:
 *
 *   - No approval gate. A CLI agent asks the terminal, not us, so a run on one
 *     cannot be held at a tool call. The profile refuses every permission mode
 *     that implies a human gate, so a run is rejected at dispatch rather than
 *     silently proceeding ungated. Nothing holds an irreversible command
 *     (floor.ts) either, and each run's transcript opens by saying so.
 *   - No cost or turn reporting, so the spend gate charges the configured
 *     estimate and `maxTurns`/`maxBudgetUsd` are not enforced mid-run.
 *   - No resumable session, so a follow-up starts a fresh process.
 */

/** Placeholders substituted into `command.run` before spawn. */
const PROMPT_TOKEN = '{prompt}';
const MODEL_TOKEN = '{model}';
const PLACEHOLDER = /\{prompt\}|\{model\}/g;

interface CliSpawnResult {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  writeStdin(text: string): void;
  closeStdin(): void;
  kill(): void;
}

interface CliSpawnOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** True when the prompt goes to stdin rather than on the command line. */
  stdinPrompt: boolean;
}

export type CliSpawner = (opts: CliSpawnOptions) => CliSpawnResult;

/**
 * Fills the placeholders in an argv.
 *
 * Replacement is substring-wise so `--model={model}` works as well as a bare
 * `{model}`, and an argument is dropped entirely when it is nothing but a
 * `{model}` placeholder and no model was chosen — otherwise the agent would
 * receive an empty argument where a model name should be, which most CLIs
 * reject.
 */
export function buildArgv(
  run: readonly string[],
  values: { prompt: string; model?: string }
): { argv: string[]; stdinPrompt: boolean } {
  const usesPrompt = run.some((part) => part.includes(PROMPT_TOKEN));
  const argv: string[] = [];
  for (const part of run) {
    if (part.includes(MODEL_TOKEN) && values.model === undefined) {
      // A flag and its value written as one argument (`--model={model}`) goes
      // entirely; a bare `{model}` likewise. A flag written as two arguments
      // would leave its flag behind, which is why the preset table below keeps
      // model flags in the combined form.
      if (part.trim() === MODEL_TOKEN || part.endsWith(`=${MODEL_TOKEN}`))
        continue;
    }
    // One pass over both tokens, not two sequential replaceAll calls: with
    // two, the prompt is substituted first and then rescanned, so a prompt
    // that happens to contain the literal text `{model}` would have it
    // replaced. A single regex never re-examines what it just wrote.
    argv.push(
      part.replace(PLACEHOLDER, (token) =>
        token === PROMPT_TOKEN ? values.prompt : (values.model ?? '')
      )
    );
  }
  return { argv, stdinPrompt: !usesPrompt };
}

function defaultSpawner(opts: CliSpawnOptions): CliSpawnResult {
  // The two cases are spawned separately rather than with a conditional
  // `stdin` option: Bun types the returned `stdin` from that option's literal
  // value, so a union of 'pipe' | 'ignore' gives back a handle that is not
  // writable without a cast.
  if (!opts.stdinPrompt) {
    const proc = Bun.spawn(opts.command, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      writeStdin: () => {},
      closeStdin: () => {},
      kill: () => proc.kill(),
    };
  }

  const proc = Bun.spawn(opts.command, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    writeStdin(text: string) {
      void proc.stdin.write(text);
    },
    closeStdin() {
      // Closing is what tells an agent reading a piped prompt that the prompt
      // is complete; without it the agent waits for an EOF that never comes.
      void proc.stdin.end();
    },
    kill: () => proc.kill(),
  };
}

// A CLI agent has no protocol to tell us a tool call is pending, so every mode
// that means "stop and ask a human" is impossible rather than merely
// unsupported. Saying so here is what turns it into a refusal at dispatch.
const GATED_MODES = new Set(['default', 'ask', 'plan']);

export const CLI_EXECUTOR_PROFILE: ExecutorProfile = {
  reportsCost: false,
  reportsTurns: false,
  enforcesCaps: false,
  acceptsMessages: false,
  permissionRefusal: (permissionMode) =>
    GATED_MODES.has(permissionMode)
      ? `this agent is a plain CLI with no approval protocol, so it cannot run under "${permissionMode}" — dispatch it with an ungated mode, or use claude/codex for gated runs`
      : null,
  dispatchMcp: false,
};

export interface CliExecutorOptions {
  /** The agent's argv and environment, from config or a preset. */
  command: ExecutorCommand;
  spawn?: CliSpawner;
}

export class CliExecutor implements Executor {
  readonly profile = CLI_EXECUTOR_PROFILE;
  private readonly spawn: CliSpawner;

  constructor(private readonly options: CliExecutorOptions) {
    this.spawn = options.spawn ?? defaultSpawner;
  }

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const { argv, stdinPrompt } = buildArgv(this.options.command.run, {
      prompt: opts.prompt,
      ...(opts.model === undefined ? {} : { model: opts.model }),
    });

    let stopped = false;
    let finished = false;

    // Reported once, whatever reaches it first — an interrupt and a natural
    // exit can race, and a run that finished twice would confuse the registry.
    const finish = (state: 'finished' | 'failed', error?: string): void => {
      if (finished) return;
      finished = true;
      events.onFinish({ state, ...(error === undefined ? {} : { error }) });
    };

    let child: CliSpawnResult;
    try {
      child = this.spawn({
        command: argv,
        cwd: opts.cwd,
        env: childEnv(this.options.command.env),
        stdinPrompt,
      });
    } catch (err) {
      // Bun throws synchronously when the executable is not on PATH, which is
      // the single most likely failure here: the agent simply is not installed.
      const message = err instanceof Error ? err.message : String(err);
      finish('failed', `could not start ${argv[0] ?? 'the agent'}: ${message}`);
      return {
        interrupt: () => Promise.resolve(),
        requestStop: () => {},
        send: () => {},
        approve: () => {},
        notify: () => {},
      };
    }

    // Every mode this profile admits is ungated, so each run says what that
    // costs rather than letting the floor (floor.ts) look enforced.
    events.onEntry({
      ts: new Date().toISOString(),
      kind: 'system',
      text: `${argv[0] ?? 'This agent'} has no approval protocol, so Dispatch cannot hold ${FLOOR_COMMAND_ACTIONS} for a human under permissionMode ${opts.permissionMode}`,
    });

    if (stdinPrompt) {
      child.writeStdin(opts.prompt);
      child.closeStdin();
    }

    // Both streams are surfaced as transcript entries. stderr is kept separate
    // rather than merged: a CLI agent's progress chatter usually goes there,
    // and folding it into the assistant's own output would read as if the
    // agent had said it.
    void pump(child.stdout, (text) => {
      events.onEntry({ ts: new Date().toISOString(), kind: 'assistant', text });
    });
    void pump(child.stderr, (text) => {
      events.onEntry({ ts: new Date().toISOString(), kind: 'system', text });
    });

    void child.exited.then((code) => {
      if (code === 0) {
        finish('finished');
        return;
      }
      // A run the user stopped exits non-zero because it was killed; that is
      // not a failure of the agent.
      if (stopped) {
        finish('finished');
        return;
      }
      finish('failed', `${argv[0] ?? 'agent'} exited with code ${code}`);
    });

    return {
      interrupt: () => {
        stopped = true;
        child.kill();
        return Promise.resolve();
      },
      // A CLI agent has no channel to ask it to wind down, so the honest
      // implementation of "stop" is the same kill as interrupt. The
      // orchestrator still gets its onFinish, so the usual finish handling
      // (auto-commit, task -> in-review) applies to whatever it had written.
      requestStop: () => {
        stopped = true;
        child.kill();
      },
      send: () => {
        events.onEntry({
          ts: new Date().toISOString(),
          kind: 'system',
          text: 'This agent runs as a one-shot command and cannot take a mid-run message.',
        });
      },
      approve: () => {},
      // No channel for a note either; silent, since a note is best-effort.
      notify: () => {},
    };
  }
}

// Decodes a stream into text entries as it arrives. The decoder is held across
// chunks so a multi-byte character split across a read boundary is not mangled.
async function pump(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.length === 0) continue;
      const text = decoder.decode(value, { stream: true });
      if (text !== '') onText(text);
    }
  } catch {
    // A broken stream means the process is gone; `exited` records the outcome.
  } finally {
    reader.releaseLock();
  }
}
