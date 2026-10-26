import type { ExecutorPricing } from '@dispatch-foo/core';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

import { floorCheckForToolInput } from '../../floor.js';
import type { SpawnCodexAppServer } from '../codexAppServer.js';
import { codexCommandFloor, readCodexCommand } from '../codexCommand.js';
import { claimCodexToolCall, codexDynamicTool } from '../codexDynamicTools.js';
import { codexEffort, codexMcpConfig, runCodexTurn } from '../codexTurn.js';
import type { CodexDynamicTool, CodexTurnControls } from '../codexTurn.js';
import { cartoMcpSpec } from '../dispatchMcp.js';
import type { StdioServerSpec } from '../dispatchMcp.js';
import {
  approvalResult,
  CODEX_APPROVAL_TOOL_NAMES,
  codexCostUsd,
  codexPermission,
  codexPricingFor,
  codexUserMcpServerNames,
  fileChangePaths,
  isCodexApprovalMethod,
  objectValue,
} from '../executors/codex.js';
import type {
  CodexItem,
  CodexPermission,
  PendingCodexApproval,
} from '../executors/codex.js';
import { toolDescriptionForModel } from '../overseerBackend.js';
import type {
  OverseerBackend,
  OverseerToolDescriptor,
  OverseerToolset,
  OverseerTurn,
  OverseerTurnOptions,
} from '../overseerBackend.js';
import { hintsAtHeldTarget, overseerHoldFor } from '../overseerHold.js';
import type { OverseerHold } from '../overseerHold.js';
import {
  EMPTY_REPLY_MESSAGE,
  overseerInstructions,
} from '../overseerPrompt.js';
import type { ApprovalDecision } from '../types.js';

// Codex runs known-safe reads (cat, ls) without an approval Dispatch could hold.
const INSTRUCTIONS = overseerInstructions('Codex', { ungatedReads: true });

// Sent with the thread config on start and resume: no sub-agents, whose own
// commands and tools would sit outside this Overseer's gate. The shell stays.
const OVERSEER_FEATURES = { multi_agent: false };

// Asks Dispatch about every non-read-only command; where a mode Codex can't honour lands.
const ASK_EVERY_COMMAND: CodexPermission = {
  approvalPolicy: 'untrusted',
  approvalsReviewer: 'user',
  sandbox: 'workspace-write',
};

/** The Codex settings an Overseer turn runs under: a human is on hand, so unmapped modes ask. */
export function overseerPermission(mode: string | undefined): CodexPermission {
  return codexPermission(mode ?? 'default') ?? ASK_EVERY_COMMAND;
}

// Declared on thread/start only: Codex fixes a thread's dynamic tools there and
// ignores any sent with thread/resume.
function dynamicTool(descriptor: OverseerToolDescriptor): CodexDynamicTool {
  return codexDynamicTool(
    descriptor.name,
    toolDescriptionForModel(descriptor),
    descriptor.inputSchema
  );
}

/** What an approval shows the human and what the floor and hold checks read. */
interface ApprovalView {
  input: Record<string, unknown>;
  /**
   * False unless the ask is fully readable and, for a command, simple (one
   * program, plain arguments); such an ask always reaches a human.
   */
  known: boolean;
  /** False for a command ask with no command text at all. */
  readable: boolean;
}

function approvalView(
  approval: PendingCodexApproval,
  editPaths: ReadonlyMap<string, string[]>
): ApprovalView {
  const params = objectValue(approval.params) ?? {};
  const reason =
    typeof params.reason === 'string' ? { reason: params.reason } : {};
  if (approval.method === 'item/commandExecution/requestApproval') {
    const command = readCodexCommand(params.command);
    return {
      input: {
        command: command?.text ?? params.command ?? null,
        cwd: params.cwd,
        ...reason,
      },
      known: command?.simple ?? false,
      readable: command !== undefined,
    };
  }
  if (approval.method === 'item/fileChange/requestApproval') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const paths = editPaths.get(itemId) ?? [];
    return {
      input: {
        paths,
        ...(typeof params.grantRoot === 'string'
          ? { grantRoot: params.grantRoot }
          : {}),
        ...reason,
      },
      known: paths.length > 0,
      readable: true,
    };
  }
  return {
    input: { permissions: params.permissions, ...reason },
    known: true,
    readable: true,
  };
}

// The Overseer hold an ask needs. An edit with no paths Codex announced is held
// as a `.dispatch` write, since nothing shows it is not one.
function holdFor(
  toolName: string,
  view: ApprovalView,
  rootDir: string
): OverseerHold | null {
  if (toolName === 'codex.commandExecution' && !view.readable) {
    return 'unreadable';
  }
  if (toolName !== 'codex.fileChange') {
    return overseerHoldFor(toolName, view.input, rootDir);
  }
  if (!view.known) return 'dispatch-files';
  const grantRoot = view.input.grantRoot;
  const paths = [
    ...(view.input.paths as string[]),
    ...(typeof grantRoot === 'string' ? [grantRoot] : []),
  ];
  return overseerHoldFor(toolName, { paths }, rootDir);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, resolve(root, path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Answers the Overseer gives without asking, only for a readable ask with no hold:
// bypass allows it, acceptEdits allows an edit inside the checkout; undefined means ask.
// Accepted: under bypass a simple command may run a script the agent wrote
// (`./x.sh`, `pnpm run x`), as Claude's Overseer may.
function selfDecision(
  mode: string | undefined,
  approval: PendingCodexApproval,
  view: ApprovalView,
  held: boolean,
  rootDir: string
): ApprovalDecision | undefined {
  if (held || !view.known) return undefined;
  // A command that hints at Dispatch or a loopback host asks even when no hold
  // fired, so a gap in a hold costs an ask, not a bypass.
  const command = view.input.command;
  const cwd = typeof view.input.cwd === 'string' ? view.input.cwd : undefined;
  if (typeof command === 'string' && hintsAtHeldTarget(command, rootDir, cwd)) {
    return undefined;
  }
  if (mode === 'bypassPermissions') return { allow: true };
  if (
    mode === 'acceptEdits' &&
    approval.method === 'item/fileChange/requestApproval' &&
    view.input.grantRoot === undefined
  ) {
    const paths = view.input.paths as string[];
    return paths.every((path) => isInside(rootDir, path))
      ? { allow: true }
      : undefined;
  }
  return undefined;
}

// A floor command Codex ran without asking Dispatch (an allow rule in $CODEX_HOME/rules).
function unaskedFloorCommand(
  item: CodexItem,
  flooredAsks: ReadonlySet<string>
): string | undefined {
  // Anything but a declined command ran, a failed one included.
  if (
    item.type !== 'commandExecution' ||
    item.status === 'declined' ||
    item.status === 'inProgress' ||
    typeof item.id !== 'string' ||
    flooredAsks.has(`command:${item.id}`)
  ) {
    return undefined;
  }
  const check = codexCommandFloor(item.command);
  if (check === null) return undefined;
  const command = readCodexCommand(item.command)?.text ?? '';
  return `Codex ran a floor command (${check}) without asking Dispatch, most likely under an allow rule in $CODEX_HOME/rules: ${command}. The Overseer turn is stopped so you can review it.`;
}

// One turn's approval bookkeeping: edit paths Codex announced, asks that
// carried a floor command, and the unfinished line typed into each shell.
class ApprovalGate {
  private readonly editPaths = new Map<string, string[]>();
  private readonly flooredAsks = new Set<string>();
  private readonly stdinTails = new Map<string, string>();

  constructor(
    private readonly rootDir: string,
    private readonly opts: OverseerTurnOptions
  ) {}

  async ask(
    approval: PendingCodexApproval,
    respond: (result: unknown) => void,
    controls: CodexTurnControls
  ): Promise<void> {
    let decision: ApprovalDecision;
    try {
      decision = await this.decide(approval);
    } catch (error) {
      decision = {
        allow: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    // Never acceptForSession: Dispatch's own grants decide the next ask.
    respond(approvalResult(approval, { allow: decision.allow }));
    const reason = decision.reason?.trim();
    if (!decision.allow && reason !== undefined && reason !== '') {
      controls.steer(`Dispatch did not run that: ${reason}`);
    }
  }

  private decide(approval: PendingCodexApproval): Promise<ApprovalDecision> {
    const toolName = CODEX_APPROVAL_TOOL_NAMES[approval.method];
    const view = approvalView(approval, this.editPaths);
    const floor = floorCheckForToolInput(view.input);
    const check = floor ?? holdFor(toolName, view, this.rootDir) ?? undefined;
    const params = objectValue(approval.params);
    if (floor !== null && typeof params?.itemId === 'string') {
      const kind = typeof params.kind === 'string' ? params.kind : 'command';
      this.flooredAsks.add(`${kind}:${params.itemId}`);
    }
    const self = selfDecision(
      this.opts.permissionMode,
      approval,
      view,
      check !== undefined,
      this.rootDir
    );
    if (self !== undefined) return Promise.resolve(self);
    if (this.opts.authorizeTool === undefined) {
      return Promise.resolve({
        allow: false,
        reason: 'no one is available to allow this in this session',
      });
    }
    // Unique across conversations: the manager keys every parked call by it.
    return this.opts.authorizeTool({
      requestId: `codex-approval-${randomUUID()}`,
      toolName,
      input: view.input,
      ...(check === undefined ? {} : { check }),
    });
  }

  watch(
    item: CodexItem,
    completed: boolean,
    controls: CodexTurnControls
  ): void {
    if (!completed) {
      this.started(item);
      return;
    }
    const bypass = unaskedFloorCommand(item, this.flooredAsks);
    if (bypass !== undefined) controls.fail(bypass);
  }

  // Codex asks before starting a shell but not about what is typed into it.
  typed(itemId: string, stdin: string, controls: CodexTurnControls): void {
    const lines = `${this.stdinTails.get(itemId) ?? ''}${stdin}`.split(
      /\r\n|\r|\n/
    );
    this.stdinTails.set(itemId, lines.pop() ?? '');
    if (this.flooredAsks.has(`writeStdin:${itemId}`)) return;
    for (const line of lines) {
      const check = floorCheckForToolInput({ command: line });
      if (check === null) continue;
      controls.fail(
        `Codex typed a floor command (${check}) into a shell it started, and Codex does not ask about shell input: ${line.trim()}. The Overseer turn is stopped so you can review it.`
      );
      return;
    }
  }

  // Keeps an edit's paths (its ask names none) and reports built-in calls.
  private started(item: CodexItem): void {
    if (item.type === 'fileChange') {
      const paths = fileChangePaths(item) ?? [];
      if (typeof item.id === 'string') this.editPaths.set(item.id, paths);
      this.opts.onToolUse?.('codex.fileChange', { paths });
      return;
    }
    if (item.type === 'commandExecution') {
      this.opts.onToolUse?.('codex.commandExecution', {
        command: readCodexCommand(item.command)?.text ?? item.command,
        cwd: item.cwd,
      });
      return;
    }
    if (item.type === 'mcpToolCall') {
      this.opts.onToolUse?.(
        `mcp.${String(item.server)}.${String(item.tool)}`,
        item.arguments
      );
    }
  }
}

// One turn's agentMessage items that may still be the reply, by item id,
// oldest first. A message followed by another item (a command, an edit, a
// tool call, another message) was prose between steps: narration, unless
// Codex marked it the final answer. At the turn's end every one but the reply
// item is narration. Keyed by item id, never by text.
class TurnNarration {
  private readonly pending: { id: string; text: string; final: boolean }[] = [];

  constructor(private readonly opts: OverseerTurnOptions) {}

  watch(item: CodexItem, completed: boolean): void {
    if (!completed) {
      // Thinking and the human's own line say nothing about what came before.
      if (item.type !== 'reasoning' && item.type !== 'userMessage') {
        this.commit();
      }
      return;
    }
    if (
      item.type === 'agentMessage' &&
      typeof item.id === 'string' &&
      typeof item.text === 'string'
    ) {
      this.pending.push({
        id: item.id,
        text: item.text,
        final: item.phase === 'final_answer',
      });
    }
  }

  // A step follows: every pending message but a final answer is narration.
  commit(): void {
    const answers = this.pending.filter((m) => m.final);
    for (const m of this.pending) if (!m.final) this.report(m);
    this.pending.splice(0, this.pending.length, ...answers);
  }

  // The turn is over and `replyItemId` is its reply: the rest is narration.
  settle(replyItemId: string | undefined): void {
    for (const m of this.pending.splice(0)) {
      if (m.id !== replyItemId) this.report(m);
    }
  }

  private report(m: { id: string; text: string }): void {
    if (m.text.trim() !== '') this.opts.onNarration?.(m.id, m.text);
  }
}

interface CodexOverseerOptions {
  spawnProcess?: SpawnCodexAppServer;
  cartoSpec?: (projectRoot: string) => StdioServerSpec | null;
  userMcpServers?: () => string[];
  pricing?: (projectRoot: string) => ExecutorPricing | undefined;
  env?: Record<string, string>;
  /** Ends a turn after Codex is silent this long (approvals pause it); runCodexTurn's default when absent. */
  timeoutMs?: number;
}

// The overseer as a Codex thread in the checkout: registry tools are dynamic
// tools through `toolset.call`; Codex's commands and edits go through authorizeTool.
export class CodexOverseer implements OverseerBackend {
  constructor(
    private readonly rootDir: string,
    private readonly options: CodexOverseerOptions = {}
  ) {}

  start(
    prompt: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    return this.runTurn(prompt, toolset, undefined, options);
  }

  sendMessage(
    sessionId: string | undefined,
    message: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    return this.runTurn(message, toolset, sessionId, options);
  }

  // Codex keeps a thread's dynamic tools across resume (and ignores a resend),
  // so they are declared on thread/start only.
  private async runTurn(
    prompt: string,
    toolset: OverseerToolset,
    resume: string | undefined,
    opts: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    const carto = (this.options.cartoSpec ?? cartoMcpSpec)(this.rootDir);
    const userServers = (
      this.options.userMcpServers ?? codexUserMcpServerNames
    )();
    const pricing = (this.options.pricing ?? codexPricingFor)(this.rootDir);
    const gate = new ApprovalGate(this.rootDir, opts);
    const narration = new TurnNarration(opts);
    const callTool = (name: string, args: unknown) => toolset.call(name, args);
    const result = await runCodexTurn({
      cwd: this.rootDir,
      prompt,
      resumeThreadId: resume,
      model: opts.model,
      effort: codexEffort(opts.effort),
      permission: overseerPermission(opts.permissionMode),
      config: {
        ...codexMcpConfig(carto === null ? {} : { carto }, userServers),
        features: OVERSEER_FEATURES,
      },
      developerInstructions: INSTRUCTIONS,
      dynamicTools: toolset.tools.map(dynamicTool),
      experimentalApi: true,
      signal: opts.abortController?.signal,
      spawnProcess: this.options.spawnProcess,
      env: this.options.env,
      timeoutMs: this.options.timeoutMs,
      // Idle, not wall-clock: a human answering a card or a long test run must not end the turn.
      idle: true,
      onServerRequest: (request, respond, controls) => {
        // A registry call's tool row lands now: the prose before it goes first.
        if (request.method === 'item/tool/call') narration.commit();
        if (claimCodexToolCall(callTool, request, respond)) return true;
        if (!isCodexApprovalMethod(request.method)) return false;
        void gate.ask(
          {
            method: request.method,
            params: request.params,
            providerRequestId: request.id,
          },
          respond,
          controls
        );
        return true;
      },
      onItem: (item, completed, controls) => {
        // Before the gate reports a built-in call, so narration leads its row.
        narration.watch(item, completed);
        gate.watch(item, completed, controls);
      },
      onTerminalInput: (itemId, stdin, controls) =>
        gate.typed(itemId, stdin, controls),
      // An agentMessage item is one segment; its id keys the live text.
      ...(opts.onTextDelta === undefined
        ? {}
        : { onAgentMessageDelta: opts.onTextDelta }),
    });
    narration.settle(result.replyItemId);
    const reply = result.reply.trim();
    return {
      reply: reply === '' ? EMPTY_REPLY_MESSAGE : reply,
      ...(result.replyItemId !== undefined && reply !== ''
        ? { streamId: result.replyItemId }
        : {}),
      sessionId: result.threadId,
      // Bill this turn only: the thread's totals include every earlier turn.
      ...(pricing !== undefined && result.turnUsage !== undefined
        ? { costUsd: codexCostUsd(result.turnUsage, pricing) }
        : {}),
      ...(result.contextTokens === undefined
        ? {}
        : { contextTokens: result.contextTokens }),
    };
  }
}
