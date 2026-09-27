import type {
  HookCallback,
  Options,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, jest, spyOn } from 'bun:test';

import {
  ClaudeExecutor,
  STOP_DENIAL_MESSAGE,
} from '../../src/orchestrator/executors/claude.js';
import type {
  ExecutorEvents,
  ExecutorStartOptions,
  MemoryMode,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { preToolUse } from './helpers.js';

const DIR = '/h/.dispatch/runs/k/claude-memory/r-1';
const NATIVE = '/Users/x/.claude/projects/-a/memory/MEMORY.md';
const TOPIC = `${DIR}/mem-01K5Z6G0000000000000000000.md`;

interface MemoryFile {
  path: string;
  type: string;
  tokens: number;
}

interface Session {
  options: Options;
  // The first user message, and every message the session was sent.
  prompt: Promise<string>;
  texts: string[];
  closed: boolean;
  // Set once the executor asked for the loaded memory files.
  asked: boolean;
  release(): void;
}

interface Script {
  // Messages each session yields between init and its assistant line.
  extra?: (session: number) => object[];
  // The CLI version each session's init reports.
  version?: string;
}

// A query() whose sessions each yield init, any `extra` messages, then an
// assistant line and a result. getContextUsage() answers `memoryFiles` only
// after release(), so a test can look at the executor while it is still
// checking the load; a `memoryFiles` that throws makes it reject. A resumed
// session keeps the id it resumes, as the SDK's plain `resume` does.
function scripted(
  memoryFiles: (session: number) => MemoryFile[],
  { extra = () => [], version = '2.1.210' }: Script = {}
) {
  const sessions: Session[] = [];
  const queryFn = (args: {
    prompt: AsyncIterable<{ message: { content: unknown } }>;
    options?: Options;
  }) => {
    const index = sessions.length;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const texts: string[] = [];
    let first: (text: string) => void = () => {};
    const session: Session = {
      options: args.options ?? {},
      prompt: new Promise<string>((resolve) => {
        first = resolve;
      }),
      texts,
      closed: false,
      asked: false,
      release,
    };
    const id = args.options?.resume ?? `s${index}`;
    void (async () => {
      for await (const m of args.prompt) {
        texts.push(String(m.message.content));
        first(texts[0]);
      }
    })();
    sessions.push(session);
    const messages = (async function* (): AsyncGenerator<unknown> {
      // The CLI starts once it has the prompt.
      await session.prompt;
      yield {
        type: 'system',
        subtype: 'init',
        session_id: id,
        claude_code_version: version,
      };
      if (session.closed) return;
      yield* extra(index);
      yield {
        type: 'assistant',
        session_id: id,
        message: {
          content: [{ type: 'text', text: `said in session ${index}` }],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: id,
        result: 'done',
        terminal_reason: 'completed',
        modelUsage: {},
        errors: [],
      };
    })();
    return Object.assign(messages, {
      getContextUsage: () => {
        session.asked = true;
        return released.then(() => ({ memoryFiles: memoryFiles(index) }));
      },
      stopTask: () => Promise.resolve(),
      applyFlagSettings: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      close: () => {
        session.closed = true;
        release();
      },
    }) as unknown as Query;
  };
  return { sessions, queryFn: queryFn as never };
}

function recorder() {
  const entries: NormalizedEntry[] = [];
  const modes: [MemoryMode, string][] = [];
  const recalls: [string[], string][] = [];
  const sessionIds: string[] = [];
  const states: string[] = [];
  const errors: string[] = [];
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: ExecutorEvents = {
    onEntry: (e) => entries.push(e),
    onApprovalRequest: () => {},
    onSession: (id) => sessionIds.push(id),
    onFinish: ({ state, error }) => {
      states.push(state);
      if (error !== undefined) errors.push(error);
      finish();
    },
    onMemoryMode: (mode, detail) => modes.push([mode, detail]),
    onMemoryRecall: (paths, via) => recalls.push([paths, via]),
  };
  const said = () => entries.map((e) => JSON.stringify(e)).join('\n');
  return {
    entries,
    modes,
    recalls,
    sessionIds,
    states,
    errors,
    events,
    finished,
    said,
  };
}

// Runs a PostToolUse hook for one Read, as the CLI does after the tool ran.
function postRead(hook: HookCallback | undefined, filePath: string) {
  return hook?.(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
      tool_response: '',
      tool_use_id: 'tu-2',
      session_id: 's0',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
    } as never,
    'tu-2',
    { signal: new AbortController().signal }
  ) as Promise<{ hookSpecificOutput?: { additionalContext?: string } }>;
}

const exportOpts = {
  mode: 'export' as const,
  dir: DIR,
  probeVersion: '2.1.207',
  fallbackPrompt: 'FALLBACK PROMPT with the index',
  unloadedNote: 'UNLOADED NOTE',
};
const start = {
  cwd: '/tmp/dispatch-worktree-x',
  prompt: 'EXPORT PROMPT',
  permissionMode: 'acceptEdits' as const,
};
const promptModeSettings = {
  autoMemoryEnabled: false,
  env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
};
const EXPORTED = { path: `${DIR}/MEMORY.md`, type: 'AutoMem', tokens: 10 };
const NATIVE_FILE = { path: NATIVE, type: 'AutoMem', tokens: 10 };

// Starts one export-mode run over scripted sessions; `overrides` replaces
// start options, such as a resume's session id and continuation prompt.
function startExport(
  memoryFiles: (session: number) => MemoryFile[],
  script?: Script,
  overrides: Partial<ExecutorStartOptions> = {}
) {
  const s = scripted(memoryFiles, script);
  const r = recorder();
  const run = new ClaudeExecutor(s.queryFn).start(
    { ...start, memory: exportOpts, ...overrides },
    r.events
  );
  return { s, r, run };
}

// Answers the first session's load check, expects the prompt-mode restart,
// lets the restarted session finish and returns the fallback's detail.
async function expectRestart({
  s,
  r,
}: ReturnType<typeof startExport>): Promise<string> {
  s.sessions[0].release();
  await waitUntil(() => s.sessions.length === 2);
  expect(s.sessions[0].closed).toBe(true);
  expect(r.modes.map(([mode]) => mode)).toEqual(['export-fallback']);
  s.sessions[1].release();
  await r.finished;
  expect(r.said()).toContain('said in session 1');
  expect(r.said()).not.toContain('said in session 0');
  expect(r.states).toEqual(['finished']);
  expect(await s.sessions[1].prompt).toBe('FALLBACK PROMPT with the index');
  expect(s.sessions[1].options.settings).toMatchObject(promptModeSettings);
  return r.modes[0][1];
}

// Resolves pending promise callbacks without a timer, for fake-timer tests.
async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !check(); i++) await Promise.resolve();
  expect(check()).toBe(true);
}

// The reason the PreToolUse hook gives a Read, or '' when it gives none.
async function readRefusal(hooks: Options['hooks']): Promise<unknown> {
  return (
    (await preToolUse(hooks, 'Read', { file_path: '/tmp/x' }))
      ?.permissionDecisionReason ?? ''
  );
}

describe('ClaudeExecutor memory modes', () => {
  it('export: refuses every tool until MEMORY.md is confirmed loaded, then runs normally', async () => {
    const { s, r } = startExport(() => [EXPORTED]);
    const options = s.sessions[0].options;
    expect(options.settings).toMatchObject({
      autoMemoryEnabled: true,
      autoMemoryDirectory: DIR,
      env: { CLAUDE_CODE_SIMPLE: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
      disableSkillShellExecution: true,
    });
    expect(options.additionalDirectories).toEqual([DIR]);
    expect(await readRefusal(options.hooks)).toContain('memory setup pending');
    expect(
      await options.canUseTool?.('Write', { file_path: '/tmp/x' }, {
        signal: new AbortController().signal,
        toolUseID: 'tu-3',
        requestId: 'req-3',
      } as never)
    ).toMatchObject({ behavior: 'deny' });
    s.sessions[0].release();
    await waitUntil(() => r.said().includes('said in session 0'));
    expect(await readRefusal(options.hooks)).not.toContain(
      'memory setup pending'
    );
    await r.finished;
    expect(r.modes).toEqual([]);
    expect(s.sessions).toHaveLength(1);
  });

  it('export: the native MEMORY.md loaded instead → the first session ends before any tool, and the run restarts in prompt mode', async () => {
    const started = startExport((i) => (i === 0 ? [NATIVE_FILE] : []));
    const { s, run } = started;
    run.send('FOLLOW-UP sent while the check ran');
    expect(await expectRestart(started)).toContain(NATIVE);
    await waitUntil(() => s.sessions[1].texts.length === 2);
    expect(s.sessions[1].texts[1]).toBe('FOLLOW-UP sent while the check ran');
    expect(s.sessions[1].options.additionalDirectories).toBeUndefined();
    expect(started.r.sessionIds).toEqual(['s1']);
  });

  it('export on a resumed session: the fallback starts a fresh session instead of re-opening the checked one, and the continuation follows the fallback prompt', async () => {
    const started = startExport(
      (i) => (i === 0 ? [NATIVE_FILE] : []),
      {},
      {
        resumeSessionId: 's-prev',
        prompt: 'CONTINUATION with the feedback',
      }
    );
    const { s, r, run } = started;
    run.send('FOLLOW-UP sent while the check ran');
    expect(s.sessions[0].options.resume).toBe('s-prev');
    expect(await expectRestart(started)).toContain(
      'fresh session instead of continuing s-prev'
    );
    expect(s.sessions[1].options.resume).toBeUndefined();
    expect(r.sessionIds).toEqual(['s1']);
    await waitUntil(() => s.sessions[1].texts.length === 3);
    expect(s.sessions[1].texts).toEqual([
      'FALLBACK PROMPT with the index',
      'CONTINUATION with the feedback',
      'FOLLOW-UP sent while the check ran',
    ]);
  });

  it('export on a resumed session without a fallback prompt: the run fails rather than start a fresh session with only the continuation', async () => {
    const { s, r } = startExport(
      () => [NATIVE_FILE],
      {},
      {
        resumeSessionId: 's-prev',
        prompt: 'CONTINUATION with the feedback',
        memory: { ...exportOpts, fallbackPrompt: undefined },
      }
    );
    s.sessions[0].release();
    await r.finished;
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].closed).toBe(true);
    expect(r.states).toEqual(['failed']);
    expect(r.errors[0]).toContain(NATIVE);
    expect(r.errors[0]).toContain('no fallback prompt');
    expect(r.said()).not.toContain('said in session 0');
    expect(r.sessionIds).toEqual([]);
  });

  it('export: notes and a stop that arrive during the check reach the restarted session', async () => {
    const started = startExport((i) => (i === 0 ? [NATIVE_FILE] : []));
    const { s, run } = started;
    run.notify('NOTE sent while the check ran');
    run.requestStop();
    s.sessions[0].release();
    await waitUntil(() => s.sessions.length === 2);
    const hooks = s.sessions[1].options.hooks;
    expect(await readRefusal(hooks)).toBe(STOP_DENIAL_MESSAGE);
    const post = hooks?.PostToolUse?.[0]?.hooks[0];
    expect(
      (await postRead(post, '/tmp/x')).hookSpecificOutput?.additionalContext
    ).toBe('NOTE sent while the check ran');
    s.sessions[1].release();
    await started.r.finished;
  });

  it('export: a CLI older than the probe restarts in prompt mode, whatever it lists', async () => {
    for (const listed of [[EXPORTED], []]) {
      const started = startExport((i) => (i === 0 ? listed : []), {
        version: '2.1.200',
      });
      expect(await expectRestart(started)).toContain(
        'Claude Code 2.1.200 is older than the probed 2.1.207'
      );
    }
  });

  it('export: an auto-memory file of a type Dispatch does not know, or any other MEMORY.md, restarts in prompt mode', async () => {
    for (const odd of [
      { path: NATIVE, type: 'AutoMemory', tokens: 10 },
      { path: '/Users/x/.claude/team/notes.md', type: 'TeamMem', tokens: 10 },
      { path: '/repo/MEMORY.md', type: 'Project', tokens: 10 },
    ]) {
      const started = startExport((i) => (i === 0 ? [EXPORTED, odd] : []));
      expect(await expectRestart(started)).toContain(odd.path);
    }
  });

  it('export: CLAUDE.md files of the known types load beside the export', async () => {
    const { s, r } = startExport(() => [
      EXPORTED,
      { path: '/Users/x/.claude/CLAUDE.md', type: 'User', tokens: 1 },
      { path: '/repo/CLAUDE.md', type: 'Project', tokens: 1 },
      { path: '/repo/CLAUDE.local.md', type: 'Local', tokens: 1 },
      { path: '/etc/claude-code/CLAUDE.md', type: 'Managed', tokens: 1 },
    ]);
    s.sessions[0].release();
    await r.finished;
    expect(r.modes).toEqual([]);
    expect(s.sessions).toHaveLength(1);
  });

  it('export: a CLI that never answers the check restarts in prompt mode after 30s', async () => {
    jest.useFakeTimers();
    try {
      const started = startExport(() => []);
      await settle(() => started.s.sessions[0].asked);
      jest.advanceTimersByTime(29_999);
      await settle(() => true);
      expect(started.r.modes).toEqual([]);
      jest.advanceTimersByTime(1);
      await settle(() => started.r.modes.length === 1);
      jest.useRealTimers();
      expect(await expectRestart(started)).toContain('no answer within 30s');
    } finally {
      jest.useRealTimers();
    }
  });

  it('export: a native file listed beside the export still restarts in prompt mode', async () => {
    const started = startExport((i) =>
      i === 0 ? [EXPORTED, NATIVE_FILE] : []
    );
    expect(await expectRestart(started)).toContain(NATIVE);
  });

  it('export: a CLI that cannot report its memory files restarts in prompt mode', async () => {
    const started = startExport((i) => {
      if (i === 0) throw new Error('unsupported control request');
      return [];
    });
    expect(await expectRestart(started)).toContain(
      'unsupported control request'
    );
  });

  it('export: nothing loaded → continue, report export-unloaded, and hand the agent the note with its first tool result', async () => {
    const { s, r } = startExport(() => []);
    s.sessions[0].release();
    await waitUntil(() => r.modes.length === 1);
    expect(r.modes[0][0]).toBe('export-unloaded');
    const post = s.sessions[0].options.hooks?.PostToolUse?.[0]?.hooks[0];
    const out = await postRead(post, '/tmp/x');
    expect(out.hookSpecificOutput?.additionalContext).toContain(
      'UNLOADED NOTE'
    );
    await r.finished;
    expect(r.said()).toContain('said in session 0');
  });

  it('export: an interrupt during the check ends the run without a restart', async () => {
    const { s, r, run } = startExport(() => [NATIVE_FILE]);
    await run.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.sessions).toHaveLength(1);
    expect(r.modes).toEqual([]);
    expect(r.states).toEqual([]);
  });

  it('reports reads under the directory and memory_recall messages as recalls', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    let lines: string[] = [];
    try {
      const { s, r } = startExport(() => [EXPORTED], {
        extra: () => [
          {
            type: 'system',
            subtype: 'memory_recall',
            mode: 'select',
            memories: [
              { path: TOPIC, scope: 'personal' },
              { path: `<synthesis:${DIR}>`, scope: 'personal', content: 'x' },
              { path: 'https://example.com/org/memory.md', scope: 'team' },
            ],
            uuid: 'u',
            session_id: 's0',
          },
        ],
      });
      const post = s.sessions[0].options.hooks?.PostToolUse?.[0]?.hooks[0];
      await postRead(post, TOPIC);
      await postRead(post, '/tmp/elsewhere.md');
      expect(r.recalls).toEqual([[[TOPIC], 'read']]);
      s.sessions[0].release();
      await r.finished;
      expect(r.recalls).toEqual([
        [[TOPIC], 'read'],
        [[TOPIC], 'claude-recall'],
      ]);
    } finally {
      lines = logged.mock.calls.map((call) => String(call[0]));
      logged.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`<synthesis:${DIR}>`);
    expect(lines[0]).toContain('https://example.com/org/memory.md');
  });

  it('prompt mode passes the pinned-off settings and no load check; native, or no memory option, passes none', async () => {
    const s = scripted(() => []);
    const executor = new ClaudeExecutor(s.queryFn);
    executor.start({ ...start, memory: { mode: 'prompt' } }, recorder().events);
    executor.start({ ...start, memory: { mode: 'native' } }, recorder().events);
    executor.start(start, recorder().events);
    expect(s.sessions[0].options.settings).toMatchObject(promptModeSettings);
    expect(await readRefusal(s.sessions[0].options.hooks)).not.toContain(
      'memory setup pending'
    );
    for (const i of [1, 2]) {
      const settings = s.sessions[i].options.settings as
        | { autoMemoryEnabled?: boolean }
        | undefined;
      expect(settings?.autoMemoryEnabled).toBeUndefined();
      expect(s.sessions[i].options.additionalDirectories).toBeUndefined();
    }
    for (const session of s.sessions) session.release();
  });
});

// Polls a condition the executor reaches asynchronously.
async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}
