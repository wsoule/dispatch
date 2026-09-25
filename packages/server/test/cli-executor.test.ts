import { describe, expect, it } from 'bun:test';

import {
  buildArgv,
  CLI_EXECUTOR_PROFILE,
  CliExecutor,
} from '../src/orchestrator/executors/cli.js';
import {
  availableCliPresets,
  CLI_AGENT_PRESETS,
} from '../src/orchestrator/executors/cliPresets.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../src/orchestrator/types.js';

// Collects everything an executor reports, so a test can assert on the whole
// run rather than on one callback at a time.
function recorder(): {
  events: ExecutorEvents;
  entries: NormalizedEntry[];
  finished: Promise<{ state: string; error?: string }>;
} {
  const entries: NormalizedEntry[] = [];
  let settle: (value: { state: string; error?: string }) => void = () => {};
  const finished = new Promise<{ state: string; error?: string }>((resolve) => {
    settle = resolve;
  });
  return {
    entries,
    finished,
    events: {
      onEntry: (entry) => entries.push(entry),
      onApprovalRequest: () => {},
      onFinish: (finish) => settle(finish),
    },
  };
}

function textOf(entries: NormalizedEntry[], kind: string): string {
  return entries
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.text ?? '')
    .join('');
}

describe('buildArgv', () => {
  it('substitutes the prompt in place', () => {
    const built = buildArgv(['agent', '-p', '{prompt}'], { prompt: 'do it' });
    expect(built.argv).toEqual(['agent', '-p', 'do it']);
    expect(built.stdinPrompt).toBe(false);
  });

  it('routes the prompt to stdin when the argv has no placeholder', () => {
    const built = buildArgv(['agent', 'run'], { prompt: 'do it' });
    expect(built.argv).toEqual(['agent', 'run']);
    expect(built.stdinPrompt).toBe(true);
  });

  it('substitutes a model inside a combined flag', () => {
    const built = buildArgv(['agent', '--model={model}', '{prompt}'], {
      prompt: 'p',
      model: 'fast-1',
    });
    expect(built.argv).toEqual(['agent', '--model=fast-1', 'p']);
  });

  it('drops a model placeholder when no model was chosen', () => {
    // Passing an empty string where a model name belongs is rejected by most
    // CLIs, so the argument goes rather than arriving blank.
    const built = buildArgv(['agent', '--model={model}', '{prompt}'], {
      prompt: 'p',
    });
    expect(built.argv).toEqual(['agent', 'p']);
  });

  it('leaves a prompt containing braces alone', () => {
    const built = buildArgv(['agent', '{prompt}'], {
      prompt: 'use {model} here',
    });
    // Only the argv is scanned for placeholders; the prompt is data.
    expect(built.argv).toEqual(['agent', 'use {model} here']);
  });
});

describe('CLI_EXECUTOR_PROFILE', () => {
  it('admits it reports neither cost nor turns', () => {
    expect(CLI_EXECUTOR_PROFILE.reportsCost).toBe(false);
    expect(CLI_EXECUTOR_PROFILE.reportsTurns).toBe(false);
    expect(CLI_EXECUTOR_PROFILE.enforcesCaps).toBe(false);
  });

  it('refuses the modes that imply a human gate', () => {
    // A CLI agent has no approval protocol, so a gated run must be rejected at
    // dispatch rather than proceeding ungated.
    expect(CLI_EXECUTOR_PROFILE.permissionRefusal('default')).not.toBeNull();
    expect(CLI_EXECUTOR_PROFILE.permissionRefusal('plan')).not.toBeNull();
  });

  it('allows an ungated mode', () => {
    expect(
      CLI_EXECUTOR_PROFILE.permissionRefusal('bypassPermissions')
    ).toBeNull();
    expect(CLI_EXECUTOR_PROFILE.permissionRefusal('acceptEdits')).toBeNull();
  });
});

describe('CliExecutor', () => {
  it('runs a real command and reports its output', async () => {
    const executor = new CliExecutor({
      command: { run: ['sh', '-c', 'echo "$1"', 'sh', '{prompt}'] },
    });
    const rec = recorder();
    executor.start(
      {
        cwd: process.cwd(),
        prompt: 'hello-from-the-agent',
        permissionMode: 'bypassPermissions',
      },
      rec.events
    );

    expect((await rec.finished).state).toBe('finished');
    expect(textOf(rec.entries, 'assistant')).toContain('hello-from-the-agent');
  });

  it('delivers the prompt on stdin when the argv has no placeholder', async () => {
    const executor = new CliExecutor({ command: { run: ['cat'] } });
    const rec = recorder();
    executor.start(
      {
        cwd: process.cwd(),
        prompt: 'piped-prompt',
        permissionMode: 'bypassPermissions',
      },
      rec.events
    );

    // `cat` only exits once stdin is closed, so this also proves the executor
    // closes it — without that the run would hang rather than finish.
    expect((await rec.finished).state).toBe('finished');
    expect(textOf(rec.entries, 'assistant')).toContain('piped-prompt');
  });

  it('keeps stderr separate from the agent’s own output', async () => {
    const executor = new CliExecutor({
      command: { run: ['sh', '-c', 'echo out; echo err 1>&2'] },
    });
    const rec = recorder();
    executor.start(
      { cwd: process.cwd(), prompt: 'x', permissionMode: 'bypassPermissions' },
      rec.events
    );
    await rec.finished;

    expect(textOf(rec.entries, 'assistant')).toContain('out');
    expect(textOf(rec.entries, 'system')).toContain('err');
    // Progress chatter on stderr must not read as something the agent said.
    expect(textOf(rec.entries, 'assistant')).not.toContain('err');
  });

  it('says up front that nothing holds an irreversible command', async () => {
    const executor = new CliExecutor({
      command: { run: ['sh', '-c', 'exit 0', 'sh', '{prompt}'] },
    });
    const rec = recorder();
    executor.start(
      { cwd: process.cwd(), prompt: 'x', permissionMode: 'acceptEdits' },
      rec.events
    );
    await rec.finished;

    expect(rec.entries[0]).toMatchObject({
      kind: 'system',
      text: 'sh has no approval protocol, so Dispatch cannot hold a force-push, a publish, a repo-settings change or a remote ref deletion for a human under permissionMode acceptEdits',
    });
  });

  it('fails the run when the command exits non-zero', async () => {
    const executor = new CliExecutor({
      command: { run: ['sh', '-c', 'exit 3'] },
    });
    const rec = recorder();
    executor.start(
      { cwd: process.cwd(), prompt: 'x', permissionMode: 'bypassPermissions' },
      rec.events
    );

    const finish = await rec.finished;
    expect(finish.state).toBe('failed');
    expect(finish.error).toContain('3');
  });

  it('reports a missing binary as a failed run rather than throwing', async () => {
    // The likeliest failure of all: the agent simply is not installed.
    const executor = new CliExecutor({
      command: { run: ['dispatch-no-such-agent-binary'] },
    });
    const rec = recorder();
    expect(() =>
      executor.start(
        {
          cwd: process.cwd(),
          prompt: 'x',
          permissionMode: 'bypassPermissions',
        },
        rec.events
      )
    ).not.toThrow();

    const finish = await rec.finished;
    expect(finish.state).toBe('failed');
    expect(finish.error).toContain('dispatch-no-such-agent-binary');
  });

  it('treats a run the user stopped as finished, not failed', async () => {
    // A killed process exits non-zero, but the user pressing stop is not the
    // agent failing — and the orchestrator's finish handling has to run either
    // way so whatever was written still reaches review.
    const executor = new CliExecutor({ command: { run: ['sleep', '30'] } });
    const rec = recorder();
    const run = executor.start(
      { cwd: process.cwd(), prompt: 'x', permissionMode: 'bypassPermissions' },
      rec.events
    );
    run.requestStop();

    expect((await rec.finished).state).toBe('finished');
  });

  it('reports finishing exactly once when a stop races the exit', async () => {
    const executor = new CliExecutor({
      command: { run: ['sh', '-c', 'exit 0'] },
    });
    let finishes = 0;
    const rec = recorder();
    const run = executor.start(
      { cwd: process.cwd(), prompt: 'x', permissionMode: 'bypassPermissions' },
      {
        ...rec.events,
        onFinish: (finish) => {
          finishes += 1;
          rec.events.onFinish(finish);
        },
      }
    );
    await rec.finished;
    await run.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(finishes).toBe(1);
  });

  it('says plainly that it cannot take a mid-run message', async () => {
    const executor = new CliExecutor({ command: { run: ['sleep', '0.1'] } });
    const rec = recorder();
    const run = executor.start(
      { cwd: process.cwd(), prompt: 'x', permissionMode: 'bypassPermissions' },
      rec.events
    );
    run.send('are you there');
    await rec.finished;

    expect(textOf(rec.entries, 'system')).toContain(
      'cannot take a mid-run message'
    );
  });

  it('passes configured environment to the child', async () => {
    const executor = new CliExecutor({
      command: {
        run: ['sh', '-c', 'echo "$DISPATCH_CLI_TEST"'],
        env: { DISPATCH_CLI_TEST: 'from-config' },
      },
    });
    const rec = recorder();
    executor.start(
      { cwd: process.cwd(), prompt: 'x', permissionMode: 'bypassPermissions' },
      rec.events
    );
    await rec.finished;

    expect(textOf(rec.entries, 'assistant')).toContain('from-config');
  });
});

describe('cli presets', () => {
  it('never shadows the natively supported agents', () => {
    // Both already have a real executor with approvals, cost and resumable
    // sessions; a CLI wrapper would silently replace it with less.
    expect(CLI_AGENT_PRESETS.claude).toBeUndefined();
    expect(CLI_AGENT_PRESETS.codex).toBeUndefined();
  });

  it('gives every preset a prompt placeholder or a stdin path', () => {
    for (const [name, command] of Object.entries(CLI_AGENT_PRESETS)) {
      expect(command.run.length, `${name} has an empty argv`).toBeGreaterThan(
        0
      );
    }
  });

  it('offers only the agents that are actually installed', () => {
    // Without this gate the picker would advertise every known agent and most
    // would fail at dispatch with a spawn error.
    const present = availableCliPresets((name) =>
      name === 'gemini' ? '/usr/bin/gemini' : null
    );
    expect(Object.keys(present)).toEqual(['gemini']);

    expect(Object.keys(availableCliPresets(() => null))).toEqual([]);
  });
});
