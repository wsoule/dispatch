import type { ExecutorPricing } from '@dispatch/core';
import { CORE_VERSION, loadConfig } from '@dispatch/core';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CodexAppServer,
  type CodexAppServerMessage,
  type CodexAppServerRequest,
  type SpawnCodexAppServer,
} from '../codexAppServer.js';
import type { StdioServerSpec } from '../dispatchMcp.js';
import { cartoMcpSpec, dispatchMcpSpec } from '../dispatchMcp.js';
import type {
  ApprovalDecision,
  Executor,
  ExecutorEvents,
  ExecutorProfile,
  ExecutorRun,
  ExecutorStartOptions,
  NormalizedEntry,
} from '../types.js';

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

// Codex's `mcp_servers` table entry for one provider-neutral spec.
function toCodexMcp(
  spec: StdioServerSpec,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    required: true,
    ...(spec.timeoutMs !== undefined
      ? { tool_timeout_sec: Math.ceil(spec.timeoutMs / 1000) }
      : {}),
    ...extra,
  };
}

// The MCP servers a person configured for their own interactive Codex in
// `$CODEX_HOME/config.toml` (default `~/.codex`). Codex starts every one of
// them for any thread, dispatched runs included, so they are read here to be
// switched off per run. Unreadable or absent config means none.
export function codexUserMcpServerNames(): string[] {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const path = join(home, 'config.toml');
  if (!existsSync(path)) return [];
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as {
      mcp_servers?: unknown;
    };
    const servers = objectValue(parsed.mcp_servers);
    return servers === undefined ? [] : Object.keys(servers);
  } catch {
    return [];
  }
}

interface CodexTokenTotal {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function tokenTotal(value: unknown): CodexTokenTotal | undefined {
  const total = objectValue(value);
  if (total === undefined) return undefined;
  const count = (key: string): number =>
    typeof total[key] === 'number' ? total[key] : 0;
  return {
    totalTokens: count('totalTokens'),
    inputTokens: count('inputTokens'),
    cachedInputTokens: count('cachedInputTokens'),
    outputTokens: count('outputTokens'),
  };
}

// Codex reports tokens, never dollars; the project's configured per-million
// rates turn them into a cost. Codex counts cached input inside inputTokens.
function codexCostUsd(
  total: CodexTokenTotal,
  pricing: ExecutorPricing
): number {
  const cached = Math.min(total.cachedInputTokens, total.inputTokens);
  const uncached = total.inputTokens - cached;
  const cachedRate = pricing.cachedInput ?? pricing.input;
  return (
    (uncached * pricing.input +
      cached * cachedRate +
      total.outputTokens * pricing.output) /
    1_000_000
  );
}

// The project's pricing for Codex, if configured; unreadable config means none.
function codexPricingFor(projectRoot: string): ExecutorPricing | undefined {
  try {
    return loadConfig(projectRoot).executors?.codex?.pricing;
  } catch {
    return undefined;
  }
}

/** The run-scoped MCP servers re-supplied on thread start and resume. */
function buildCodexMcpServers(
  cwd: string,
  projectRoot: string,
  runId: string,
  cartoSpec: (projectRoot: string) => StdioServerSpec | null,
  userServers: string[],
  runTokenFile?: string
): { config: Record<string, unknown>; disabled: string[] } {
  const carto = cartoSpec(projectRoot);
  const ours: Record<string, unknown> = {
    dispatch: toCodexMcp(
      dispatchMcpSpec(cwd, projectRoot, runId, runTokenFile),
      {
        tools: {
          task_comment: { approval_mode: 'approve' },
          record_evidence: { approval_mode: 'approve' },
          record_mutation: { approval_mode: 'approve' },
          ask_user: { approval_mode: 'approve' },
        },
      }
    ),
    ...(carto === null ? {} : { carto: toCodexMcp(carto) }),
  };
  // A person's own servers (a Stripe or PostHog connector, say) have no
  // place in an autonomous run: cost, latency and reach nobody asked for.
  // `enabled: false` merges into the user's table; a name Codex does not
  // know would fail thread/start, which is why the list comes from the file.
  const disabled = userServers.filter((name) => !(name in ours));
  const mcpServers: Record<string, unknown> = { ...ours };
  for (const name of disabled) mcpServers[name] = { enabled: false };
  return { config: { mcp_servers: mcpServers }, disabled };
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

export interface CodexPermission {
  approvalPolicy: 'on-request' | 'never';
  approvalsReviewer: 'auto_review' | 'user';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

// Dispatch's permission vocabulary is the Claude SDK's; this is what each
// mode means to Codex. `auto` lets Codex's own reviewer answer approvals,
// the two asking modes route them to Dispatch's approval flow, the two
// unattended modes never ask, and `plan` cannot write at all.
export function codexPermission(
  permissionMode: string
): CodexPermission | null {
  switch (permissionMode) {
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
      };
    case 'default':
    case 'acceptEdits':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
      };
    case 'dontAsk':
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
      };
    case 'bypassPermissions':
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
      };
    case 'plan':
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
      };
    default:
      return null;
  }
}

// Codex reports token usage but no dollar cost, runs one turn per prompt,
// and has no equivalent of the SDK's turn/budget caps.
export const CODEX_EXECUTOR_PROFILE: ExecutorProfile = {
  reportsCost: false,
  reportsTurns: true,
  enforcesCaps: false,
  acceptsMessages: true,
  permissionRefusal: (mode) =>
    codexPermission(mode) === null
      ? `Codex has no mapping for permissionMode "${mode}"`
      : null,
};

/** One Codex App Server process, one persisted thread, and one Codex turn. */
export interface CodexExecutorOptions {
  /** Carto discovery, injectable so tests never depend on a local carto. */
  cartoSpec?: (projectRoot: string) => StdioServerSpec | null;
  /** The user's own MCP server names, injectable so tests never read ~/.codex. */
  userMcpServers?: () => string[];
  /** Per-million token rates for the project, injectable for tests. */
  pricing?: (projectRoot: string) => ExecutorPricing | undefined;
}

export class CodexExecutor implements Executor {
  readonly profile = CODEX_EXECUTOR_PROFILE;
  private readonly cartoSpec: (projectRoot: string) => StdioServerSpec | null;
  private readonly userMcpServers: () => string[];
  private readonly pricing: (
    projectRoot: string
  ) => ExecutorPricing | undefined;

  constructor(
    private readonly spawnProcess?: SpawnCodexAppServer,
    options: CodexExecutorOptions = {}
  ) {
    this.cartoSpec = options.cartoSpec ?? cartoMcpSpec;
    this.userMcpServers = options.userMcpServers ?? codexUserMcpServerNames;
    this.pricing = options.pricing ?? codexPricingFor;
  }

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const permission = codexPermission(opts.permissionMode);
    if (permission === null) {
      throw new Error(
        CODEX_EXECUTOR_PROFILE.permissionRefusal(opts.permissionMode) ??
          `unsupported permissionMode ${opts.permissionMode}`
      );
    }
    const server = new CodexAppServer(opts.cwd, this.spawnProcess);
    const pricing = this.pricing(opts.projectRoot ?? opts.cwd);
    let lastUsage: CodexTokenTotal | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let terminal = false;
    let interrupted = false;
    let stopping = false;
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
      const costUsd =
        pricing !== undefined && lastUsage !== undefined
          ? codexCostUsd(lastUsage, pricing)
          : undefined;
      events.onFinish({
        ...result,
        sessionId: threadId,
        turns: 1,
        ...(costUsd === undefined ? {} : { costUsd }),
      });
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
      // A server request nothing claimed (a question tool, an elicitation,
      // an auth refresh) was already answered method-not-found by the
      // transport; Codex carries on and the turn's own status still decides.
      if (message.id !== undefined) {
        events.onEntry({
          ts: new Date().toISOString(),
          kind: 'system',
          text: `Codex asked for ${message.method}, which Dispatch does not support; declined`,
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
          message.method === 'thread/tokenUsage/updated' ||
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
      if (message.method === 'thread/tokenUsage/updated') {
        const params = objectValue(message.params);
        if (params?.threadId !== threadId || params?.turnId !== turnId) return;
        const total = tokenTotal(objectValue(params?.tokenUsage)?.total);
        if (total === undefined) return;
        lastUsage = total;
        const cost =
          pricing === undefined
            ? ''
            : ` ≈ $${codexCostUsd(total, pricing).toFixed(4)}`;
        events.onEntry({
          ts: new Date().toISOString(),
          kind: 'usage',
          text: `tokens: ${String(total.totalTokens)} total (${String(total.inputTokens)} in, ${String(total.outputTokens)} out)${cost}`,
        });
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
        const caps = [
          ...(opts.maxBudgetUsd !== undefined
            ? [`maxBudgetUsd ${String(opts.maxBudgetUsd)}`]
            : []),
          ...(opts.maxTurns !== undefined
            ? [`maxTurns ${String(opts.maxTurns)}`]
            : []),
        ];
        if (caps.length > 0) {
          events.onEntry({
            ts: new Date().toISOString(),
            kind: 'system',
            text: `${caps.join(' and ')} not enforced for Codex runs`,
          });
        }
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

        const { config, disabled } = buildCodexMcpServers(
          opts.cwd,
          opts.projectRoot ?? opts.cwd,
          opts.runId ?? '',
          this.cartoSpec,
          this.userMcpServers(),
          opts.runTokenFile
        );
        if (disabled.length > 0) {
          events.onEntry({
            ts: new Date().toISOString(),
            kind: 'system',
            text: `disabled ${String(disabled.length)} MCP server(s) from your Codex config for this run: ${disabled.join(', ')}`,
          });
        }
        const resumed = opts.resumeSessionId !== undefined;
        const response = await server.request<CodexThreadResponse>(
          resumed ? 'thread/resume' : 'thread/start',
          resumed
            ? {
                threadId: opts.resumeSessionId,
                model: opts.model,
                cwd: opts.cwd,
                ...permission,
                config,
              }
            : {
                model: opts.model,
                cwd: opts.cwd,
                ...permission,
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
      // Codex has no separate note channel, so a note is a steer; as with
      // send(), a rejected steer fails the run.
      notify(text: string): void {
        sendSteer(text);
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
