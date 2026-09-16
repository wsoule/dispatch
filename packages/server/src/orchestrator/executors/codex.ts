import { CORE_VERSION } from '@dispatch/core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  CodexAppServer,
  type CodexAppServerMessage,
  type CodexAppServerRequest,
  type SpawnCodexAppServer,
} from '../codexAppServer.js';
import type {
  ApprovalDecision,
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  NormalizedEntry,
} from '../types.js';

const MCP_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'BUN_INSTALL',
  'DISPATCH_HOME',
];
const DISPATCH_MCP_TOOL_TIMEOUT_SEC = 31 * 60;
const STOP_MESSAGE =
  'The user asked this run to stop. Finish the current operation, start no new work, summarize what is complete and what remains, then end the turn.';

const CODEX_APPROVAL_TOOL_NAMES = {
  'item/commandExecution/requestApproval': 'codex.commandExecution',
  'item/fileChange/requestApproval': 'codex.fileChange',
  'item/permissions/requestApproval': 'codex.permissions',
} as const;

type CodexApprovalMethod = keyof typeof CODEX_APPROVAL_TOOL_NAMES;

interface PendingCodexApproval {
  method: CodexApprovalMethod;
  params: unknown;
  providerRequestId: CodexAppServerRequest['id'];
}

interface CodexThreadResponse {
  thread?: { id?: unknown };
}

interface CodexTurnResponse {
  turn?: { id?: unknown };
}

interface CodexItem {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  summary?: unknown;
  command?: unknown;
  cwd?: unknown;
  status?: unknown;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
  aggregatedOutput?: unknown;
  exitCode?: unknown;
  error?: unknown;
}

function resolveMcpBin(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/mcp/package.json'
  );
  return join(dirname(pkgJsonPath), 'src', 'bin.ts');
}

/** Builds the run-scoped Dispatch MCP config re-supplied on start and resume. */
function buildCodexDispatchMcpConfig(
  cwd: string,
  projectRoot: string,
  runId: string
): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const key of MCP_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.DISPATCH_PROJECT_ROOT = projectRoot;
  env.DISPATCH_RUN_ID = runId;

  const packagedBin = process.env.DISPATCH_MCP_BIN;
  const command =
    packagedBin !== undefined && packagedBin !== '' ? packagedBin : 'bun';
  const args =
    packagedBin !== undefined && packagedBin !== ''
      ? ['--root', cwd]
      : [resolveMcpBin(), '--root', cwd];
  return {
    mcp_servers: {
      dispatch: {
        command,
        args,
        env,
        required: true,
        tool_timeout_sec: DISPATCH_MCP_TOOL_TIMEOUT_SEC,
        tools: {
          task_comment: { approval_mode: 'approve' },
          record_evidence: { approval_mode: 'approve' },
          record_mutation: { approval_mode: 'approve' },
          ask_user: { approval_mode: 'approve' },
        },
      },
    },
  };
}

function textInput(text: string): object[] {
  return [{ type: 'text', text, text_elements: [] }];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCodexApprovalMethod(method: string): method is CodexApprovalMethod {
  return Object.hasOwn(CODEX_APPROVAL_TOOL_NAMES, method);
}

function approvalResult(
  approval: PendingCodexApproval,
  decision: ApprovalDecision
): Record<string, unknown> {
  if (approval.method === 'item/permissions/requestApproval') {
    return {
      permissions: decision.allow
        ? (objectValue(approval.params)?.permissions ?? {})
        : {},
      scope:
        decision.allow && decision.scope === 'session' ? 'session' : 'turn',
    };
  }
  return {
    decision: decision.allow
      ? decision.scope === 'session'
        ? 'acceptForSession'
        : 'accept'
      : 'decline',
  };
}

function itemFrom(message: CodexAppServerMessage): CodexItem | undefined {
  return objectValue(objectValue(message.params)?.item) as
    | CodexItem
    | undefined;
}

function statusForItem(status: unknown): 'running' | 'done' | 'error' {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'declined') return 'error';
  return 'running';
}

function entryForItem(
  item: CodexItem,
  completed: boolean
): NormalizedEntry | undefined {
  const ts = new Date().toISOString();
  if (
    item.type === 'agentMessage' &&
    completed &&
    typeof item.text === 'string'
  ) {
    return { ts, kind: 'assistant', text: item.text };
  }
  if (item.type === 'reasoning' && completed && Array.isArray(item.summary)) {
    const text = item.summary
      .filter((part) => typeof part === 'string')
      .join('\n');
    return text === '' ? undefined : { ts, kind: 'thinking', text };
  }
  if (item.type === 'commandExecution') {
    return {
      ts,
      kind: 'tool',
      toolName: 'codex.commandExecution',
      toolInput: {
        command: item.command,
        cwd: item.cwd,
        ...(completed
          ? { output: item.aggregatedOutput, exitCode: item.exitCode }
          : {}),
      },
      status: statusForItem(item.status),
    };
  }
  if (item.type === 'fileChange') {
    return {
      ts,
      kind: 'tool',
      toolName: 'codex.fileChange',
      toolInput: { changes: item.changes },
      status: statusForItem(item.status),
    };
  }
  if (item.type === 'mcpToolCall') {
    const server = typeof item.server === 'string' ? item.server : 'unknown';
    const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
    return {
      ts,
      kind: 'tool',
      toolName: `mcp.${server}.${tool}`,
      toolInput: item.arguments,
      status: statusForItem(item.status),
    };
  }
  return undefined;
}

function closeDescription(close: {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr: string;
}): string {
  const reason =
    close.error?.message ??
    `process exited (code ${String(close.code)}, signal ${String(close.signal)})`;
  return close.stderr === '' ? reason : `${reason}: ${close.stderr}`;
}

/** One Codex App Server process, one persisted thread, and one Codex turn. */
export class CodexExecutor implements Executor {
  constructor(private readonly spawnProcess?: SpawnCodexAppServer) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    if (opts.permissionMode !== 'auto') {
      throw new Error(
        `Codex currently supports Dispatch permission mode "auto" only; configured mode is "${opts.permissionMode}"`
      );
    }
    const server = new CodexAppServer(opts.cwd, this.spawnProcess);
    let threadId: string | undefined;
    let turnId: string | undefined;
    let terminal = false;
    let interrupted = false;
    let stopping = false;
    let protocolFailure: string | undefined;
    const queuedSteers: string[] = [];
    let turnStartPending = false;
    const bufferedTurnMessages: CodexAppServerMessage[] = [];
    const pendingApprovals = new Map<string, PendingCodexApproval>();
    let nextApprovalId = 1;

    server.onServerRequest((request) => {
      if (!isCodexApprovalMethod(request.method)) return false;
      if (terminal || interrupted) return true;
      const approval: PendingCodexApproval = {
        method: request.method,
        params: request.params,
        providerRequestId: request.id,
      };
      if (stopping) {
        server.respond(request.id, approvalResult(approval, { allow: false }));
        return true;
      }
      const requestId = `codex-approval-${nextApprovalId++}`;
      pendingApprovals.set(requestId, approval);
      events.onApprovalRequest({
        requestId,
        toolName: CODEX_APPROVAL_TOOL_NAMES[request.method],
        input: request.params,
      });
      return true;
    });

    const finish = (result: {
      state: 'finished' | 'failed';
      error?: string;
    }): void => {
      if (terminal || interrupted) return;
      terminal = true;
      pendingApprovals.clear();
      events.onFinish({ ...result, sessionId: threadId });
      server.close();
    };

    const sendSteer = (message: string): void => {
      if (terminal || interrupted) return;
      if (threadId === undefined || turnId === undefined) {
        queuedSteers.push(message);
        return;
      }
      try {
        void server
          .request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: textInput(message),
          })
          .catch((error: Error) =>
            finish({ state: 'failed', error: error.message })
          );
      } catch (error) {
        finish({ state: 'failed', error: (error as Error).message });
      }
    };

    const handleMessage = (message: CodexAppServerMessage): void => {
      if (terminal || interrupted) return;
      if (message.id !== undefined) {
        protocolFailure ??= `Unsupported Codex server request: ${message.method}`;
        events.onEntry({
          ts: new Date().toISOString(),
          kind: 'system',
          text: protocolFailure,
        });
        return;
      }
      if (message.method === 'warning') {
        const warning = objectValue(message.params)?.message;
        if (typeof warning === 'string') {
          events.onEntry({
            ts: new Date().toISOString(),
            kind: 'system',
            text: warning,
          });
        }
        return;
      }
      if (
        turnStartPending &&
        turnId === undefined &&
        (message.method === 'item/started' ||
          message.method === 'item/completed' ||
          message.method === 'turn/completed')
      ) {
        if (objectValue(message.params)?.threadId === threadId) {
          bufferedTurnMessages.push(message);
        }
        return;
      }
      if (
        message.method === 'item/started' ||
        message.method === 'item/completed'
      ) {
        const params = objectValue(message.params);
        if (params?.threadId !== threadId || params?.turnId !== turnId) return;
        const item = itemFrom(message);
        if (item === undefined) return;
        const completed = message.method === 'item/completed';
        const entry = entryForItem(item, completed);
        if (entry !== undefined) events.onEntry(entry);
        return;
      }
      if (message.method !== 'turn/completed') return;
      const params = objectValue(message.params);
      const turn = objectValue(params?.turn);
      if (
        params?.threadId !== threadId ||
        turn?.id !== turnId ||
        typeof turn?.status !== 'string'
      ) {
        return;
      }
      if (protocolFailure !== undefined) {
        finish({ state: 'failed', error: protocolFailure });
        return;
      }
      if (turn.status === 'completed') {
        finish({ state: 'finished' });
        return;
      }
      const turnError = objectValue(turn.error)?.message;
      finish({
        state: 'failed',
        error:
          typeof turnError === 'string'
            ? turnError
            : `Codex turn ended with status ${turn.status}`,
      });
    };
    server.onMessage(handleMessage);

    void server.closed.then((close) => {
      if (!terminal && !interrupted) {
        finish({
          state: 'failed',
          error: `Codex App Server ended before turn completion: ${closeDescription(close)}`,
        });
      }
    });

    const run = async (): Promise<void> => {
      try {
        await server.request('initialize', {
          clientInfo: {
            name: 'dispatch',
            title: 'Dispatch',
            version: CORE_VERSION,
          },
          capabilities: null,
        });
        if (interrupted) return;
        server.notify('initialized');

        const config = buildCodexDispatchMcpConfig(
          opts.cwd,
          opts.projectRoot ?? opts.cwd,
          opts.runId ?? ''
        );
        const resumed = opts.resumeSessionId !== undefined;
        const response = await server.request<CodexThreadResponse>(
          resumed ? 'thread/resume' : 'thread/start',
          resumed
            ? {
                threadId: opts.resumeSessionId,
                model: opts.model,
                cwd: opts.cwd,
                sandbox: 'workspace-write',
                approvalPolicy: 'on-request',
                approvalsReviewer: 'auto_review',
                config,
              }
            : {
                model: opts.model,
                cwd: opts.cwd,
                approvalPolicy: 'on-request',
                approvalsReviewer: 'auto_review',
                sandbox: 'workspace-write',
                config,
              }
        );
        if (interrupted) return;
        const returnedThreadId = response.thread?.id;
        if (typeof returnedThreadId !== 'string' || returnedThreadId === '') {
          throw new Error('Codex App Server returned no thread.id');
        }
        if (resumed && returnedThreadId !== opts.resumeSessionId) {
          throw new Error(
            `Codex resume returned thread ${returnedThreadId} instead of ${opts.resumeSessionId}`
          );
        }
        threadId = returnedThreadId;
        events.onSession?.(threadId);

        turnStartPending = true;
        const turn = await server.request<CodexTurnResponse>('turn/start', {
          threadId,
          input: textInput(opts.prompt),
        });
        if (interrupted || terminal) return;
        const returnedTurnId = turn.turn?.id;
        if (typeof returnedTurnId !== 'string' || returnedTurnId === '') {
          throw new Error('Codex App Server returned no turn.id');
        }
        turnId = returnedTurnId;
        turnStartPending = false;
        for (const message of bufferedTurnMessages.splice(0)) {
          handleMessage(message);
        }
        if (terminal) return;
        for (const message of queuedSteers.splice(0)) sendSteer(message);
      } catch (error) {
        if (!interrupted) {
          finish({ state: 'failed', error: (error as Error).message });
        }
      }
    };
    void run();

    return {
      async interrupt(): Promise<void> {
        if (terminal || interrupted) return;
        interrupted = true;
        pendingApprovals.clear();
        if (threadId !== undefined && turnId !== undefined) {
          try {
            await server.request('turn/interrupt', { threadId, turnId });
          } catch {
            // Process shutdown below is still the bounded MVP cancellation.
          }
        }
        server.close();
      },
      requestStop(): void {
        if (stopping) return;
        stopping = true;
        for (const approval of pendingApprovals.values()) {
          server.respond(
            approval.providerRequestId,
            approvalResult(approval, { allow: false })
          );
        }
        pendingApprovals.clear();
        sendSteer(STOP_MESSAGE);
      },
      send(message: string): void {
        sendSteer(message);
      },
      approve(requestId: string, decision: ApprovalDecision): void {
        const approval = pendingApprovals.get(requestId);
        if (approval === undefined || terminal || interrupted) return;
        pendingApprovals.delete(requestId);
        try {
          server.respond(
            approval.providerRequestId,
            approvalResult(approval, decision)
          );
        } catch (error) {
          finish({ state: 'failed', error: (error as Error).message });
        }
      },
    };
  }
}
