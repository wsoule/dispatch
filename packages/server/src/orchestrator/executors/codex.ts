import type { ExecutorPricing } from '@dispatch/core';
import { CORE_VERSION, loadConfig } from '@dispatch/core';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import {
  FLOOR_COMMAND_ACTIONS,
  floorCheckForCommand,
  floorCheckForToolInput,
} from '../../floor.js';
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
import type { RunUsage } from '../usage.js';

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

// Codex's cumulative thread totals in the provider-neutral billing split. Codex
// counts cached input inside inputTokens and reports no cache writes, so the
// uncached share is the difference and cache creation is always zero.
function codexRunUsage(total: CodexTokenTotal): RunUsage {
  const cached = Math.min(total.cachedInputTokens, total.inputTokens);
  return {
    inputTokens: total.inputTokens - cached,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
    outputTokens: total.outputTokens,
    source: 'result',
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
  approvalPolicy: 'untrusted' | 'never';
  // Pinned: a user's config.toml may default to Codex's own reviewer, which
  // answers inside Codex and never asks Dispatch.
  approvalsReviewer: 'user';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

// What each Dispatch mode means to Codex. `untrusted` is the one policy that
// asks before every non-read-only command, which the floor needs; `plan`'s
// read-only sandbox and `never` leave a floor command nothing it could reach.
export function codexPermission(
  permissionMode: string
): CodexPermission | null {
  switch (permissionMode) {
    case 'default':
    case 'acceptEdits':
      return {
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
      };
    case 'bypassPermissions':
      return {
        approvalPolicy: 'untrusted',
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

// Modes whose Codex settings keep approvals away from Dispatch, so the
// irreversibility floor (floor.ts) could not hold a command for a human.
const CODEX_FLOOR_REFUSALS = new Map([
  [
    'auto',
    "Codex's auto mode sends approvals to Codex's own reviewer instead of Dispatch",
  ],
  ['dontAsk', 'Codex never asks for approval under dontAsk'],
]);

// Codex reports token usage but no dollar cost, runs one turn per prompt,
// and has no equivalent of the SDK's turn/budget caps.
export const CODEX_EXECUTOR_PROFILE: ExecutorProfile = {
  reportsCost: false,
  reportsTurns: true,
  enforcesCaps: false,
  acceptsMessages: true,
  permissionRefusal: (mode) => {
    const floorGap = CODEX_FLOOR_REFUSALS.get(mode);
    if (floorGap !== undefined) {
      return `${floorGap}, so ${FLOOR_COMMAND_ACTIONS} could run without a human. Use default (Dispatch reviews each command) or bypassPermissions (unattended; Dispatch still holds those actions) for Codex runs`;
    }
    return codexPermission(mode) === null
      ? `Codex has no mapping for permissionMode "${mode}"`
      : null;
  },
};

// The answer the executor gives a Codex approval itself, or undefined to hand
// it to Dispatch's approval flow. A floor command is never answered here.
function selfAnswer(
  permissionMode: string,
  approval: PendingCodexApproval,
  cwd: string,
  editPaths: ReadonlyMap<string, string[]>
): ApprovalDecision | undefined {
  const params = objectValue(approval.params);
  if (approval.method === 'item/commandExecution/requestApproval') {
    // Accepting may lift a sandbox the model asked to leave, which looks
    // like any other ask, so only a mode with no sandbox answers here.
    const readable =
      typeof params?.command === 'string' &&
      (params.kind ?? 'command') === 'command';
    return permissionMode === 'bypassPermissions' &&
      readable &&
      floorCheckForToolInput(params) === null
      ? { allow: true }
      : undefined;
  }
  if (permissionMode === 'bypassPermissions') return { allow: true };
  if (
    permissionMode === 'acceptEdits' &&
    approval.method === 'item/fileChange/requestApproval' &&
    (params?.grantRoot === undefined || params.grantRoot === null) &&
    typeof params?.itemId === 'string'
  ) {
    // The ask names no paths; its item/started notification, which Codex
    // sends first, does.
    const paths = editPaths.get(params.itemId);
    return paths?.every((path) => isInside(cwd, path)) === true
      ? { allow: true }
      : undefined;
  }
  return undefined;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Every path a fileChange item writes, a move's destination included, or
// undefined when any entry is unreadable so a partial list never passes.
function fileChangePaths(item: CodexItem): string[] | undefined {
  if (!Array.isArray(item.changes) || item.changes.length === 0) {
    return undefined;
  }
  const paths: string[] = [];
  for (const change of item.changes) {
    const entry = objectValue(change);
    if (typeof entry?.path !== 'string') return undefined;
    paths.push(entry.path);
    const movePath = objectValue(entry.kind)?.move_path;
    if (typeof movePath === 'string') paths.push(movePath);
  }
  return paths;
}

// A floor command Codex ran without asking Dispatch, or undefined when it did
// not run or an ask for its item already carried a floor command.
function unaskedFloorCommand(
  item: CodexItem,
  flooredAsks: ReadonlySet<string>
): string | undefined {
  if (item.type !== 'commandExecution' || item.status !== 'completed') {
    return undefined;
  }
  if (typeof item.id !== 'string' || flooredAsks.has(`command:${item.id}`)) {
    return undefined;
  }
  const check = floorCheckForToolInput(item);
  if (check === null) return undefined;
  return `Codex ran a floor command (${check}) without asking Dispatch, most likely under an allow rule in $CODEX_HOME/rules: ${String(item.command)}. The run is stopped so a human can review it.`;
}

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
    const editPaths = new Map<string, string[]>();
    // `${kind}:${itemId}` of each ask carrying a floor command; a floor act
    // with none behind it never reached Dispatch.
    const flooredAsks = new Set<string>();
    // The unfinished last line typed into each running shell, by item.
    const stdinTails = new Map<string, string>();

    server.onServerRequest((request) => {
      if (!isCodexApprovalMethod(request.method)) return false;
      if (terminal || interrupted) return true;
      const asked = objectValue(request.params);
      if (
        typeof asked?.itemId === 'string' &&
        floorCheckForToolInput(asked) !== null
      ) {
        const kind = typeof asked.kind === 'string' ? asked.kind : 'command';
        flooredAsks.add(`${kind}:${asked.itemId}`);
      }
      const approval: PendingCodexApproval = {
        method: request.method,
        params: request.params,
        providerRequestId: request.id,
      };
      if (stopping) {
        server.respond(request.id, approvalResult(approval, { allow: false }));
        return true;
      }
      const answer = selfAnswer(
        opts.permissionMode,
        approval,
        opts.cwd,
        editPaths
      );
      if (answer !== undefined) {
        server.respond(request.id, approvalResult(approval, answer));
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
        ...(lastUsage === undefined ? {} : { usage: codexRunUsage(lastUsage) }),
      });
      server.close();
    };

    // The act already happened; failing the run puts it in front of a human
    // (a blocking run-stalled item) before the agent builds on it.
    const stopForFloorBypass = (text: string): void => {
      events.onEntry({ ts: new Date().toISOString(), kind: 'system', text });
      finish({ state: 'failed', error: text });
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
      // Recorded before the turn-start buffering below: an edit's approval
      // can arrive while its item/started is still buffered.
      if (message.method === 'item/started') {
        const item = itemFrom(message);
        const paths =
          item?.type === 'fileChange' ? fileChangePaths(item) : undefined;
        if (typeof item?.id === 'string' && paths !== undefined) {
          editPaths.set(item.id, paths);
        }
      }
      if (
        turnStartPending &&
        turnId === undefined &&
        (message.method === 'item/started' ||
          message.method === 'item/completed' ||
          message.method === 'item/commandExecution/terminalInteraction' ||
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
        const bypass = completed
          ? unaskedFloorCommand(item, flooredAsks)
          : undefined;
        if (bypass !== undefined) stopForFloorBypass(bypass);
        return;
      }
      // Codex asks before starting a shell but not about what is typed into
      // it, so each finished line is read against the floor here.
      if (message.method === 'item/commandExecution/terminalInteraction') {
        const params = objectValue(message.params);
        if (params?.threadId !== threadId || params?.turnId !== turnId) return;
        const itemId = params?.itemId;
        if (typeof itemId !== 'string' || typeof params?.stdin !== 'string') {
          return;
        }
        const lines = `${stdinTails.get(itemId) ?? ''}${params.stdin}`.split(
          /\r\n|\r|\n/
        );
        stdinTails.set(itemId, lines.pop() ?? '');
        if (flooredAsks.has(`writeStdin:${itemId}`)) return;
        for (const line of lines) {
          const check = floorCheckForCommand(line);
          if (check === null) continue;
          stopForFloorBypass(
            `Codex typed a floor command (${check}) into a shell it started, and Codex does not ask about shell input: ${line.trim()}. The run is stopped so a human can review it.`
          );
          return;
        }
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
