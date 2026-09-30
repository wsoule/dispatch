import type { EffortLevel } from '@dispatch/core';
import type { z } from 'zod';

import type { OverseerAction } from './overseerTools.js';
import type { ApprovalDecision } from './types.js';

/**
 * The seam between the overseer's conversation bookkeeping (OverseerManager)
 * and whatever actually talks to a model (ClaudeOverseer in production,
 * FakeOverseer in tests) — the tool-calling counterpart of planner.ts's
 * `Planner`.
 *
 * The split that matters: a backend never touches the tool registry and never
 * decides a permission. It is handed an `OverseerToolset` for the turn,
 * advertises those tools to the model, and routes every call back through
 * `toolset.call`; any *other* tool the session wants to run (the built-in
 * Read/Bash/Edit of a full Claude Code session) goes through
 * `OverseerTurnOptions.authorizeTool` and waits for its answer. OverseerManager
 * is what decides that a status call runs immediately, a mutating call only
 * ever queues an OverseerAction, and a built-in call runs only once a human
 * (or the project's permission policy) has allowed it — so a backend cannot
 * bypass human confirmation even by accident, and a test can drive the whole
 * flow through FakeOverseer.
 */

/** One tool a backend advertises to the model for a turn. */
export interface OverseerToolDescriptor {
  name: string;
  description: string;
  /**
   * The tool's zod input schema — always an object schema, and the same
   * instance the registry validates the call against. A backend uses it to
   * describe the tool's parameters to the model; the authoritative parse still
   * happens inside the registry, so a backend that advertises a looser shape
   * (or none) can't smuggle unvalidated input through.
   */
  inputSchema: z.ZodType<unknown>;
  /**
   * True for the mutating tools. Calling one NEVER performs its effect: it
   * queues an OverseerAction for a human to confirm. Exposed so a backend can
   * say so in the tool's description rather than the model having to infer it
   * from the result it gets back.
   */
  mutating: boolean;
}

/** The outcome of one tool call, as a backend hands it back to the model. */
export interface OverseerToolResult {
  /** JSON-serializable payload for the model to read. */
  content: unknown;
  /**
   * True when the call failed (unknown tool, input that failed its schema, a
   * target that doesn't exist). The turn continues — `content` carries a
   * one-line message the model is expected to read and self-correct from,
   * exactly like OverseerToolError's own contract.
   */
  isError: boolean;
  /** Set when the call queued a mutating action instead of doing anything. */
  action?: OverseerAction;
}

/** Everything a backend needs to run one tool-calling turn. */
export interface OverseerToolset {
  tools: readonly OverseerToolDescriptor[];
  /**
   * Runs one tool call. Resolves for tool-level failures rather than
   * rejecting (see OverseerToolResult.isError) — a mistyped argument should
   * cost the model one turn of self-correction, not fail the whole
   * conversation.
   */
  call(name: string, input: unknown): Promise<OverseerToolResult>;
}

/**
 * A built-in tool call the session wants to run — one the registry does not
 * own (Bash, Edit, Read, a project MCP server's tool) and that is therefore
 * subject to the project's permission policy rather than the queue-and-confirm
 * rule. `requestId` is the backend's handle for the call, unique per turn.
 */
export interface OverseerToolRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

/** Per-turn knobs the manager resolves from config and hands to a backend. */
export interface OverseerTurnOptions {
  /** The model id to run the turn on; the backend's own default when absent. */
  model?: string;
  /** Reasoning effort for the turn; the model's own default when absent. */
  effort?: EffortLevel;
  /**
   * The project's `orchestrator.permissionMode` — the same policy a dispatched
   * run gets, so the overseer is exactly as autonomous as the agents it
   * oversees. One of the Agent SDK's PermissionMode values.
   */
  permissionMode?: string;
  /** The project's turn cap and budget cap, when configured. */
  maxTurns?: number;
  maxBudgetUsd?: number;
  /**
   * Decides a built-in tool call. A backend MUST call this for every tool
   * that is not one of `toolset.tools`, and MUST NOT run the call until the
   * promise resolves with `allow: true`. The manager answers from the
   * permission policy where it can and otherwise parks the call for the
   * human. Absent (a backend constructed with no manager behind it), every
   * built-in call is refused.
   */
  authorizeTool?: (request: OverseerToolRequest) => Promise<ApprovalDecision>;
  /**
   * Reports a tool call the model made mid-turn, built-in tools included, so
   * the transcript can show what the reply was derived from. Registry tools
   * already record themselves through `toolset.call`, so a backend reports
   * only the calls that did not go through it.
   */
  onToolUse?: (toolName: string, input: unknown) => void;
}

/** One settled assistant turn: the text reply, and the handle to resume from. */
export interface OverseerTurn {
  reply: string;
  /**
   * The backend's opaque resume handle (the Agent SDK session id for
   * ClaudeOverseer), threaded into the next `sendMessage` so follow-ups keep
   * the prior turns — including the tool calls they made — in context.
   */
  sessionId?: string;
}

export interface OverseerBackend {
  start(
    prompt: string,
    toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn>;
  sendMessage(
    sessionId: string | undefined,
    message: string,
    toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn>;
}
