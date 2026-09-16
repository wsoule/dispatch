import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  CodexAppServer,
  type CodexAppServerProcess,
} from '../../src/orchestrator/codexAppServer.js';
import { CodexExecutor } from '../../src/orchestrator/executors/codex.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

class FakeCodexProcess implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RpcMessage[] = [];
  killed = false;
  private readonly events = new EventEmitter();
  private input = '';

  constructor(
    private readonly handleRequest: (
      request: RpcMessage,
      process: FakeCodexProcess
    ) => void = () => {}
  ) {
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.input += chunk;
      for (;;) {
        const newline = this.input.indexOf('\n');
        if (newline === -1) return;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        const request = JSON.parse(line) as RpcMessage;
        this.requests.push(request);
        if (request.method !== undefined) this.handleRequest(request, this);
      }
    });
  }

  once(
    event: 'error' | 'exit',
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
  ): this {
    this.events.once(event, listener);
    return this;
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.events.emit('exit', null, 'SIGTERM'));
    return true;
  }

  reply(id: number | string | undefined, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\r\n`);
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  serverRequest(
    method: string,
    id: number | string,
    params: Record<string, unknown>
  ): void {
    this.stdout.write(`${JSON.stringify({ method, id, params })}\n`);
  }

  failExit(code = 1): void {
    this.events.emit('exit', code, null);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}

function scriptedProcess(
  options: {
    threadId?: string;
    afterTurn?: (process: FakeCodexProcess) => void;
  } = {}
): FakeCodexProcess {
  const threadId = options.threadId ?? 'thread-new';
  return new FakeCodexProcess((request, process) => {
    if (request.method === 'initialize') process.reply(request.id, {});
    if (
      request.method === 'thread/start' ||
      request.method === 'thread/resume'
    ) {
      process.reply(request.id, { thread: { id: threadId } });
    }
    if (request.method === 'turn/start') {
      process.reply(request.id, { turn: { id: 'turn-1' } });
      process.notify('turn/started', {
        threadId,
        turn: { id: 'turn-1', status: 'inProgress', error: null },
      });
      options.afterTurn?.(process);
    }
    if (request.method === 'turn/steer') {
      process.reply(request.id, { turnId: 'turn-1' });
    }
    if (request.method === 'turn/interrupt') process.reply(request.id, {});
  });
}

function startHarness(
  process: FakeCodexProcess,
  resumeSessionId?: string,
  model?: string
): {
  entries: NormalizedEntry[];
  approvals: Parameters<ExecutorEvents['onApprovalRequest']>[0][];
  sessions: string[];
  finishes: Parameters<ExecutorEvents['onFinish']>[0][];
  run: ReturnType<CodexExecutor['start']>;
} {
  const entries: NormalizedEntry[] = [];
  const approvals: Parameters<ExecutorEvents['onApprovalRequest']>[0][] = [];
  const sessions: string[] = [];
  const finishes: Parameters<ExecutorEvents['onFinish']>[0][] = [];
  const executor = new CodexExecutor(() => process);
  const run = executor.start(
    {
      cwd: 'C:\\worktree',
      projectRoot: 'C:\\project',
      runId: 'r-codex',
      prompt: 'make the change',
      permissionMode: 'auto',
      resumeSessionId,
      model,
    },
    {
      onEntry: (entry) => entries.push(entry),
      onApprovalRequest: (approval) => approvals.push(approval),
      onSession: (sessionId) => sessions.push(sessionId),
      onFinish: (finish) => finishes.push(finish),
    }
  );
  return { entries, approvals, sessions, finishes, run };
}

describe('CodexAppServer transport', () => {
  it('frames requests, defers handled server requests, and rejects unsupported ones', async () => {
    const process = new FakeCodexProcess();
    const server = new CodexAppServer('C:\\worktree', () => process);
    const pending = server.request<{ ok: boolean }>('initialize', { value: 1 });
    expect(process.requests[0]).toEqual({
      method: 'initialize',
      id: 1,
      params: { value: 1 },
    });
    process.reply(1, { ok: true });
    expect(await pending).toEqual({ ok: true });

    const serverRequests: Array<{
      id: number | string;
      method: string;
      params?: unknown;
    }> = [];
    server.onServerRequest((request) => {
      serverRequests.push(request);
      return request.method === 'item/commandExecution/requestApproval';
    });
    process.serverRequest('item/commandExecution/requestApproval', 71, {
      command: 'git status',
    });
    await waitFor(() => serverRequests.length === 1);
    expect(serverRequests[0]).toMatchObject({
      id: 71,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'git status' },
    });
    expect(process.requests.some((message) => message.id === 71)).toBe(false);
    server.respond(71, { decision: 'accept' });
    expect(process.requests.at(-1)).toEqual({
      id: 71,
      result: { decision: 'accept' },
    });

    process.notify('item/tool/requestUserInput', { unexpected: true });
    process.stdout.write(
      `${JSON.stringify({ method: 'item/tool/requestUserInput', id: 'server-1', params: {} })}\n`
    );
    await waitFor(() =>
      process.requests.some(
        (message) =>
          message.id === 'server-1' &&
          (message.error as { code?: number } | undefined)?.code === -32601
      )
    );
    server.close();
  });

  it('rejects pending requests on malformed output and process exit', async () => {
    const malformedProcess = new FakeCodexProcess();
    const malformedServer = new CodexAppServer(
      'C:\\worktree',
      () => malformedProcess
    );
    const malformed = malformedServer.request('initialize', {});
    malformedProcess.stdout.write('{not json}\n');
    await expect(malformed).rejects.toThrow(
      'malformed Codex App Server output'
    );
    expect((await malformedServer.closed).error?.message).toContain(
      'malformed'
    );

    const exitedProcess = new FakeCodexProcess();
    const exitedServer = new CodexAppServer(
      'C:\\worktree',
      () => exitedProcess
    );
    const exited = exitedServer.request('initialize', {});
    exitedProcess.stderr.write('app server crashed');
    exitedProcess.failExit(7);
    await expect(exited).rejects.toThrow('exited before replying');
    expect((await exitedServer.closed).stderr).toBe('app server crashed');
  });

  it('settles asynchronous stdin errors without an uncaught stream error', async () => {
    const process = new FakeCodexProcess();
    const server = new CodexAppServer('C:\\worktree', () => process);
    const pending = server.request('initialize', {});
    const failure = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    process.stdin.destroy(failure);

    await expect(pending).rejects.toThrow('write EPIPE');
    expect((await server.closed).error).toBe(failure);
  });
});

describe('CodexExecutor', () => {
  it('rejects unsupported permission modes before starting the App Server', () => {
    for (const permissionMode of [
      'default',
      'acceptEdits',
      'dontAsk',
      'plan',
      'bypassPermissions',
    ]) {
      const process = scriptedProcess();
      let spawnCalls = 0;
      const executor = new CodexExecutor(() => {
        spawnCalls += 1;
        return process;
      });

      expect(() =>
        executor.start(
          {
            cwd: 'C:\\worktree',
            prompt: 'make the change',
            permissionMode,
          },
          {
            onEntry: () => {},
            onApprovalRequest: () => {},
            onFinish: () => {},
          }
        )
      ).toThrow(
        `Codex currently supports Dispatch permission mode "auto" only; configured mode is "${permissionMode}"`
      );
      expect(spawnCalls).toBe(0);
      expect(process.requests).toEqual([]);
    }
  });

  it('handles immediate turn notifications, maps useful entries, and finishes once', async () => {
    const oldMcpBin = process.env.DISPATCH_MCP_BIN;
    process.env.DISPATCH_MCP_BIN = 'C:\\tools\\dispatch-mcp.exe';
    try {
      const process = scriptedProcess({
        afterTurn(fake) {
          fake.notify('item/completed', {
            threadId: 'thread-new',
            turnId: 'turn-unrelated',
            item: {
              type: 'fileChange',
              id: 'unrelated-file',
              changes: [{ path: 'unrelated.ts' }],
              status: 'failed',
            },
          });

          fake.notify('item/started', {
            threadId: 'thread-new',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'command-1',
              command: 'git status',
              cwd: 'C:\\worktree',
              status: 'inProgress',
            },
          });
          fake.notify('item/completed', {
            threadId: 'thread-new',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'command-1',
              command: 'git status',
              cwd: 'C:\\worktree',
              status: 'completed',
              aggregatedOutput: 'clean',
              exitCode: 0,
            },
          });
          fake.notify('item/started', {
            threadId: 'thread-new',
            turnId: 'turn-1',
            item: {
              type: 'fileChange',
              id: 'file-1',
              changes: [{ path: 'a.ts' }],
              status: 'inProgress',
            },
          });
          fake.notify('item/completed', {
            threadId: 'thread-new',
            turnId: 'turn-1',
            item: {
              type: 'mcpToolCall',
              id: 'mcp-1',
              server: 'dispatch',
              tool: 'task_get',
              arguments: { id: 't-1' },
              status: 'completed',
            },
          });
          fake.notify('item/completed', {
            threadId: 'thread-new',
            turnId: 'turn-1',
            item: {
              type: 'reasoning',
              id: 'reason-1',
              summary: ['Checked it.'],
            },
          });
          fake.notify('item/completed', {
            threadId: 'thread-new',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'message-1', text: 'Done.' },
          });
          fake.notify('turn/completed', {
            threadId: 'thread-new',
            turn: { id: 'turn-1', status: 'completed', error: null },
          });
          fake.notify('turn/completed', {
            threadId: 'thread-new',
            turn: { id: 'turn-1', status: 'completed', error: null },
          });
        },
      });
      const harness = startHarness(process, undefined, 'gpt-6-astra');
      await waitFor(() => harness.finishes.length === 1);

      expect(process.requests.map((request) => request.method)).toEqual([
        'initialize',
        'initialized',
        'thread/start',
        'turn/start',
      ]);
      expect(process.requests[2]?.params).toEqual({
        model: 'gpt-6-astra',
        cwd: 'C:\\worktree',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
        config: {
          mcp_servers: {
            dispatch: {
              command: 'C:\\tools\\dispatch-mcp.exe',
              args: ['--root', 'C:\\worktree'],
              env: expect.objectContaining({
                DISPATCH_PROJECT_ROOT: 'C:\\project',
                DISPATCH_RUN_ID: 'r-codex',
              }),
              required: true,
              tool_timeout_sec: 1860,
              tools: {
                task_comment: { approval_mode: 'approve' },
                record_evidence: { approval_mode: 'approve' },
                record_mutation: { approval_mode: 'approve' },
                ask_user: { approval_mode: 'approve' },
              },
            },
          },
        },
      });
      expect(process.requests[3]?.params).toEqual({
        threadId: 'thread-new',
        input: [{ type: 'text', text: 'make the change', text_elements: [] }],
      });
      expect(JSON.stringify(process.requests.slice(2))).not.toContain(
        'writableRoots'
      );
      expect(JSON.stringify(process.requests.slice(2))).not.toContain(
        'sandboxPolicy'
      );
      expect(harness.sessions).toEqual(['thread-new']);
      expect(harness.entries.map((entry) => entry.kind)).toEqual([
        'tool',
        'tool',
        'tool',
        'tool',
        'thinking',
        'assistant',
      ]);
      expect(harness.finishes).toEqual([
        { state: 'finished', sessionId: 'thread-new' },
      ]);
    } finally {
      if (oldMcpBin === undefined) delete process.env.DISPATCH_MCP_BIN;
      else process.env.DISPATCH_MCP_BIN = oldMcpBin;
    }
  });

  it('resumes the exact stored sessionId and re-supplies thread config', async () => {
    const process = scriptedProcess({
      threadId: 'thread-existing',
      afterTurn(fake) {
        fake.notify('turn/completed', {
          threadId: 'thread-existing',
          turn: { id: 'turn-1', status: 'completed', error: null },
        });
      },
    });
    const harness = startHarness(process, 'thread-existing', 'gpt-5.6-codex');
    await waitFor(() => harness.finishes.length === 1);
    const resume = process.requests.find(
      (request) => request.method === 'thread/resume'
    );
    expect(resume?.params?.threadId).toBe('thread-existing');
    expect(resume?.params?.model).toBe('gpt-5.6-codex');
    expect(resume?.params?.config).toEqual({
      mcp_servers: {
        dispatch: {
          command: expect.any(String),
          args: expect.any(Array),
          env: expect.objectContaining({
            DISPATCH_PROJECT_ROOT: 'C:\\project',
            DISPATCH_RUN_ID: 'r-codex',
          }),
          required: true,
          tool_timeout_sec: 1860,
          tools: {
            task_comment: { approval_mode: 'approve' },
            record_evidence: { approval_mode: 'approve' },
            record_mutation: { approval_mode: 'approve' },
            ask_user: { approval_mode: 'approve' },
          },
        },
      },
    });
    expect(resume?.params?.approvalPolicy).toBe('on-request');
    expect(resume?.params?.approvalsReviewer).toBe('auto_review');
    expect(resume?.params?.sandbox).toBe('workspace-write');
    const turnStart = process.requests.find(
      (request) => request.method === 'turn/start'
    );
    expect(turnStart?.params).toEqual({
      threadId: 'thread-existing',
      input: [{ type: 'text', text: 'make the change', text_elements: [] }],
    });
    expect(JSON.stringify(process.requests.slice(2))).not.toContain(
      'writableRoots'
    );
    expect(harness.sessions).toEqual(['thread-existing']);
  });

  it('keeps failed child diagnostics without poisoning a completed turn', async () => {
    const process = scriptedProcess({
      afterTurn(fake) {
        fake.notify('item/completed', {
          threadId: 'thread-new',
          turnId: 'turn-1',
          item: {
            type: 'fileChange',
            id: 'file-1',
            changes: [{ path: 'broken.ts' }],
            status: 'failed',
          },
        });
        fake.notify('item/completed', {
          threadId: 'thread-new',
          turnId: 'turn-1',
          item: {
            type: 'fileChange',
            id: 'file-2',
            changes: [{ path: 'fixed.ts' }],
            status: 'completed',
          },
        });
        fake.notify('turn/completed', {
          threadId: 'thread-new',
          turn: { id: 'turn-1', status: 'completed', error: null },
        });
      },
    });
    const harness = startHarness(process);
    await waitFor(() => harness.finishes.length === 1);
    expect(harness.entries).toEqual([
      expect.objectContaining({
        kind: 'tool',
        toolName: 'codex.fileChange',
        toolInput: { changes: [{ path: 'broken.ts' }] },
        status: 'error',
      }),
      expect.objectContaining({
        kind: 'tool',
        toolName: 'codex.fileChange',
        toolInput: { changes: [{ path: 'fixed.ts' }] },
        status: 'done',
      }),
    ]);
    expect(harness.finishes).toEqual([
      { state: 'finished', sessionId: 'thread-new' },
    ]);
  });

  it('maps failed and interrupted turns conservatively', async () => {
    for (const status of ['failed', 'interrupted'] as const) {
      const process = scriptedProcess({
        afterTurn(fake) {
          fake.notify('turn/completed', {
            threadId: 'thread-new',
            turn: {
              id: 'turn-1',
              status,
              error: status === 'failed' ? { message: 'model failed' } : null,
            },
          });
        },
      });
      const harness = startHarness(process);
      await waitFor(() => harness.finishes.length === 1);
      expect(harness.finishes[0]?.state).toBe('failed');
      expect(harness.finishes[0]?.error).toBe(
        status === 'failed'
          ? 'model failed'
          : 'Codex turn ended with status interrupted'
      );
    }
  });

  it('bridges command approval allow and deny without failing or double-finishing', async () => {
    for (const testCase of [
      { providerId: 41, decision: { allow: true }, expected: 'accept' },
      {
        providerId: 'command-deny',
        decision: { allow: false },
        expected: 'decline',
      },
    ] as const) {
      const process = scriptedProcess({
        afterTurn(fake) {
          fake.serverRequest(
            'item/commandExecution/requestApproval',
            testCase.providerId,
            { command: 'git status', cwd: 'C:\\worktree' }
          );
        },
      });
      const harness = startHarness(process);
      await waitFor(() => harness.approvals.length === 1);

      expect(harness.approvals[0]).toEqual({
        requestId: expect.any(String),
        toolName: 'codex.commandExecution',
        input: { command: 'git status', cwd: 'C:\\worktree' },
      });
      expect(harness.finishes).toEqual([]);

      harness.run.approve(harness.approvals[0].requestId, testCase.decision);
      await waitFor(() =>
        process.requests.some(
          (message) =>
            message.id === testCase.providerId && message.result !== undefined
        )
      );
      expect(
        process.requests.find(
          (message) =>
            message.id === testCase.providerId && message.result !== undefined
        )?.result
      ).toEqual({ decision: testCase.expected });
      harness.run.approve(harness.approvals[0].requestId, {
        allow: !testCase.decision.allow,
      });
      expect(
        process.requests.filter(
          (message) =>
            message.id === testCase.providerId && message.result !== undefined
        )
      ).toHaveLength(1);

      process.notify('turn/completed', {
        threadId: 'thread-new',
        turn: { id: 'turn-1', status: 'completed', error: null },
      });
      process.notify('turn/completed', {
        threadId: 'thread-new',
        turn: { id: 'turn-1', status: 'completed', error: null },
      });
      await waitFor(() => harness.finishes.length === 1);
      expect(harness.finishes).toEqual([
        { state: 'finished', sessionId: 'thread-new' },
      ]);
    }
  });

  it('handles command approval before the turn/start response', async () => {
    const order: string[] = [];
    const providerRequestId = 123;
    const process = new FakeCodexProcess((request, fake) => {
      if (request.method === 'initialize') fake.reply(request.id, {});
      if (request.method === 'thread/start') {
        fake.reply(request.id, { thread: { id: 'thread-new' } });
      }
      if (request.method === 'turn/start') {
        order.push('turn/start request received');
        fake.serverRequest(
          'item/commandExecution/requestApproval',
          providerRequestId,
          { command: 'git status', cwd: 'C:\\worktree' }
        );
        order.push('approval emitted');
        fake.reply(request.id, { turn: { id: 'turn-1' } });
        order.push('turn/start response sent');
      }
    });
    const harness = startHarness(process);

    await waitFor(() => harness.approvals.length === 1);
    expect(order).toEqual([
      'turn/start request received',
      'approval emitted',
      'turn/start response sent',
    ]);
    expect(harness.finishes).toEqual([]);
    const approval = harness.approvals[0];
    expect(approval).toMatchObject({
      toolName: 'codex.commandExecution',
      input: { command: 'git status', cwd: 'C:\\worktree' },
    });

    harness.run.approve(approval.requestId, { allow: true });
    await waitFor(() =>
      process.requests.some(
        (message) =>
          message.id === providerRequestId && message.result !== undefined
      )
    );
    expect(
      process.requests.find(
        (message) =>
          message.id === providerRequestId && message.result !== undefined
      )?.result
    ).toEqual({ decision: 'accept' });

    process.notify('turn/completed', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'completed', error: null },
    });
    await waitFor(() => harness.finishes.length === 1);
    expect(harness.finishes).toEqual([
      { state: 'finished', sessionId: 'thread-new' },
    ]);
  });

  it('maps session command and file-change approvals to acceptForSession', async () => {
    for (const [method, toolName] of [
      ['item/commandExecution/requestApproval', 'codex.commandExecution'],
      ['item/fileChange/requestApproval', 'codex.fileChange'],
    ] as const) {
      const process = scriptedProcess({
        afterTurn(fake) {
          fake.serverRequest(method, `session-${toolName}`, {
            reason: 'needs broader access',
          });
        },
      });
      const harness = startHarness(process);
      await waitFor(() => harness.approvals.length === 1);
      expect(harness.approvals[0]?.toolName).toBe(toolName);

      harness.run.approve(harness.approvals[0].requestId, {
        allow: true,
        scope: 'session',
      });
      await waitFor(() =>
        process.requests.some((message) => message.id === `session-${toolName}`)
      );
      expect(
        process.requests.find((message) => message.id === `session-${toolName}`)
          ?.result
      ).toEqual({ decision: 'acceptForSession' });
      await harness.run.interrupt();
    }
  });

  it('returns the requested permission subset for allow scopes and none for deny', async () => {
    for (const testCase of [
      {
        providerId: 91,
        decision: { allow: true },
        expected: {
          permissions: { filesystem: { read: ['C:\\worktree'] } },
          scope: 'turn',
        },
      },
      {
        providerId: 'permissions-session',
        decision: { allow: true, scope: 'session' },
        expected: {
          permissions: { filesystem: { read: ['C:\\worktree'] } },
          scope: 'session',
        },
      },
      {
        providerId: 'permissions-deny',
        decision: { allow: false },
        expected: { permissions: {}, scope: 'turn' },
      },
    ] as const) {
      const permissions = { filesystem: { read: ['C:\\worktree'] } };
      const process = scriptedProcess({
        afterTurn(fake) {
          fake.serverRequest(
            'item/permissions/requestApproval',
            testCase.providerId,
            { permissions, reason: 'inspect the worktree' }
          );
        },
      });
      const harness = startHarness(process);
      await waitFor(() => harness.approvals.length === 1);
      expect(harness.approvals[0]).toMatchObject({
        toolName: 'codex.permissions',
        input: { permissions, reason: 'inspect the worktree' },
      });

      harness.run.approve(harness.approvals[0].requestId, testCase.decision);
      await waitFor(() =>
        process.requests.some(
          (message) =>
            message.id === testCase.providerId && message.result !== undefined
        )
      );
      expect(
        process.requests.find(
          (message) =>
            message.id === testCase.providerId && message.result !== undefined
        )?.result
      ).toEqual(testCase.expected);
      await harness.run.interrupt();
    }
  });

  it('fails on early exit, malformed output, resume mismatch, and unsupported server requests', async () => {
    const cases: Array<{
      process: FakeCodexProcess;
      resume?: string;
      expected: string;
    }> = [];

    const early = scriptedProcess({
      afterTurn(fake) {
        fake.failExit(2);
      },
    });
    cases.push({ process: early, expected: 'ended before turn completion' });

    const malformed = scriptedProcess({
      afterTurn(fake) {
        fake.stdout.write('not-json\n');
      },
    });
    cases.push({
      process: malformed,
      expected: 'malformed Codex App Server output',
    });

    const mismatch = scriptedProcess({ threadId: 'different-thread' });
    cases.push({
      process: mismatch,
      resume: 'thread-existing',
      expected: 'instead of thread-existing',
    });

    const unsupported = scriptedProcess({
      afterTurn(fake) {
        fake.stdout.write(
          `${JSON.stringify({ method: 'item/tool/requestUserInput', id: 'question-1', params: {} })}\n`
        );
        fake.notify('turn/completed', {
          threadId: 'thread-new',
          turn: { id: 'turn-1', status: 'completed', error: null },
        });
      },
    });
    cases.push({
      process: unsupported,
      expected: 'Unsupported Codex server request',
    });

    for (const testCase of cases) {
      const harness = startHarness(testCase.process, testCase.resume);
      await waitFor(() => harness.finishes.length === 1);
      expect(harness.finishes[0]?.state).toBe('failed');
      expect(harness.finishes[0]?.error).toContain(testCase.expected);
    }
  });

  it('denies pending and later approvals while gracefully stopping', async () => {
    const process = scriptedProcess({
      afterTurn(fake) {
        fake.serverRequest('item/commandExecution/requestApproval', 201, {
          command: 'git status',
          cwd: 'C:\\worktree',
        });
      },
    });
    const harness = startHarness(process);
    await waitFor(() => harness.approvals.length === 1);

    harness.run.requestStop();
    harness.run.requestStop();
    await waitFor(
      () =>
        process.requests.some((request) => request.id === 201) &&
        process.requests.some((request) => request.method === 'turn/steer')
    );

    expect(
      process.requests.find((request) => request.id === 201)?.result
    ).toEqual({ decision: 'decline' });
    expect(
      process.requests.filter((request) => request.method === 'turn/steer')
    ).toHaveLength(1);
    expect(
      JSON.stringify(
        process.requests.find((request) => request.method === 'turn/steer')
          ?.params?.input
      )
    ).toContain('The user asked this run to stop');

    process.serverRequest('item/fileChange/requestApproval', 202, {
      changes: [{ path: 'late.ts' }],
    });
    await waitFor(() => process.requests.some((request) => request.id === 202));
    expect(
      process.requests.find((request) => request.id === 202)?.result
    ).toEqual({ decision: 'decline' });
    expect(harness.approvals).toHaveLength(1);

    harness.run.approve(harness.approvals[0].requestId, { allow: true });
    expect(
      process.requests.filter((request) => request.id === 201)
    ).toHaveLength(1);
    await harness.run.interrupt();
  });

  it('buffers send/requestStop until the turn exists and interrupts at the MVP boundary', async () => {
    const process = scriptedProcess();
    const harness = startHarness(process);
    harness.run.send('additional detail');
    harness.run.requestStop();
    await waitFor(
      () =>
        process.requests.filter((request) => request.method === 'turn/steer')
          .length === 2
    );
    const steers = process.requests.filter(
      (request) => request.method === 'turn/steer'
    );
    expect(steers[0]?.params?.expectedTurnId).toBe('turn-1');
    expect(steers[0]?.params?.input).toEqual([
      { type: 'text', text: 'additional detail', text_elements: [] },
    ]);
    expect(JSON.stringify(steers[1]?.params?.input)).toContain(
      'The user asked this run to stop'
    );

    await harness.run.interrupt();
    expect(
      process.requests.some((request) => request.method === 'turn/interrupt')
    ).toBe(true);
    expect(process.killed).toBe(true);
    expect(harness.finishes).toEqual([]);
    harness.run.approve('unused', { allow: false });
  });
});
